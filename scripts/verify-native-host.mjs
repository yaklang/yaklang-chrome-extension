import { spawnSync } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { resolveChromiumPath } from './resolve-chromium.mjs';

const root = resolve(import.meta.dirname, '..');
const yakRoot = resolve(process.env.YAK_REPO || root, process.env.YAK_REPO ? '.' : '../../go/yaklang');
const extensionPath = resolve(root, process.env.EXTENSION_PATH || '.output/chrome-mv3-store');
const executablePath = await resolveChromiumPath();
const temporary = await mkdtemp(join(tmpdir(), 'yakit-native-host-e2e-'));
const home = join(temporary, 'home');
const profile = join(temporary, 'profile');
const hostBinary = join(temporary, 'yakit-browser-agent-host');
const testExtensionPath = join(temporary, 'extension');
const hostName = 'com.yaklang.browser_agent';

const packagedManifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
if (!packagedManifest.optional_permissions?.includes('nativeMessaging') || packagedManifest.permissions?.includes('nativeMessaging')) {
  throw new Error('Native Messaging is not packaged as an optional permission');
}
// Chrome's optional-permission prompt is browser chrome and cannot be accepted by
// Playwright. Pre-grant it only in a disposable copy so the native transport itself
// can still be exercised through the real extension and browser APIs.
await cp(extensionPath, testExtensionPath, { recursive: true });
const testManifest = structuredClone(packagedManifest);
testManifest.permissions = [...new Set([...(testManifest.permissions || []), 'nativeMessaging'])];
testManifest.optional_permissions = (testManifest.optional_permissions || []).filter((value) => value !== 'nativeMessaging');
await writeFile(join(testExtensionPath, 'manifest.json'), JSON.stringify(testManifest, null, 2));

const build = spawnSync('go', ['build', '-o', hostBinary, './common/browser/nativehostcmd'], {
  cwd: yakRoot, encoding: 'utf8', env: process.env,
});
if (build.status !== 0) throw new Error(`Native Host build failed:\n${build.stderr || build.stdout}`);

const bridgeHTTPServer = createServer();
const pairingServer = new WebSocketServer({ noServer: true });
const bridgeServer = new WebSocketServer({ noServer: true });
bridgeHTTPServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const target = pathname === '/pairing' ? pairingServer : pathname === '/extension' ? bridgeServer : undefined;
  if (!target) return socket.destroy();
  target.handleUpgrade(request, socket, head, (webSocket) => target.emit('connection', webSocket, request));
});
await new Promise((resolveListen) => bridgeHTTPServer.listen(0, '127.0.0.1', resolveListen));
const address = bridgeHTTPServer.address();
const endpoint = `ws://127.0.0.1:${address.port}/extension`;
const protocolVersion = 3;
const engineIdentityId = 'native-e2e-engine-identity';
const engineInstanceId = 'native-e2e-engine-instance';
const engineKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rawEngineJWK = await webcrypto.subtle.exportKey('jwk', engineKeys.publicKey);
const enginePublicKey = { kty: 'EC', crv: 'P-256', x: rawEngineJWK.x, y: rawEngineJWK.y };
let pairedClient;
let authenticatedConnections = 0;
let resolveHello;
const helloReceived = new Promise((resolveMessage) => { resolveHello = resolveMessage; });

const toBase64URL = (value) => Buffer.from(value).toString('base64url');
const engineChallengePayload = (challenge, timestamp) => ['yak-browser-bridge-v3', 'engine-challenge', engineIdentityId, engineInstanceId, challenge, String(timestamp)].join('\n');
const clientAuthPayload = (origin, challenge, auth) => [
  'yak-browser-bridge-v3', 'client-auth', origin, engineIdentityId, engineInstanceId, challenge,
  auth.installationId || '', auth.client || '', auth.version || '', [...(auth.capabilities || [])].sort().join(','),
  auth.taskId || '', auth.grantId || '', auth.resumeSessionId || '',
].join('\n');

pairingServer.on('connection', (socket, request) => socket.once('message', async (raw) => {
  const pairing = JSON.parse(raw.toString());
  if (pairing.type !== 'pair_request' || pairing.protocolVersion !== protocolVersion) return socket.close(1008, 'invalid pairing request');
  const requestId = 'native-e2e-pairing';
  const serverNonce = toBase64URL(randomBytes(32));
  const transcript = [
    'yak-browser-pairing-v1', engineIdentityId, requestId, request.headers.origin, pairing.installationId,
    pairing.nonce, serverNonce, pairing.publicKey.kty, pairing.publicKey.crv, pairing.publicKey.x, pairing.publicKey.y,
  ].join('\n');
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(transcript)));
  const code = String(digest.readBigUInt64BE() % 1_000_000n).padStart(6, '0');
  pairedClient = { installationId: pairing.installationId, publicKey: pairing.publicKey };
  socket.send(JSON.stringify({
    type: 'pair_pending', protocolVersion, requestId, serverNonce, engineIdentityId, code,
    expiresAt: Date.now() + 60_000, publicKey: enginePublicKey,
  }));
  setTimeout(() => socket.send(JSON.stringify({
    type: 'pair_approved', requestId, deviceId: 'native-e2e-device', engineIdentityId, publicKey: enginePublicKey,
  })), 50);
}));

