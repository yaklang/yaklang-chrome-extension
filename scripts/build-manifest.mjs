#!/usr/bin/env node
/**
 * Merges the freshly packaged release (dist/release-entry.json) into the
 * public manifest and writes manifest.json + manifest.json.sha256.txt.
 *
 * The manifest is the single entry point consumers read: `latest` plus a
 * bounded `versions[]` history. Artifact objects are immutable and their URLs
 * are never rewritten; only this manifest moves.
 *
 * Usage:
 *   node scripts/build-manifest.mjs --release-entry=dist/release-entry.json \
 *     [--existing-manifest=dist/existing-manifest.json] [--max-versions=10] \
 *     --output=dist/manifest.json --checksum-output=dist/manifest.json.sha256.txt
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

function artifactFingerprint(artifacts) {
  return artifacts.map((a) => `${a.variant}:${a.sha256}`).sort().join('|');
}

function toVersionEntry(entry) {
  return {
    version: entry.version,
    published_at: entry.built_at,
    commit: entry.commit ?? null,
    artifacts: entry.artifacts.map((a) => ({
      variant: a.variant,
      browser: a.browser,
      mode: a.mode,
      filename: a.filename,
      url: a.url,
      sha256: a.sha256,
      size: a.size,
      checksum_url: a.checksum_url,
    })),
  };
}

function validate(manifest) {
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) {
    throw new Error('manifest must contain at least one version');
  }
  if (manifest.latest !== manifest.versions[0].version) {
    throw new Error(`manifest.latest (${manifest.latest}) must equal versions[0].version (${manifest.versions[0].version})`);
  }
  const seen = new Set();
  for (const versionEntry of manifest.versions) {
    if (seen.has(versionEntry.version)) throw new Error(`duplicate version in manifest: ${versionEntry.version}`);
    seen.add(versionEntry.version);
    if (!Array.isArray(versionEntry.artifacts) || versionEntry.artifacts.length === 0) {
      throw new Error(`version ${versionEntry.version} has no artifacts`);
    }
    const variants = new Set();
    for (const artifact of versionEntry.artifacts) {
      if (variants.has(artifact.variant)) throw new Error(`duplicate variant ${artifact.variant} in version ${versionEntry.version}`);
      variants.add(artifact.variant);
      if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error(`artifact ${artifact.filename}: bad sha256`);
      if (!Number.isInteger(artifact.size) || artifact.size <= 0) throw new Error(`artifact ${artifact.filename}: bad size`);
      if (!/^https?:\/\//.test(artifact.url)) throw new Error(`artifact ${artifact.filename}: url must be absolute`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args['release-entry']) throw new Error('--release-entry is required');
if (!args.output) throw new Error('--output is required');
if (!args['checksum-output']) throw new Error('--checksum-output is required');

const entry = JSON.parse(await readFile(resolve(root, String(args['release-entry'])), 'utf8'));
const maxVersions = Number.parseInt(String(args['max-versions'] ?? '10'), 10);
if (!Number.isInteger(maxVersions) || maxVersions < 1) throw new Error('--max-versions must be a positive integer');

let versions = [];
if (args['existing-manifest']) {
  try {
    const existing = JSON.parse(await readFile(resolve(root, String(args['existing-manifest'])), 'utf8'));
    versions = Array.isArray(existing.versions) ? existing.versions : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    console.log('existing manifest not found; starting a fresh history');
  }
}

const newEntry = toVersionEntry(entry);
const idx = versions.findIndex((v) => v.version === entry.version);
if (idx >= 0 && artifactFingerprint(versions[idx].artifacts) === artifactFingerprint(entry.artifacts)) {
  // Idempotent rerun: keep the original entry (published_at stays stable).
  console.log(`version ${entry.version} already in manifest with identical artifacts; kept as-is`);
} else {
  if (idx >= 0) {
    versions.splice(idx, 1);
    console.log(`version ${entry.version} re-published with different artifacts; replaced entry`);
  }
  versions.unshift(newEntry);
}
versions = versions.slice(0, maxVersions);

const manifest = { latest: versions[0].version, updated_at: new Date().toISOString(), versions };
validate(manifest);

const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(resolve(root, String(args.output)), bytes);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(resolve(root, String(args['checksum-output'])), `${sha256}  manifest.json\n`);
console.log(`manifest written: ${args.output} (latest=${manifest.latest}, ${versions.length} version(s) retained)`);
