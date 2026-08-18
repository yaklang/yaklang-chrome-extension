#!/usr/bin/env node
/**
 * Verifies a freshly published release from the public endpoint: artifact
 * bytes and checksum files, cache headers, manifest consistency, and zip
 * layout (manifest.json at the zip root with the expected version).
 *
 * Usage:
 *   node scripts/verify-public.mjs --public-base-url=https://aliyun-oss.yaklang.com/chrome-extension \
 *     --release-entry=dist/release-entry.json
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';
const root = resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    out[key] = eq === -1 ? true : arg.slice(eq + 1);
  }
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const args = parseArgs(process.argv.slice(2));
if (!args['public-base-url']) throw new Error('--public-base-url is required');
if (!args['release-entry']) throw new Error('--release-entry is required');
const baseUrl = String(args['public-base-url']).replace(/\/+$/, '');

// Cache-busting query parameter: the manifest may be served from a 5-minute
// CDN cache, and we must observe the state right after this publish.
const bust = `verify=${Date.now()}`;

async function fetchOk(url) {
  const res = await fetch(`${url}?${bust}`);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res;
}

const entry = JSON.parse(await readFile(resolve(root, String(args['release-entry'])), 'utf8'));

for (const artifact of entry.artifacts) {
  const res = await fetchOk(artifact.url);
  const contentType = res.headers.get('content-type') ?? '';
  const cacheControl = res.headers.get('cache-control') ?? '';
  assert(contentType.startsWith('application/'), `${artifact.filename}: unexpected content-type "${contentType}"`);
  assert(cacheControl.includes('max-age=31536000') && cacheControl.includes('immutable'),
    `${artifact.filename}: unexpected cache-control "${cacheControl}" for an immutable artifact`);
  const body = Buffer.from(await res.arrayBuffer());
  assert(body.length === artifact.size, `${artifact.filename}: content-length ${body.length} != expected ${artifact.size}`);
  assert(sha256(body) === artifact.sha256, `${artifact.filename}: sha256 mismatch`);

  const checksumRes = await fetchOk(artifact.checksum_url);
  assert((await checksumRes.text()) === `${artifact.sha256}  ${artifact.filename}\n`,
    `${artifact.filename}: checksum file content mismatch`);

  const zip = new AdmZip(body);
  const innerEntry = zip.getEntry('manifest.json');
  assert(innerEntry, `${artifact.filename}: manifest.json missing at zip root`);
  const innerManifest = JSON.parse(zip.readAsText(innerEntry));
  assert(innerManifest.version === entry.version,
    `${artifact.filename}: zip manifest version ${innerManifest.version} != ${entry.version}`);
  const backgroundEntry = zip.getEntry('background.js');
  assert(backgroundEntry && backgroundEntry.getData().length > 0,
    `${artifact.filename}: background.js missing or empty in zip`);

  console.log(`verified ${artifact.filename} (${artifact.size} bytes)`);
}

const manifestRes = await fetchOk(`${baseUrl}/manifest.json`);
const manifestBytes = Buffer.from(await manifestRes.arrayBuffer());
const manifestCache = manifestRes.headers.get('cache-control') ?? '';
// The CDN in front of aliyun-oss.yaklang.com rewrites JSON cache-control to
// max-age=60 (the browser mirror gets the same treatment), so assert the
// effective freshness window is short instead of matching our upload value.
const manifestMaxAge = Number(/max-age=(\d+)/.exec(manifestCache)?.[1] ?? 0);
assert(manifestMaxAge > 0 && manifestMaxAge <= 300,
  `manifest.json: unexpected cache-control "${manifestCache}"`);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert(manifest.latest === entry.version, `manifest.latest ${manifest.latest} != ${entry.version}`);
const versionEntry = manifest.versions.find((v) => v.version === entry.version);
assert(versionEntry, `manifest has no entry for version ${entry.version}`);
assert(versionEntry.artifacts.length === entry.artifacts.length,
  `manifest artifacts count ${versionEntry.artifacts.length} != ${entry.artifacts.length}`);
for (const artifact of entry.artifacts) {
  const remote = versionEntry.artifacts.find((a) => a.variant === artifact.variant);
  assert(remote, `manifest missing variant ${artifact.variant} for version ${entry.version}`);
  assert(remote.sha256 === artifact.sha256, `manifest sha256 mismatch for variant ${artifact.variant}`);
  assert(remote.url === artifact.url, `manifest url mismatch for variant ${artifact.variant}`);
}

const checksumRes = await fetchOk(`${baseUrl}/manifest.json.sha256.txt`);
assert((await checksumRes.text()) === `${sha256(manifestBytes)}  manifest.json\n`,
  'manifest.json.sha256.txt does not match the served manifest');

console.log(`manifest verified: latest=${manifest.latest}, ${manifest.versions.length} version(s) in history`);
