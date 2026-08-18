#!/usr/bin/env node
/**
 * Publishes release artifacts and the manifest to Aliyun OSS.
 *
 * The contract mirrors yaklang/browser-binaries-mirror:
 *  - versioned artifacts are immutable: one-year immutable cache headers,
 *    sha256 user meta, x-oss-forbid-overwrite on upload; an existing object
 *    with a different sha256 is a hard error, an identical one is skipped
 *  - manifest.json is mutable: five-minute cache; it is published first and
 *    its checksum second, so consumers can always detect a torn publish by
 *    verifying the checksum file
 *
 * Credentials come from OSS_KEY_ID / OSS_KEY_SECRET (org-level secrets).
 *
 * Usage:
 *   OSS_KEY_ID=… OSS_KEY_SECRET=… node scripts/publish-oss.mjs release \
 *     --release-entry=dist/release-entry.json [--dist=dist]
 *       [--endpoint=https://oss-accelerate.aliyuncs.com] [--bucket=yaklang] [--prefix=chrome-extension]
 *   OSS_KEY_ID=… OSS_KEY_SECRET=… node scripts/publish-oss.mjs manifest \
 *     --manifest=dist/manifest.json --manifest-checksum=dist/manifest.json.sha256.txt [endpoint/bucket/prefix]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OSSModule from 'ali-oss';

const OSS = OSSModule.default ?? OSSModule;
const root = resolve(import.meta.dirname, '..');

const ARTIFACT_CACHE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=300, must-revalidate';

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

const [subcommand, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const endpoint = String(args.endpoint ?? 'https://oss-accelerate.aliyuncs.com');
const bucket = String(args.bucket ?? 'yaklang');
const prefix = String(args.prefix ?? 'chrome-extension').replace(/^\/+|\/+$/g, '');

const accessKeyId = process.env.OSS_KEY_ID;
const accessKeySecret = process.env.OSS_KEY_SECRET;
if (!accessKeyId || !accessKeySecret) {
  throw new Error('OSS_KEY_ID and OSS_KEY_SECRET must be set in the environment');
}
if (subcommand !== 'release' && subcommand !== 'manifest') {
  throw new Error(`unknown subcommand: ${subcommand ?? '(none)'} — expected "release" or "manifest"`);
}

const client = new OSS({ accessKeyId, accessKeySecret, bucket, endpoint, secure: true });

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function headObject(key) {
  try {
    const res = await client.head(key);
    return {
      size: Number(res.headers['content-length']),
      sha256: res.headers['x-oss-meta-sha256'] ?? null,
    };
  } catch (err) {
    if (err && (err.status === 404 || err.code === 'NoSuchKey')) return null;
    throw err;
  }
}

async function putObject(key, buffer, { mime, cacheControl, forbidOverwrite }) {
  const digest = sha256(buffer);
  await client.put(key, buffer, {
    mime,
    headers: {
      'Cache-Control': cacheControl,
      ...(forbidOverwrite ? { 'x-oss-forbid-overwrite': 'true' } : {}),
    },
    meta: { sha256: digest },
  });
  const head = await headObject(key);
  if (!head) throw new Error(`upload verification failed, object missing: oss://${bucket}/${key}`);
  if (head.size !== buffer.length || head.sha256 !== digest) {
    throw new Error(`upload verification failed: oss://${bucket}/${key} (size ${head.size}/${buffer.length}, sha256 ${head.sha256}/${digest})`);
  }
}

async function putImmutable(key, buffer, mime) {
  const digest = sha256(buffer);
  const existing = await headObject(key);
  if (existing) {
    if (existing.size === buffer.length && existing.sha256 === digest) {
      console.log(`skip (identical object already published): oss://${bucket}/${key}`);
      return;
    }
    throw new Error(
      `refusing to overwrite non-matching immutable object: oss://${bucket}/${key} ` +
        `(remote size=${existing.size} sha256=${existing.sha256 ?? 'unknown'}, local size=${buffer.length} sha256=${digest})`,
    );
  }
  await putObject(key, buffer, { mime, cacheControl: ARTIFACT_CACHE, forbidOverwrite: true });
  console.log(`uploaded: oss://${bucket}/${key} (${buffer.length} bytes)`);
}

async function putMutable(key, buffer, mime) {
  await putObject(key, buffer, { mime, cacheControl: MANIFEST_CACHE, forbidOverwrite: false });
  console.log(`published: oss://${bucket}/${key}`);
}

async function runRelease() {
  if (!args['release-entry']) throw new Error('release subcommand requires --release-entry');
  const entry = JSON.parse(await readFile(resolve(root, String(args['release-entry'])), 'utf8'));
  const versionDir = resolve(root, String(args.dist ?? 'dist'), entry.version);
  for (const artifact of entry.artifacts) {
    const zip = await readFile(resolve(versionDir, artifact.filename));
    const digest = sha256(zip);
    if (digest !== artifact.sha256) {
      throw new Error(`${artifact.filename}: on-disk sha256 ${digest} != release entry ${artifact.sha256}`);
    }
    await putImmutable(`${prefix}/${entry.version}/${artifact.filename}`, zip, 'application/zip');
    const checksum = await readFile(resolve(versionDir, `${artifact.filename}.sha256.txt`));
    await putImmutable(`${prefix}/${entry.version}/${artifact.filename}.sha256.txt`, checksum, 'text/plain; charset=utf-8');
  }
}

async function runManifest() {
  if (!args.manifest) throw new Error('manifest subcommand requires --manifest');
  if (!args['manifest-checksum']) throw new Error('manifest subcommand requires --manifest-checksum');
  const manifest = await readFile(resolve(root, String(args.manifest)));
  const checksum = await readFile(resolve(root, String(args['manifest-checksum'])), 'utf8');
  const expected = `${sha256(manifest)}  manifest.json\n`;
  if (checksum !== expected) {
    throw new Error('manifest checksum file does not match manifest.json content');
  }
  await putMutable(`${prefix}/manifest.json`, manifest, 'application/json; charset=utf-8');
  await putMutable(`${prefix}/manifest.json.sha256.txt`, Buffer.from(checksum, 'utf8'), 'text/plain; charset=utf-8');
}

if (subcommand === 'release') {
  await runRelease();
} else {
  await runManifest();
}