bridgeServer.on('connection', async (socket, request) => {
  const challenge = toBase64URL(randomBytes(32));
  const timestamp = Date.now();
  socket.send(JSON.stringify({
    type: 'challenge', protocolVersion, challenge, timestamp, engineIdentityId, engineInstanceId, publicKey: enginePublicKey,
    signature: toBase64URL(await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, engineKeys.privateKey, Buffer.from(engineChallengePayload(challenge, timestamp)),
    )),
  }));
  socket.once('message', (raw) => void (async () => {
    const hello = JSON.parse(raw.toString());
    if (!request.headers.origin?.startsWith('chrome-extension://') || hello.type !== 'auth' || hello.protocolVersion !== protocolVersion || !hello.installationId || hello.challenge !== challenge || !pairedClient) {
      socket.close(1008, 'invalid native e2e handshake');
      return;
    }
    const clientKey = await webcrypto.subtle.importKey('jwk', pairedClient.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, clientKey, Buffer.from(hello.signature, 'base64url'),
      Buffer.from(clientAuthPayload(request.headers.origin, challenge, hello)),
    );
    if (!verified || pairedClient.installationId !== hello.installationId) return socket.close(1008, 'invalid native e2e signature');
    socket.send(JSON.stringify({
      type: 'hello_ack', protocolVersion, version: 'native-e2e-engine', capabilities: [],
      sessionId: 'native-e2e-session', engineIdentityId, engineInstanceId,
      connectionId: 'native-e2e-connection', resumed: false,
    }));
    socket.on('message', (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.type === 'ping') socket.send(JSON.stringify({
        type: 'pong', id: message.id, sequence: message.sequence, timestamp: message.timestamp, replyTimestamp: Date.now(),
      }));
    });
    authenticatedConnections += 1;
    if (authenticatedConnections >= 2) resolveHello({ hello, origin: request.headers.origin });
  })());
});

await mkdir(join(home, '.config', 'yakit'), { recursive: true });
await writeFile(join(home, '.config', 'yakit', 'browser-agent-native-host.json'), JSON.stringify({ endpoint }));

let context;
try {
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    env: { ...process.env, HOME: home },
    args: [`--disable-extensions-except=${testExtensionPath}`, `--load-extension=${testExtensionPath}`, '--no-first-run'],
  });
  context = await launch();
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const manifest = {
    name: hostName,
    description: 'Yakit Browser Agent Native Host E2E',
    path: hostBinary,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const manifestDirectories = [
    ...['google-chrome', 'google-chrome-for-testing', 'chromium'].map((product) => join(home, '.config', product, 'NativeMessagingHosts')),
    join(profile, 'NativeMessagingHosts'),
  ];
  for (const directory of manifestDirectories) {
    const path = join(directory, `${hostName}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(manifest));
  }

  // Chromium caches native-host registrations at process startup.
  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const restartedExtensionId = new URL(worker.url()).host;
  if (restartedExtensionId !== extensionId) throw new Error('Extension ID changed after Native Host registration');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#engine`);
  try {
    await options.evaluate(async ({ bridgeEndpoint }) => {
      const send = async (action, payload) => {
        const response = await chrome.runtime.sendMessage({ action, payload });
        if (!response?.ok) throw new Error(response?.error || action);
        return response.data;
      };
      const state = await send('state.get');
      await send('bridge.config.save', {
        transport: 'websocket', nativeHost: 'com.yaklang.browser_agent', endpoint: bridgeEndpoint,
        autoConnect: false, installationId: state.bridge.installationId,
      });
      await send('bridge.pair');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const [next, status] = await Promise.all([send('state.get'), send('bridge.status')]);
        if (next.bridge.pairedEngine && status.state === 'connected') {
          await send('bridge.disconnect');
          await send('bridge.config.save', { ...next.bridge, transport: 'native', autoConnect: false });
          await send('bridge.connect');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Browser extension pairing did not complete');
    }, { bridgeEndpoint: endpoint });
  } catch (error) {
    const diagnostics = await options.evaluate(async () => ({
      body: document.body.innerText,
      permissions: await chrome.permissions.getAll(),
      bridge: await chrome.runtime.sendMessage({ action: 'bridge.status' }),
    }));
    throw new Error(`Native Host pairing and settings failed: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  let connection;
  try {
    connection = await Promise.race([
      helloReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Native Host did not reach Yak Bridge')), 15_000)),
    ]);
  } catch (error) {
    const diagnostics = await options.evaluate(async () => ({
      body: document.body.innerText,
      permissions: await chrome.permissions.getAll(),
      bridge: await chrome.runtime.sendMessage({ action: 'bridge.status' }),
    }));
    throw new Error(`Native Host transport failed: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const status = await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'bridge.status' });
    if (!response?.ok) throw new Error(response?.error || 'bridge.status');
    return response.data;
  });
  if (status.state !== 'connected' || status.engineInstanceId !== 'native-e2e-engine-instance' || status.connectionId !== 'native-e2e-connection') {
    throw new Error(`Native Host identity did not reach the extension: ${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify({
    extensionId,
    endpoint,
    permissionFixture: 'pre-granted only in temporary E2E copy; production package remains optional',
    connection,
    status,
  }, null, 2));
} finally {
  await context?.close();
  for (const client of bridgeServer.clients) client.terminate();
  for (const client of pairingServer.clients) client.terminate();
  bridgeServer.close();
  pairingServer.close();
  bridgeHTTPServer.close();
  await rm(temporary, { recursive: true, force: true });
}
