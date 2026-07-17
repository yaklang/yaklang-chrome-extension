import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(root, '.output/chrome-mv3-dev');
const manifest = resolve(output, 'manifest.json');
const profile = resolve(root, '.wxt/chrome-wsl-profile');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

await access(chrome, constants.X_OK).catch(() => {
  throw new Error(`Chrome is not executable: ${chrome}. Set CHROME_PATH to override it.`);
});
await mkdir(profile, { recursive: true });
const resolvedChrome = await realpath(chrome);
const isBrandedChrome = resolvedChrome.startsWith('/opt/google/chrome/');

const wxt = spawn(process.execPath, [resolve(root, 'node_modules/wxt/bin/wxt.mjs')], {
  cwd: root,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const pipeLines = (stream, destination) => {
  const reader = createInterface({ input: stream });
  reader.on('line', (line) => {
    if (!line.includes('Cannot open browser when using WSL')) destination.write(`${line}\n`);
  });
};
pipeLines(wxt.stdout, process.stdout);
pipeLines(wxt.stderr, process.stderr);

const waitForManifest = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (wxt.exitCode !== null) throw new Error(`WXT exited before producing ${manifest}`);
    try {
      await access(manifest, constants.R_OK);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Timed out waiting for ${manifest}`);
};

let chromeProcess;
const shutdown = async (signal) => {
  if (chromeProcess?.exitCode === null) chromeProcess.kill(signal);
  if (wxt.exitCode === null) wxt.kill(signal);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await waitForManifest();
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (!isBrandedChrome || process.env.WXT_AUTO_LOAD_EXTENSION === '1') {
    chromeArgs.push(`--disable-extensions-except=${output}`, `--load-extension=${output}`, 'about:blank');
  } else {
    chromeArgs.push('chrome://extensions');
  }
  chromeProcess = spawn(chrome, chromeArgs, { cwd: root, env: process.env, stdio: 'inherit' });
  if (isBrandedChrome && process.env.WXT_AUTO_LOAD_EXTENSION !== '1') {
    process.stdout.write(`\nOpened official Chrome with the persistent WXT profile.\nChrome 137+ ignores --load-extension in branded builds. On first run, enable Developer mode and load:\n${output}\nProfile: ${profile}\n`);
  } else {
    process.stdout.write(`\nOpened ${chrome} with the WXT development extension.\nProfile: ${profile}\n`);
  }
} catch (error) {
  await shutdown('SIGTERM');
  throw error;
}

await new Promise((resolveExit) => wxt.once('exit', resolveExit));
if (chromeProcess?.exitCode === null) chromeProcess.kill('SIGTERM');
