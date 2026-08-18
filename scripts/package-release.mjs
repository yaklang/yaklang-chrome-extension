#!/usr/bin/env node
/**
 * Packages the release variants from .output into dist/<version>/ and writes
 * dist/release-entry.json recording filename/size/sha256/url for every
 * artifact, plus per-artifact .sha256.txt checksum files.
 *
 * The variant table must stay in sync with `verify:production` (package.json)
 * and scripts/audit-build.mjs — those define the published surface.
 *
 * Usage:
 *   node scripts/package-release.mjs --public-base-url=https://aliyun-oss.yaklang.com/chrome-extension [--dist=dist]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

const VARIANTS = [
  { variant: 'chrome-store', browser: 'chrome', mode: 'store', dir: '.output/chrome-mv3-store' },
  { variant: 'chrome-enterprise', browser: 'chrome', mode: 'enterprise', dir: '.output/chrome-mv3-enterprise' },
  { variant: 'firefox', browser: 'firefox', mode: 'production', dir: '.output/firefox-mv2' },
  { variant: 'firefox-amo', browser: 'firefox', mode: 'store', dir: '.output/firefox-mv3-store' },
];

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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const args = parseArgs(process.argv.slice(2));
if (!args['public-base-url']) {
  throw new Error('--public-base-url is required (e.g. https://aliyun-oss.yaklang.com/chrome-extension)');
}
const baseUrl = String(args['public-base-url']).replace(/\/+$/, '');
const distDir = resolve(root, String(args.dist ?? 'dist'));

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const { version } = pkg;

let commit = null;
try {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  commit = stdout.trim();
} catch {
  // Not fatal: local runs outside a git worktree still package fine.
}
// Reproducibility must hold per VERSION, not per commit: a workflow that fails
// late (e.g. at the summary step) gets fixed on a follow-up commit and re-run
// for the same version, and the immutable no-overwrite guard then needs the
// rebuilt zip to match byte-for-byte. So pin entry timestamps to a fixed
// epoch (SOURCE_DATE_EPOCH convention) instead of anything commit-derived.
const FIXED_EPOCH = Date.UTC(2025, 0, 1);
const pinned = new Date(Math.floor((Number(process.env.SOURCE_DATE_EPOCH) || FIXED_EPOCH) / 2000) * 2000); // DOS time has 2s granularity

// readdir order is not stable across machines, and adm-zip preserves it.
// Walk sorted so every runner emits entries in the same order.
function collectSorted(dir, base = '') {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...collectSorted(join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

const versionDir = resolve(distDir, version);
await mkdir(versionDir, { recursive: true });

const artifacts = [];
for (const target of VARIANTS) {
  const outputDir = resolve(root, target.dir);
  if (!(await exists(resolve(outputDir, 'manifest.json')))) {
    throw new Error(`${target.variant}: ${target.dir}/manifest.json missing — run the build first (pnpm verify:production)`);
  }
  const builtManifest = JSON.parse(await readFile(resolve(outputDir, 'manifest.json'), 'utf8'));
  if (builtManifest.version !== version) {
    throw new Error(`${target.variant}: built manifest version ${builtManifest.version} != package.json version ${version}`);
  }

  const filename = `${target.variant}-${version}.zip`;
  const zipPath = resolve(versionDir, filename);
  // Entry paths are relative to the output dir so manifest.json sits at the
  // zip root, which is what browsers expect from a sideloaded extension.
  const zip = new AdmZip();
  for (const rel of collectSorted(outputDir)) {
    const slash = rel.lastIndexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    zip.addLocalFile(join(outputDir, rel), dir, rel.slice(slash + 1));
  }
  for (const entry of zip.getEntries()) entry.header.time = pinned;
  await zip.writeZipPromise(zipPath);
  const sha256 = await sha256File(zipPath);
  const size = (await stat(zipPath)).size;
  await writeFile(resolve(versionDir, `${filename}.sha256.txt`), `${sha256}  ${filename}\n`);

  artifacts.push({
    variant: target.variant,
    browser: target.browser,
    mode: target.mode,
    filename,
    url: `${baseUrl}/${version}/${filename}`,
    sha256,
    size,
    checksum_url: `${baseUrl}/${version}/${filename}.sha256.txt`,
  });
  console.log(`packaged ${filename} (${size} bytes, sha256 ${sha256.slice(0, 12)}…)`);
}

const entry = { version, commit, built_at: new Date().toISOString(), artifacts };
await writeFile(resolve(distDir, 'release-entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
console.log(`release entry written: ${resolve(distDir, 'release-entry.json').slice(root.length + 1)} (version ${version})`);
