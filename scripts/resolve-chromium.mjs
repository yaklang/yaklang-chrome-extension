import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function executable(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumPath() {
  for (const candidate of [process.env.CHROMIUM_PATH, process.env.CHROME_PATH]) {
    if (await executable(candidate)) return candidate;
  }

  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  let entries = [];
  try {
    entries = (await readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      .map((entry) => entry.name)
      .sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));
  } catch {
    // The final error below lists the supported configuration options.
  }
  for (const entry of entries) {
    for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cacheRoot, entry, relative);
      if (await executable(candidate)) return candidate;
    }
  }

  for (const command of ['google-chrome-for-testing', 'chromium', 'chromium-browser']) {
    const resolved = spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim();
    if (await executable(resolved)) return resolved;
  }
  throw new Error('Unpacked-capable Chromium not found. Set CHROMIUM_PATH or install Chromium/Playwright Chromium.');
}
