import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { resolveChromiumPath } from './resolve-chromium.mjs';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(root, process.env.EXTENSION_PATH || '.output/chrome-mv3');
const extensionManifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'));
const shouldEnableUserScripts = process.env.ENABLE_USER_SCRIPTS !== '0' && extensionManifest.permissions?.includes('userScripts');
const artifacts = resolve(root, '.artifacts/ui');
const executablePath = await resolveChromiumPath();
const userDataDir = await mkdtemp(join(tmpdir(), 'yakit-extension-'));
await mkdir(artifacts, { recursive: true });

const server = createServer((request, response) => {
  if (request.url?.startsWith('/api/session')) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('x-yakit-e2e-response', 'captured');
      response.end(JSON.stringify({ ok: true, receivedBytes: Buffer.concat(chunks).length }));
    });
    return;
  }
  if (request.url?.startsWith('/frame-')) {
    const cross = request.url.startsWith('/frame-cross');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>${cross ? 'Cross Origin Account Frame' : 'Same Origin Billing Frame'}</title></head><body><main><h2>${cross ? 'Cross account' : 'Billing'}</h2><button id="frame-action">Frame action</button><input name="frame-field" aria-label="Frame field"></main></body></html>`);
    return;
  }
  if (request.url?.startsWith('/strict-csp')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'none'; style-src 'none'; frame-src 'none'");
    response.end('<!doctype html><html><head><title>Strict CSP Page</title></head><body><main><h1>Strict CSP Page</h1></main></body></html>');
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('set-cookie', 'yakit_e2e_session=authenticated; Path=/; HttpOnly; SameSite=Lax');
  const port = server.address()?.port;
  response.end(`<!doctype html>
    <html><head><title>Authenticated Security Console</title><style>
      body { margin: 0; font-family: system-ui; color: #1f252a; background: #eef1f3; }
      main { width: min(920px, calc(100% - 48px)); margin: 48px auto; padding: 32px; background: white; border: 1px solid #dce1e4; }
      h1 { margin: 0 0 12px; font-size: 28px; } p { color: #667078; }
      form { display: grid; gap: 10px; width: 340px; margin-top: 28px; } input, button { height: 38px; }
    </style></head><body><main><h1>Authenticated Security Console</h1><p>Local page for extension UI and main-world execution verification.</p><form><input name="account" value="analyst"><input name="token" value="redacted"><button type="button">Run check</button></form></main><script>
      window.app = { crypto: { encrypt(value) { return 'page:' + value; } } };
    </script><iframe title="Billing frame" src="/frame-same"></iframe><iframe title="Account frame" src="http://localhost:${port}/frame-cross"></iframe></body></html>`);
});
const pageSocketServer = new WebSocketServer({ server, path: '/page-socket' });
pageSocketServer.on('connection', (socket) => socket.on('message', (message) => socket.send(`echo:${message.toString()}`)));
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/authenticated`;
const insecureTestUrl = `http://yakit-insecure.test:${address.port}/insecure`;
const bridgeHTTPServer = createServer();
const pairingServer = new WebSocketServer({ noServer: true });
const bridgeServer = new WebSocketServer({ noServer: true });
bridgeHTTPServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const target = pathname === '/pairing' ? pairingServer : pathname === '/extension' ? bridgeServer : undefined;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (webSocket) => target.emit('connection', webSocket, request));
});
await new Promise((resolveListen) => bridgeHTTPServer.listen(0, '127.0.0.1', resolveListen));
const bridgeAddress = bridgeHTTPServer.address();
const bridgeEndpoint = `ws://127.0.0.1:${bridgeAddress.port}/extension`;
const bridgeProtocolVersion = 3;
const engineIdentityId = 'e2e-engine-identity';
const engineInstanceId = 'e2e-engine-instance';
const engineKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const engineJWKRaw = await webcrypto.subtle.exportKey('jwk', engineKeys.publicKey);
const enginePublicKey = { kty: 'EC', crv: 'P-256', x: engineJWKRaw.x, y: engineJWKRaw.y };
let pairedClient;

function bytesToBase64URL(value) {
  return Buffer.from(value).toString('base64url');
}

async function sha256(value) {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', Buffer.from(value)));
}

async function signEngine(value) {
  return bytesToBase64URL(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, engineKeys.privateKey, Buffer.from(value)));
}

function engineChallengePayload(challenge, timestamp) {
  return ['yak-browser-bridge-v3', 'engine-challenge', engineIdentityId, engineInstanceId, challenge, String(timestamp)].join('\n');
}

function clientAuthPayload(origin, challenge, auth) {
  return [
    'yak-browser-bridge-v3', 'client-auth', origin, engineIdentityId, engineInstanceId, challenge,
    auth.installationId || '', auth.client || '', auth.version || '', [...(auth.capabilities || [])].sort().join(','),
    auth.taskId || '', auth.grantId || '', auth.resumeSessionId || '',
  ].join('\n');
}

async function verifyClientAuth(origin, challenge, auth) {
  if (!pairedClient || pairedClient.installationId !== auth.installationId) return false;
  const key = await webcrypto.subtle.importKey('jwk', pairedClient.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(auth.signature, 'base64url'), Buffer.from(clientAuthPayload(origin, challenge, auth)),
  );
}

pairingServer.on('connection', (socket, request) => socket.once('message', async (raw) => {
  try {
    const pairing = JSON.parse(raw.toString());
    if (pairing.type !== 'pair_request' || pairing.protocolVersion !== bridgeProtocolVersion) throw new Error('invalid pairing request');
    const requestId = 'e2e-pairing-request';
    const serverNonce = bytesToBase64URL(randomBytes(32));
    const transcript = [
      'yak-browser-pairing-v1', engineIdentityId, requestId, request.headers.origin, pairing.installationId,
      pairing.nonce, serverNonce, pairing.publicKey.kty, pairing.publicKey.crv, pairing.publicKey.x, pairing.publicKey.y,
    ].join('\n');
    const digest = await sha256(transcript);
    const code = String(Buffer.from(digest.subarray(0, 8)).readBigUInt64BE() % 1_000_000n).padStart(6, '0');
    pairedClient = { installationId: pairing.installationId, publicKey: pairing.publicKey, origin: request.headers.origin };
    socket.send(JSON.stringify({
      type: 'pair_pending', protocolVersion: bridgeProtocolVersion, requestId, serverNonce,
      engineIdentityId, code, expiresAt: Date.now() + 60_000, publicKey: enginePublicKey,
    }));
    setTimeout(() => socket.send(JSON.stringify({
      type: 'pair_approved', requestId, deviceId: 'e2e-browser-device', engineIdentityId, publicKey: enginePublicKey,
    })), 50);
  } catch (error) {
    socket.send(JSON.stringify({ type: 'pair_error', message: error.message }));
  }
}));
let resolveWebFuzzerOpen;
const webFuzzerOpenRequest = new Promise((resolveRequest) => { resolveWebFuzzerOpen = resolveRequest; });
let resolvePocGenerate;
const pocGenerateRequest = new Promise((resolveRequest) => { resolvePocGenerate = resolveRequest; });
let resolveAnalysisPrepare;
const analysisPrepareRequest = new Promise((resolveRequest) => { resolveAnalysisPrepare = resolveRequest; });
const bridgeConnection = new Promise((resolveConnection, rejectConnection) => {
  bridgeServer.once('connection', async (socket, request) => {
    const challenge = bytesToBase64URL(randomBytes(32));
    const timestamp = Date.now();
    socket.send(JSON.stringify({
      type: 'challenge', protocolVersion: bridgeProtocolVersion, challenge, timestamp,
      engineIdentityId, engineInstanceId, publicKey: enginePublicKey,
      signature: await signEngine(engineChallengePayload(challenge, timestamp)),
    }));
    socket.once('message', (raw) => {
      void (async () => {
        const hello = JSON.parse(raw.toString());
        if (hello.type !== 'auth' || hello.challenge !== challenge || !(await verifyClientAuth(request.headers.origin, challenge, hello))) {
          throw new Error('invalid Bridge v3 client authentication');
        }
        socket.send(JSON.stringify({
          type: 'hello_ack',
          protocolVersion: bridgeProtocolVersion,
          version: 'e2e-engine',
          capabilities: ['yakit.web_fuzzer.open', 'yakit.poc.generate', 'yakit.browser_request.prepare_analysis'],
          sessionId: 'e2e-session',
          engineIdentityId,
          engineInstanceId,
          connectionId: 'e2e-connection',
          taskId: hello.taskId,
          grantId: hello.grantId,
          resumed: Boolean(hello.resumeSessionId),
        }));
        socket.on('message', (requestRaw) => {
          try {
            const message = JSON.parse(requestRaw.toString());
            if (message.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong', id: message.id, sequence: message.sequence, timestamp: message.timestamp, replyTimestamp: Date.now() }));
              return;
            }
            if (message.type !== 'request') return;
            if (message.method === 'yakit.web_fuzzer.open') {
              resolveWebFuzzerOpen(message);
              socket.send(JSON.stringify({ id: message.id, type: 'response', result: { pageId: 'e2e-fuzzer-page', tabName: message.params?.tabName || 'Browser Request' } }));
            } else if (message.method === 'yakit.poc.generate') {
              resolvePocGenerate(message);
              socket.send(JSON.stringify({ id: message.id, type: 'response', result: { language: 'yak', fileName: 'browser-e2e.yak', code: 'packet = codec.DecodeBase64("e2e")\nrsp, req, err = poc.HTTP(packet)' } }));
            } else if (message.method === 'yakit.browser_request.prepare_analysis') {
              resolveAnalysisPrepare(message);
              socket.send(JSON.stringify({
                id: message.id,
                type: 'response',
                result: {
                  request: { method: 'POST', scheme: 'http', host: '127.0.0.1', path: '/api/session', contentType: 'application/json', queryKeys: ['source'], headerNames: ['Cookie', 'X-Yakit-E2e'], cookieNames: ['yakit_e2e_session'], bodyKeys: ['marker'], bodyBytes: 38 },
                  signals: [{ location: 'header', name: 'Cookie', category: 'cookie' }],
                  observations: message.params?.observations || [],
                  valuePolicy: 'values omitted',
                  recommendedChecks: ['authorization boundary'],
                },
              }));
            }
          } catch {
            // The main E2E assertions report malformed Bridge traffic.
          }
        });
        resolveConnection({ socket, hello });
      })().catch((error) => {
        rejectConnection(error);
      });
    });
  });
});

function nextBridgeResponse(socket, id) {
  return new Promise((resolveResponse, rejectResponse) => {
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        socket.off('message', onMessage);
        resolveResponse(message);
      } catch (error) {
        socket.off('message', onMessage);
        rejectResponse(error);
      }
    };
    socket.on('message', onMessage);
  });
}

function nextBridgeEvent(socket, method) {
  return new Promise((resolveEvent, rejectEvent) => {
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'event' || message.method !== method) return;
        socket.off('message', onMessage);
        resolveEvent(message);
      } catch (error) {
        socket.off('message', onMessage);
        rejectEvent(error);
      }
    };
    socket.on('message', onMessage);
  });
}

async function callBridge(socket, id, method, params) {
  const response = nextBridgeResponse(socket, id);
  socket.send(JSON.stringify({ id, type: 'request', method, params }));
  return await response;
}

const browserErrors = [];
let context;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 760 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP yakit-insecure.test 127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => browserErrors.push(`${page.url()}: ${error.message}`));
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(serviceWorker.url()).host;

  if (shouldEnableUserScripts) {
    const extensionsPage = await context.newPage();
    await extensionsPage.goto(`chrome://extensions/?id=${extensionId}`);
    const userScriptsToggle = extensionsPage.locator('#allow-user-scripts cr-toggle');
    await userScriptsToggle.waitFor({ state: 'visible', timeout: 10_000 });
    const enabled = await userScriptsToggle.evaluate((toggle) => Boolean(toggle.checked));
    if (!enabled) await userScriptsToggle.click();
    await extensionsPage.close();
  }

  const webPage = await context.newPage();
  await webPage.setViewportSize({ width: 1280, height: 760 });
  await webPage.goto(testUrl);
  const tabs = await serviceWorker.evaluate(async () => await chrome.tabs.query({}));
  const targetTab = tabs.find((tab) => tab.url === testUrl);
  if (!targetTab?.id) throw new Error('Could not resolve the test tab ID');
  await webPage.evaluate(async () => {
    await new Promise((resolveDatabase, rejectDatabase) => {
      const open = indexedDB.open('yakit-e2e-auth', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('sessions');
      open.onerror = () => rejectDatabase(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').put({ authenticated: true }, 'account-1');
        transaction.oncomplete = () => { database.close(); resolveDatabase(); };
        transaction.onerror = () => rejectDatabase(transaction.error);
      };
    });
    const cache = await caches.open('yakit-e2e-session-cache');
    await cache.put('/e2e-cached-session', new Response('cached'));
    history.pushState({ source: 'e2e' }, '', '/authenticated?spa=inventory');
    window.CryptoJS = {
      SHA256(value) {
        return { sigBytes: 32, toString: () => `sha256:${value}` };
      },
    };
    window.__yakitObserverOriginals = {
      fetch: window.fetch,
      xhrOpen: XMLHttpRequest.prototype.open,
      xhrSend: XMLHttpRequest.prototype.send,
      webSocket: window.WebSocket,
      digest: Object.getPrototypeOf(crypto.subtle).digest,
      cryptoJsSha256: window.CryptoJS.SHA256,
    };
  });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 390, height: 560 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('.popup-shell').waitFor();
  await popup.getByText('Authenticated Security Console', { exact: true }).waitFor();
  const popupBrandsLoaded = await popup.locator('.yak-mark, .yakit-mark').evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  if (!popupBrandsLoaded) throw new Error('Popup brand assets did not load');
  await popup.screenshot({ path: resolve(artifacts, 'popup.png') });

  const options = await context.newPage();
  await options.setViewportSize({ width: 1440, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/options.html?tabId=${targetTab.id}#overview`);
  await options.locator('.app-shell').waitFor();
  if (await options.locator('.target-tab-select').inputValue() !== String(targetTab.id)) throw new Error('Options did not preserve the explicit target tab');
  const lateOpenedPage = await context.newPage();
  await lateOpenedPage.goto(testUrl);
  await lateOpenedPage.evaluate(() => { document.title = 'Opened after Options'; });
  const lateOpenedOption = options.locator('.target-tab-select option', { hasText: 'Opened after Options' });
  await lateOpenedOption.waitFor({ state: 'attached' });
  if (await options.locator('.target-tab-select').inputValue() !== String(targetTab.id)) throw new Error('A newly opened tab replaced the explicit Options target');
  await lateOpenedPage.close();
  await lateOpenedOption.waitFor({ state: 'detached' });
  await options.waitForTimeout(300);
  await options.screenshot({ path: resolve(artifacts, 'options-overview.png') });
  await options.getByRole('button', { name: '引擎连接' }).click();
  await options.getByText('连接本机 Yakit', { exact: true }).waitFor();
  await options.waitForTimeout(220);
  await options.screenshot({ path: resolve(artifacts, 'options-engine-unpaired.png') });
  const unpairedEngineBounds = await options.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (unpairedEngineBounds.scrollWidth > unpairedEngineBounds.clientWidth) throw new Error(`Unpaired engine UI overflowed: ${JSON.stringify(unpairedEngineBounds)}`);
  await options.getByRole('button', { name: '运行概览' }).click();
  const strictPage = await context.newPage();
  await strictPage.goto(`http://127.0.0.1:${address.port}/strict-csp`);
  const strictTab = (await serviceWorker.evaluate(async () => await chrome.tabs.query({}))).find((item) => item.url?.includes('/strict-csp'));
  if (!strictTab?.id) throw new Error('Could not resolve strict CSP tab');
  const strictEval = await options.evaluate(async (tabId) => await chrome.runtime.sendMessage({
    action: 'context.eval', payload: { tabId, mode: 'expression', code: 'document.title', timeoutMs: 2_000 },
  }), strictTab.id);
  if (shouldEnableUserScripts) {
    if (!strictEval?.ok || strictEval.data?.value !== 'Strict CSP Page') throw new Error(`Strict CSP page execution failed: ${JSON.stringify(strictEval)}`);
  } else if (strictEval?.ok) {
    throw new Error(`Injected fallback unexpectedly bypassed strict page CSP: ${JSON.stringify(strictEval)}`);
  }
  await strictPage.close();

  const closingPage = await context.newPage();
  await closingPage.goto(testUrl);
  const closingTab = (await serviceWorker.evaluate(async () => await chrome.tabs.query({}))).find((item) => item.url === testUrl && item.id !== targetTab.id);
  if (!closingTab?.id) throw new Error('Could not resolve closing Eval tab');
  const closingEvalPromise = options.evaluate(async (tabId) => await chrome.runtime.sendMessage({
    action: 'context.eval',
    payload: { tabId, mode: 'expression', code: 'new Promise((resolve) => setTimeout(() => resolve(document.title), 2000))', timeoutMs: 5_000 },
  }), closingTab.id);
  await options.waitForTimeout(50);
  await closingPage.close();
  const closingEval = await closingEvalPromise;
  if (closingEval?.ok || !['target_unavailable', 'request_failed'].includes(closingEval?.errorCode)) throw new Error(`Closing tab Eval did not fail closed: ${JSON.stringify(closingEval)}`);

  await webPage.evaluate(() => {
    postMessage({ action: 'grant.create', payload: { scopes: ['browser.page.eval.program'] } }, '*');
    dispatchEvent(new CustomEvent('yakit:page-response:v1', { detail: JSON.stringify({ id: 'forged', ok: true, result: { value: 'forged' } }) }));
  });
  const forgedState = await options.evaluate(async () => await chrome.runtime.sendMessage({ action: 'state.get' }));
  if (!forgedState?.ok || forgedState.data?.activeGrant) throw new Error(`Page forged an extension grant: ${JSON.stringify(forgedState)}`);
  await options.getByRole('button', { name: 'Cookie Editor' }).click();
  const testCookie = options.getByRole('button', { name: 'yakit_e2e_session' });
  await testCookie.waitFor();
  const cookieValueButton = options.getByTitle('显示 Cookie 值').first();
  if (!(await cookieValueButton.textContent()).includes('[hidden')) throw new Error('Cookie Editor exposed a value by default');
  await cookieValueButton.click();
  if (!(await options.getByTitle('隐藏 Cookie 值').first().textContent()).includes('authenticated')) throw new Error('Cookie Editor did not reveal a value on explicit click');
  await options.getByTitle('隐藏 Cookie 值').first().click();
  await testCookie.click();
  if (await options.locator('.rule-editor input').first().inputValue() !== 'yakit_e2e_session') throw new Error('Cookie Editor did not load the selected HttpOnly cookie');
  if (await options.getByText('HttpOnly', { exact: true }).count() === 0) throw new Error('Cookie Editor did not expose HttpOnly metadata');
  const cookieTransferChecks = await options.evaluate(async ({ url }) => {
    const send = async (action, payload) => {
      const response = await chrome.runtime.sendMessage({ action, payload });
      if (!response?.ok) throw new Error(response?.error || action);
      return response.data;
    };
    const redacted = await send('cookie.export', { url, format: 'set-cookie', includeValues: false });
    const sensitive = await send('cookie.export', { url, format: 'json', includeValues: true });
    const imports = [];
    imports.push(await send('cookie.import', { url, format: 'json', text: JSON.stringify([{ name: 'json_import', value: 'json-value', path: '/' }]) }));
    imports.push(await send('cookie.import', { url, format: 'netscape', text: '127.0.0.1\tFALSE\t/\tFALSE\t0\tnetscape_import\tnetscape-value\n' }));
    imports.push(await send('cookie.import', { url, format: 'set-cookie', text: 'Set-Cookie: raw_import=raw-value; Path=/; HttpOnly; SameSite=Lax; Priority=High' }));
    const listed = await send('cookie.list', { url });
    const imported = listed.filter((cookie) => ['json_import', 'netscape_import', 'raw_import'].includes(cookie.name));
    const removed = await send('cookie.removeMany', { cookies: imported.map((cookie) => ({
      url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
      name: cookie.name, storeId: cookie.storeId, partitionKey: cookie.partitionKey,
    })) });
    return { redacted, sensitive, imports, imported: imported.map((cookie) => cookie.name), removed };
  }, { url: testUrl });
  if (!cookieTransferChecks.redacted.includes('[REDACTED]') || cookieTransferChecks.redacted.includes('authenticated')) throw new Error(`Cookie export was not redacted: ${cookieTransferChecks.redacted}`);
  if (!cookieTransferChecks.sensitive.includes('authenticated')) throw new Error('Explicit Cookie value export omitted values');
  if (cookieTransferChecks.imported.length !== 3 || cookieTransferChecks.removed.removed !== 3 || cookieTransferChecks.imports[2].warnings.length === 0) {
    throw new Error(`Cookie import/export/bulk delete failed: ${JSON.stringify(cookieTransferChecks)}`);
  }
  await options.screenshot({ path: resolve(artifacts, 'options-cookie-editor.png') });
  await options.getByRole('button', { name: '登录态工作区' }).click();
  await options.getByRole('tab', { name: '主世界 Eval' }).click();
  await options.screenshot({ path: resolve(artifacts, 'options-context-eval.png') });
  const protocolChecks = await options.evaluate(async () => {
    const invalid = await chrome.runtime.sendMessage({ action: 'panel.update', payload: { enabled: true, unexpected: true } });
    const proxyResponse = await chrome.runtime.sendMessage({ action: 'proxy.switch', payload: { id: 'direct' } });
    const proxySettings = await chrome.proxy.settings.get({});
    await Promise.all([
      chrome.runtime.sendMessage({ action: 'panel.update', payload: { side: 'right' } }),
      chrome.runtime.sendMessage({ action: 'panel.update', payload: { y: 0.46 } }),
    ]);
    const state = await chrome.runtime.sendMessage({ action: 'state.get' });
    return { invalid, proxyResponse, proxyMode: proxySettings.value?.mode, floatingPanel: state.data?.floatingPanel };
  });
  if (protocolChecks.invalid?.ok || !protocolChecks.invalid?.error?.includes('参数无效')) throw new Error(`Runtime schema accepted an unknown field: ${JSON.stringify(protocolChecks.invalid)}`);
  if (protocolChecks.floatingPanel?.side !== 'right' || protocolChecks.floatingPanel?.y !== 0.46) throw new Error(`Concurrent state updates lost data: ${JSON.stringify(protocolChecks.floatingPanel)}`);
  if (!protocolChecks.proxyResponse?.ok || protocolChecks.proxyMode !== 'direct') throw new Error(`Direct proxy mode was not applied explicitly: ${JSON.stringify(protocolChecks)}`);
  const proxyRuleChecks = await options.evaluate(async ({ url }) => {
    const send = async (action, payload) => {
      const response = await chrome.runtime.sendMessage({ action, payload });
      if (!response?.ok) throw new Error(response?.error || action);
      return response.data;
    };
    const directRule = { id: 'e2e-direct-rule', name: 'E2E direct', enabled: true, patterns: ['127.0.0.1'], proxyProfileId: 'direct', priority: 200 };
    const mitmRule = { id: 'e2e-mitm-rule', name: 'E2E MITM conflict', enabled: true, patterns: ['127.0.0.1'], proxyProfileId: 'yakit-mitm', priority: 100 };
    await send('proxy.rule.save', directRule);
    await send('proxy.rule.save', mitmRule);
    await send('proxy.rules.settings', { defaultProfileId: 'direct', failMode: 'open' });
    const firstPreview = await send('proxy.rules.preview', { url });
    const pac = await send('proxy.rules.compile');
    const auth = await send('proxy.auth.set', { profileId: 'yakit-mitm', password: 'proxy-session-secret-818' });
    const authStatus = await send('proxy.auth.status', { profileId: 'yakit-mitm' });
    const reordered = await send('proxy.rules.reorder', { ids: ['e2e-mitm-rule', 'e2e-direct-rule'] });
    const secondPreview = await send('proxy.rules.preview', { url });
    await send('proxy.rules.reorder', { ids: ['e2e-direct-rule', 'e2e-mitm-rule'] });
    const configuration = await send('proxy.config.export');
    const imported = await send('proxy.config.import', { configuration });
    await send('proxy.rules.apply');
    return { firstPreview, secondPreview, pac, auth, authStatus, reordered: reordered.proxyRules, imported: imported.proxyRouting, configuration };
  }, { url: testUrl });
  if (!proxyRuleChecks.firstPreview.conflict || proxyRuleChecks.firstPreview.effectiveProfileId !== 'direct' || proxyRuleChecks.secondPreview.effectiveProfileId !== 'yakit-mitm') {
    throw new Error(`Proxy priority/conflict preview failed: ${JSON.stringify(proxyRuleChecks)}`);
  }
  if (!proxyRuleChecks.pac.includes('priority=200') || !proxyRuleChecks.pac.includes('; DIRECT') || !proxyRuleChecks.auth.configured || !proxyRuleChecks.authStatus.configured) {
    throw new Error(`Proxy PAC/fail-open/auth failed: ${JSON.stringify(proxyRuleChecks)}`);
  }
  await webPage.evaluate(async () => {
    const response = await fetch('/api/session?source=proxy-rule-stats');
    if (!response.ok) throw new Error(`Proxy stats request failed: ${response.status}`);
  });
  const proxyStats = await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'proxy.rules.stats' });
    if (!response?.ok) throw new Error(response?.error || 'proxy.rules.stats');
    return response.data;
  });
  if (!proxyStats.some((item) => item.ruleId === 'e2e-direct-rule' && item.hits > 0)) throw new Error(`Proxy rule hit statistics were not recorded: ${JSON.stringify(proxyStats)}`);
  await options.getByRole('button', { name: '代理规则' }).click();
  await options.getByText('多个出口冲突，使用最高优先级', { exact: true }).waitFor();
  await options.waitForTimeout(350);
  await options.screenshot({ path: resolve(artifacts, 'options-proxy-rules.png') });
  await options.evaluate(async () => {
    await chrome.runtime.sendMessage({ action: 'proxy.auth.set', payload: { profileId: 'yakit-mitm', password: '' } });
    await chrome.runtime.sendMessage({ action: 'proxy.switch', payload: { id: 'direct' } });
  });

  const host = webPage.locator('yakit-browser-agent');
  await host.waitFor({ state: 'attached', timeout: 10_000 });
  const launcher = webPage.locator('.floating-panel__brand');
  await launcher.waitFor({ state: 'visible', timeout: 10_000 });
  const launcherImageLoaded = await launcher.locator('img').evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0);
  if (!launcherImageLoaded) throw new Error('Floating Yak asset did not load');
  await launcher.click();
  await webPage.locator('.floating-panel.is-expanded').waitFor();
  await webPage.waitForTimeout(250);
  const extensionTabs = await serviceWorker.evaluate(async () => await chrome.tabs.query({}));
  const optionsTab = extensionTabs.find((tab) => tab.url?.includes('/options.html'));
  const floatingFrame = webPage.frames().find((frame) => frame.url().includes('/floating.html'));
  if (!optionsTab?.id || !floatingFrame) throw new Error('Could not resolve floating frame sender boundary');
  await floatingFrame.locator('.floating-panel--embedded .floating-panel__body').waitFor({ state: 'visible', timeout: 10_000 });
  await floatingFrame.getByText('快速切换', { exact: true }).waitFor({ state: 'visible' });
  const floatingBrandLoaded = await floatingFrame.locator('.floating-panel__brand img').evaluate((image) => (
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  ));
  if (!floatingBrandLoaded) throw new Error('Expanded floating panel Yak asset did not load');
  await floatingFrame.evaluate(async () => {
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  await webPage.evaluate(async () => {
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  const crossTabGrant = await floatingFrame.evaluate(async (tabId) => await chrome.runtime.sendMessage({
    action: 'grant.create',
    payload: {
      targets: [{ tabId, frameId: 0 }],
      scopes: ['browser.tabs.read', 'browser.dom.read'],
      durationMinutes: 5,
    },
  }), optionsTab.id);
  if (crossTabGrant?.ok || !crossTabGrant?.error?.includes('当前标签页')) throw new Error(`Floating frame crossed its sender tab boundary: ${JSON.stringify(crossTabGrant)}`);
  const rightMetrics = await webPage.locator('.floating-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, viewportWidth: innerWidth };
  });
  if (rightMetrics.width !== 326 || rightMetrics.left < 0 || rightMetrics.right > rightMetrics.viewportWidth) {
    throw new Error(`Right floating panel is clipped: ${JSON.stringify(rightMetrics)}`);
  }
  await webPage.screenshot({ path: resolve(artifacts, 'floating-panel-right.png') });

  const headerBox = await webPage.locator('.floating-panel__header').boundingBox();
  if (!headerBox) throw new Error('Floating panel header has no layout box');
  await webPage.mouse.move(headerBox.x + 20, headerBox.y + 20);
  await webPage.mouse.down();
  await webPage.mouse.move(22, 300, { steps: 8 });
  await webPage.mouse.up();
  await webPage.waitForTimeout(250);
  const snappedLeft = await webPage.locator('.floating-panel').evaluate((panel) => panel.classList.contains('floating-panel--left'));
  if (!snappedLeft) throw new Error('Floating panel did not snap to the left edge');
  await webPage.screenshot({ path: resolve(artifacts, 'floating-panel-left.png') });

  await options.evaluate(async ({ endpoint, tabId }) => {
    const send = async (action, payload) => {
      const response = await chrome.runtime.sendMessage({ action, payload });
      if (!response?.ok) throw new Error(response?.error || action);
      return response.data;
    };
    const state = await send('state.get');
    await send('bridge.config.save', {
      transport: 'websocket',
      nativeHost: 'com.yaklang.browser_agent',
      endpoint,
      autoConnect: false,
      installationId: state.bridge.installationId,
    });
    await send('bridge.pair');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [nextState, bridgeStatus] = await Promise.all([send('state.get'), send('bridge.status')]);
      if (nextState.bridge.pairedEngine && bridgeStatus.state === 'connected') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (attempt === 49) throw new Error(`Bridge v3 did not connect: ${JSON.stringify({ nextState, bridgeStatus })}`);
    }
    await send('grant.create', {
      targets: [{ tabId, frameId: 0 }],
      scopes: ['browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read'],
      durationMinutes: 5,
    });
  }, { endpoint: bridgeEndpoint, tabId: targetTab.id });
  const { socket: bridgeSocket, hello } = await bridgeConnection;
  if (hello.type !== 'auth' || hello.client !== 'yakit-browser-extension' || hello.protocolVersion !== 3 || !hello.installationId || !hello.signature || !hello.capabilities?.includes('browser.eval')) {
    throw new Error(`Unexpected Bridge hello: ${JSON.stringify(hello)}`);
  }
  await options.getByRole('button', { name: '引擎连接' }).click();
  await options.getByText('浏览器已安全配对', { exact: true }).waitFor();
  await options.waitForTimeout(220);
  await options.screenshot({ path: resolve(artifacts, 'options-engine-paired.png') });
  await options.setViewportSize({ width: 390, height: 844 });
  await options.waitForTimeout(150);
  const narrowEngineBounds = await options.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (narrowEngineBounds.scrollWidth > narrowEngineBounds.clientWidth) throw new Error(`Narrow engine UI overflowed: ${JSON.stringify(narrowEngineBounds)}`);
  await options.screenshot({ path: resolve(artifacts, 'options-engine-paired-narrow.png') });
  await options.setViewportSize({ width: 1440, height: 900 });
  await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'agent.pause' });
    if (!response?.ok || response.data?.state !== 'paused') throw new Error(response?.error || 'agent.pause');
  });
  const pausedCall = await callBridge(bridgeSocket, 'verify-agent-paused', 'browser.tabs', {});
  if (pausedCall.error?.code !== 'agent_paused') throw new Error(`Paused Agent accepted a capability: ${JSON.stringify(pausedCall)}`);
  await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'agent.resume' });
    if (!response?.ok || response.data?.state !== 'running') throw new Error(response?.error || 'agent.resume');
  });
  const deniedBridgeEval = await callBridge(bridgeSocket, 'verify-read-denied', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'expression',
    code: 'document.title',
  });
  if (!deniedBridgeEval.error?.message?.includes('browser.page.eval')) {
    throw new Error(`Read grant unexpectedly allowed browser.eval: ${JSON.stringify(deniedBridgeEval)}`);
  }
  await options.evaluate(async ({ tabId }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write',
          'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.observation.read', 'browser.observation.control',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create');
  }, { tabId: targetTab.id });
  const frameInventory = await callBridge(bridgeSocket, 'verify-frame-inventory', 'browser.frames', { tabId: targetTab.id });
  const sameOriginFrame = frameInventory.result?.find((frame) => frame.url?.includes('/frame-same'));
  const crossOriginFrame = frameInventory.result?.find((frame) => frame.url?.includes('/frame-cross'));
  if (frameInventory.error || !sameOriginFrame?.accessible || !sameOriginFrame.sameOrigin || !crossOriginFrame?.accessible || crossOriginFrame.sameOrigin) {
    throw new Error(`Frame inventory did not distinguish same/cross-origin frames: ${JSON.stringify(frameInventory)}`);
  }
  const deniedCrossFrame = await callBridge(bridgeSocket, 'verify-cross-frame-denied', 'browser.context', {
    tabId: targetTab.id,
    frameId: crossOriginFrame.frameId,
  });
  if (deniedCrossFrame.error?.code !== 'target_denied') {
    throw new Error(`Unselected cross-origin frame was readable: ${JSON.stringify(deniedCrossFrame)}`);
  }
  await options.evaluate(async ({ tabId, frameIds }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }, ...frameIds.map((frameId) => ({ tabId, frameId }))],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write',
          'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.observation.read', 'browser.observation.control',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create frames');
  }, { tabId: targetTab.id, frameIds: [sameOriginFrame.frameId, crossOriginFrame.frameId] });
  const crossFrameContext = await callBridge(bridgeSocket, 'verify-cross-frame-context', 'browser.context', {
    tabId: targetTab.id,
    frameId: crossOriginFrame.frameId,
    includeDom: true,
  });
  if (crossFrameContext.error || crossFrameContext.result?.document?.title !== 'Cross Origin Account Frame') {
    throw new Error(`Explicitly granted cross-origin frame was not readable: ${JSON.stringify(crossFrameContext)}`);
  }
  const sharedTabs = await callBridge(bridgeSocket, 'verify-deduplicated-tabs', 'browser.tabs', {});
  if (sharedTabs.error || sharedTabs.result?.length !== 1 || sharedTabs.result[0]?.id !== targetTab.id) {
    throw new Error(`browser.tabs did not de-duplicate multi-frame grants: ${JSON.stringify(sharedTabs)}`);
  }
  const deniedProgramEval = await callBridge(bridgeSocket, 'verify-program-eval-denied', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'program',
    code: 'const value = 41; value + 1',
  });
  if (!deniedProgramEval.error?.message?.includes('browser.page.eval.program')) {
    throw new Error(`Expression-only grant allowed program Eval: ${JSON.stringify(deniedProgramEval)}`);
  }
  const observationStart = await callBridge(bridgeSocket, 'verify-observation-start', 'browser.observe.start', {
    tabId: targetTab.id,
    captureValues: false,
    maxEntries: 100,
  });
  if (observationStart.error || observationStart.result?.active !== true) {
    throw new Error(`Page observation did not start: ${JSON.stringify(observationStart)}`);
  }
  await webPage.evaluate(async (socketPort) => {
    const form = document.querySelector('form');
    form.addEventListener('submit', (event) => event.preventDefault(), { once: true });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fetch('/api/session?source=observer-fetch', { method: 'POST', body: 'observer-fetch-secret-171' });
    await new Promise((resolveRequest, rejectRequest) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/session?source=observer-xhr');
      request.onload = resolveRequest;
      request.onerror = rejectRequest;
      request.send('observer-xhr-secret-272');
    });
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('observer-webcrypto-secret-373'));
    window.CryptoJS.SHA256('observer-cryptojs-secret-474');
    await new Promise((resolveSocket, rejectSocket) => {
      const socket = new WebSocket(`ws://127.0.0.1:${socketPort}/page-socket`);
      socket.onopen = () => socket.send('observer-websocket-secret-575');
      socket.onmessage = () => socket.close();
      socket.onclose = resolveSocket;
      socket.onerror = rejectSocket;
    });
  }, address.port);
  const observationList = await callBridge(bridgeSocket, 'verify-observation-list', 'browser.observe.list', { tabId: targetTab.id, limit: 100 });
  const observedKinds = new Set(observationList.result?.map((item) => item.kind));
  for (const kind of ['fetch', 'xhr', 'form', 'websocket', 'webcrypto', 'cryptojs']) {
    if (!observedKinds.has(kind)) throw new Error(`Page observation missed ${kind}: ${JSON.stringify(observationList)}`);
  }
  const redactedObservations = JSON.stringify(observationList.result);
  for (const secret of ['observer-fetch-secret-171', 'observer-xhr-secret-272', 'observer-webcrypto-secret-373', 'observer-cryptojs-secret-474', 'observer-websocket-secret-575']) {
    if (redactedObservations.includes(secret)) throw new Error(`Metadata-only observation leaked a value: ${secret}`);
  }
  const deniedSensitiveObservation = await callBridge(bridgeSocket, 'verify-observation-sensitive-denied', 'browser.observe.start', {
    tabId: targetTab.id,
    captureValues: true,
  });
  if (!deniedSensitiveObservation.error?.message?.includes('browser.observation.sensitive.read')) {
    throw new Error(`Observation value capture did not require its sensitive scope: ${JSON.stringify(deniedSensitiveObservation)}`);
  }
  await callBridge(bridgeSocket, 'verify-observation-stop-metadata', 'browser.observe.stop', { tabId: targetTab.id });
  await options.evaluate(async ({ tabId, frameIds }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }, ...frameIds.map((frameId) => ({ tabId, frameId }))],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write', 'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.page.eval.program', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.observation.read', 'browser.observation.control', 'browser.observation.sensitive.read',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create observation sensitive');
  }, { tabId: targetTab.id, frameIds: [sameOriginFrame.frameId, crossOriginFrame.frameId] });
  const sensitiveObservationStart = await callBridge(bridgeSocket, 'verify-observation-sensitive-start', 'browser.observe.start', {
    tabId: targetTab.id,
    captureValues: true,
  });
  if (sensitiveObservationStart.error) throw new Error(`Sensitive page observation did not start: ${JSON.stringify(sensitiveObservationStart)}`);
  const programEval = await callBridge(bridgeSocket, 'verify-program-eval', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'program',
    code: 'const programValue = 41; return programValue + 1',
  });
  if (programEval.error || programEval.result?.value !== 42) throw new Error(`Program Eval scope did not execute: ${JSON.stringify(programEval)}`);
  await webPage.evaluate(() => window.CryptoJS.SHA256('observer-sensitive-preview-686'));
  const sensitiveObservations = await callBridge(bridgeSocket, 'verify-observation-sensitive-list', 'browser.observe.list', { tabId: targetTab.id });
  if (!JSON.stringify(sensitiveObservations.result).includes('observer-sensitive-preview-686')) {
    throw new Error(`Explicit observation value capture did not return its bounded preview: ${JSON.stringify(sensitiveObservations)}`);
  }
  await callBridge(bridgeSocket, 'verify-observation-stop-sensitive', 'browser.observe.stop', { tabId: targetTab.id });
  const observerRestored = await webPage.evaluate(() => ({
    fetch: window.fetch === window.__yakitObserverOriginals.fetch,
    xhrOpen: XMLHttpRequest.prototype.open === window.__yakitObserverOriginals.xhrOpen,
    xhrSend: XMLHttpRequest.prototype.send === window.__yakitObserverOriginals.xhrSend,
    webSocket: window.WebSocket === window.__yakitObserverOriginals.webSocket,
    digest: Object.getPrototypeOf(crypto.subtle).digest === window.__yakitObserverOriginals.digest,
    cryptoJs: window.CryptoJS.SHA256 === window.__yakitObserverOriginals.cryptoJsSha256,
  }));
  if (Object.values(observerRestored).some((value) => !value)) throw new Error(`Page APIs were not restored after observation: ${JSON.stringify(observerRestored)}`);

  const insecurePage = await context.newPage();
  await insecurePage.goto(insecureTestUrl);
  const insecureTab = (await serviceWorker.evaluate(async () => await chrome.tabs.query({})))
    .find((tab) => tab.url === insecureTestUrl);
  if (!insecureTab?.id) throw new Error('Could not resolve the insecure HTTP test tab');
  const insecureEnvironment = await insecurePage.evaluate(() => ({
    isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
    cacheStorage: typeof globalThis.caches,
    indexedDB: typeof globalThis.indexedDB,
  }));
  if (insecureEnvironment.isSecureContext || insecureEnvironment.randomUUID !== 'undefined'
    || insecureEnvironment.getRandomValues !== 'function' || insecureEnvironment.cacheStorage !== 'undefined') {
    throw new Error(`Insecure HTTP test did not reproduce the required Crypto environment: ${JSON.stringify(insecureEnvironment)}`);
  }
  const insecureStorageFixture = await insecurePage.evaluate(async () => {
    localStorage.setItem('yakit-insecure-local', 'local-session-value');
    sessionStorage.setItem('yakit-insecure-session', 'tab-session-value');
    if (!globalThis.indexedDB || typeof globalThis.indexedDB.databases !== 'function') return { indexedDB: false };
    await new Promise((resolveDatabase, rejectDatabase) => {
      const open = globalThis.indexedDB.open('yakit-insecure-auth', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('sessions');
      open.onerror = () => rejectDatabase(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').put({ authenticated: true }, 'insecure-account');
        transaction.oncomplete = () => { database.close(); resolveDatabase(); };
        transaction.onerror = () => rejectDatabase(transaction.error);
      };
    });
    return { indexedDB: true };
  });
  const insecureContext = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({
      action: 'context.capture',
      payload: { tabId, includeDom: false, includeStorage: true, includeCookies: false },
    });
  }, insecureTab.id);
  const insecureDocument = insecureContext?.data?.document;
  const insecureIndexedDatabase = insecureDocument?.storageInventory?.indexedDB?.databases
    ?.find((database) => database.name === 'yakit-insecure-auth');
  if (!insecureContext?.ok || !insecureContext.data?.captureId
    || insecureDocument?.localStorage?.supported !== true
    || insecureDocument.localStorage.entries.find((entry) => entry.key === 'yakit-insecure-local')?.value !== 'local-session-value'
    || insecureDocument?.sessionStorage?.supported !== true
    || insecureDocument.sessionStorage.entries.find((entry) => entry.key === 'yakit-insecure-session')?.value !== 'tab-session-value'
    || insecureDocument?.storageInventory?.cacheStorage?.supported !== false
    || (insecureStorageFixture.indexedDB && !insecureIndexedDatabase?.stores?.some((store) => store.name === 'sessions' && store.sampleKeys.includes('insecure-account')))) {
    throw new Error(`Insecure HTTP structured context did not degrade storage capabilities independently: ${JSON.stringify(insecureContext)}`);
  }
  await insecurePage.evaluate(() => {
    window.CryptoJS = {
      SHA256(value) {
        return { sigBytes: 32, toString: () => `insecure-sha256:${value}` };
      },
    };
    window.__yakitInsecureObserverOriginals = {
      fetch: window.fetch,
      xhrOpen: XMLHttpRequest.prototype.open,
      xhrSend: XMLHttpRequest.prototype.send,
      webSocket: window.WebSocket,
      cryptoJsSha256: window.CryptoJS.SHA256,
    };
  });
  const insecureObservationStart = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({
      action: 'observation.start',
      payload: { tabId, captureValues: false, maxEntries: 100 },
    });
  }, insecureTab.id);
  if (!insecureObservationStart?.ok || insecureObservationStart.data?.active !== true) {
    throw new Error(`Insecure HTTP observation did not start: ${JSON.stringify(insecureObservationStart)}`);
  }
  const insecureOriginalResults = await insecurePage.evaluate(async (socketPort) => {
    const cryptoJs = window.CryptoJS.SHA256('insecure-cryptojs-value').toString();
    const fetchResponse = await fetch('/api/session?source=insecure-fetch', { method: 'POST', body: 'insecure-fetch-value' });
    await new Promise((resolveRequest, rejectRequest) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/session?source=insecure-xhr');
      request.onload = resolveRequest;
      request.onerror = rejectRequest;
      request.send('insecure-xhr-value');
    });
    const webSocket = await new Promise((resolveSocket, rejectSocket) => {
      const socket = new WebSocket(`ws://yakit-insecure.test:${socketPort}/page-socket`);
      socket.onopen = () => socket.send('insecure-websocket-value');
      socket.onmessage = (event) => {
        const value = event.data;
        socket.close();
        resolveSocket(value);
      };
      socket.onerror = rejectSocket;
    });
    return { cryptoJs, fetchStatus: fetchResponse.status, webSocket };
  }, address.port);
  if (insecureOriginalResults.cryptoJs !== 'insecure-sha256:insecure-cryptojs-value'
    || insecureOriginalResults.fetchStatus !== 200
    || insecureOriginalResults.webSocket !== 'echo:insecure-websocket-value') {
    throw new Error(`Observation changed insecure page behavior: ${JSON.stringify(insecureOriginalResults)}`);
  }
  const insecureObservations = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ action: 'observation.list', payload: { tabId, limit: 100 } });
  }, insecureTab.id);
  if (!insecureObservations?.ok) throw new Error(`Could not read insecure HTTP observations: ${JSON.stringify(insecureObservations)}`);
  const insecureKinds = new Set(insecureObservations.data.map((item) => item.kind));
  for (const kind of ['fetch', 'xhr', 'websocket', 'cryptojs']) {
    if (!insecureKinds.has(kind)) throw new Error(`Insecure HTTP observation missed ${kind}: ${JSON.stringify(insecureObservations)}`);
  }
  const insecureObservationStop = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ action: 'observation.stop', payload: { tabId } });
  }, insecureTab.id);
  if (!insecureObservationStop?.ok) throw new Error(`Could not stop insecure HTTP observation: ${JSON.stringify(insecureObservationStop)}`);
  const insecureRestored = await insecurePage.evaluate(() => ({
    fetch: window.fetch === window.__yakitInsecureObserverOriginals.fetch,
    xhrOpen: XMLHttpRequest.prototype.open === window.__yakitInsecureObserverOriginals.xhrOpen,
    xhrSend: XMLHttpRequest.prototype.send === window.__yakitInsecureObserverOriginals.xhrSend,
    webSocket: window.WebSocket === window.__yakitInsecureObserverOriginals.webSocket,
    cryptoJs: window.CryptoJS.SHA256 === window.__yakitInsecureObserverOriginals.cryptoJsSha256,
  }));
  if (Object.values(insecureRestored).some((value) => !value)) {
    throw new Error(`Insecure HTTP page APIs were not restored: ${JSON.stringify(insecureRestored)}`);
  }
  await insecurePage.close();

  const bridgeEval = await callBridge(bridgeSocket, 'verify-control-eval', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'expression',
    timeoutMs: 5_000,
    code: `Promise.resolve({ answer: 6 * 7, encrypted: window.app.crypto.encrypt('sensitive-e2e-value-239') })`,
  });
  if (bridgeEval.error || bridgeEval.result?.value?.answer !== 42 || bridgeEval.result?.value?.encrypted !== 'page:sensitive-e2e-value-239') {
    throw new Error(`Control grant browser.eval failed: ${JSON.stringify(bridgeEval)}`);
  }
  const cancelledResponsePromise = nextBridgeResponse(bridgeSocket, 'verify-cancelled-eval');
  bridgeSocket.send(JSON.stringify({
    id: 'verify-cancelled-eval',
    type: 'request',
    method: 'browser.eval',
    params: { tabId: targetTab.id, mode: 'expression', timeoutMs: 5_000, code: `new Promise((resolve) => setTimeout(() => resolve('late'), 1000))` },
  }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  bridgeSocket.send(JSON.stringify({ id: 'verify-cancelled-eval', type: 'cancel' }));
  const cancelledBridgeEval = await cancelledResponsePromise;
  if (cancelledBridgeEval.error?.code !== 'cancelled') throw new Error(`Bridge cancellation was not enforced: ${JSON.stringify(cancelledBridgeEval)}`);

  const firstContext = await callBridge(bridgeSocket, 'verify-context-first', 'browser.context', {
    tabId: targetTab.id,
    includeDom: true,
    includeStorage: true,
    includeCookies: false,
  });
  const accountNode = firstContext.result?.document?.interactive?.find((node) => node.name === 'account');
  const indexedDatabase = firstContext.result?.document?.storageInventory?.indexedDB?.databases?.find((database) => database.name === 'yakit-e2e-auth');
  if (firstContext.error || !firstContext.result?.captureId || !accountNode?.nodeId || 'html' in (firstContext.result?.document || {})
    || firstContext.result.document.bodyText.length > 20 * 1024 || firstContext.result.frames.length < 3
    || !indexedDatabase?.stores?.some((store) => store.name === 'sessions' && store.sampleKeys.includes('account-1'))
    || !firstContext.result.document.storageInventory.cacheStorage.names.includes('yakit-e2e-session-cache')
    || !firstContext.result.lifecycle.some((event) => event.kind === 'history')) {
    throw new Error(`Structured browser context is invalid or unbounded: ${JSON.stringify(firstContext)}`);
  }
  const inspectedAccount = await callBridge(bridgeSocket, 'verify-node-inspect', 'browser.node.inspect', {
    tabId: targetTab.id,
    captureId: firstContext.result.captureId,
    nodeId: accountNode.nodeId,
  });
  if (inspectedAccount.error || inspectedAccount.result?.reference?.captureId !== firstContext.result.captureId || inspectedAccount.result?.attributes?.value) {
    throw new Error(`Stable node inspection leaked a value or returned the wrong reference: ${JSON.stringify(inspectedAccount)}`);
  }
  const setNodeValue = await callBridge(bridgeSocket, 'verify-node-set-value', 'browser.node.action', {
    tabId: targetTab.id,
    captureId: firstContext.result.captureId,
    nodeId: accountNode.nodeId,
    action: 'setValue',
    value: 'context-node-secret-e2e-448',
  });
  if (setNodeValue.error || await webPage.locator('input[name="account"]').inputValue() !== 'context-node-secret-e2e-448') {
    throw new Error(`Stable node setValue failed: ${JSON.stringify(setNodeValue)}`);
  }
  await webPage.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'context-diff-action';
    button.textContent = 'Context diff action';
    button.addEventListener('click', () => { window.__contextNodeClicked = true; });
    document.querySelector('main')?.append(button);
  });
  const secondContext = await callBridge(bridgeSocket, 'verify-context-second', 'browser.context', {
    tabId: targetTab.id,
    includeDom: true,
  });
  const addedActionNode = secondContext.result?.document?.interactive?.find((node) => node.nodeId && node.accessibleName === 'Context diff action');
  if (secondContext.error || secondContext.result?.diff?.kind !== 'changed' || !secondContext.result.diff.addedNodes?.some((node) => node.text === 'Context diff action') || !addedActionNode) {
    throw new Error(`Context diff did not report the added action: ${JSON.stringify(secondContext)}`);
  }
  const staleNode = await callBridge(bridgeSocket, 'verify-stale-node', 'browser.node.inspect', {
    tabId: targetTab.id,
    captureId: firstContext.result.captureId,
    nodeId: accountNode.nodeId,
  });
  if (staleNode.error?.code !== 'stale_node') throw new Error(`Old context node reference remained valid: ${JSON.stringify(staleNode)}`);
  const clickNode = await callBridge(bridgeSocket, 'verify-node-click', 'browser.node.action', {
    tabId: targetTab.id,
    captureId: secondContext.result.captureId,
    nodeId: addedActionNode.nodeId,
    action: 'click',
  });
  await webPage.waitForTimeout(50);
  if (clickNode.error || await webPage.evaluate(() => window.__contextNodeClicked) !== true) {
    throw new Error(`Stable node click failed: ${JSON.stringify(clickNode)}`);
  }
  await webPage.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'context-performance-fixture';
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 10_500; index += 1) {
      const span = document.createElement('span');
      span.textContent = `安全上下文-${index} `;
      fragment.append(span);
    }
    container.append(fragment);
    document.body.append(container);
  });
  const boundedContext = await callBridge(bridgeSocket, 'verify-context-bounds', 'browser.context', {
    tabId: targetTab.id,
    includeDom: true,
  });
  if (boundedContext.error || boundedContext.result?.document?.scannedElementCount !== 10_000
    || !boundedContext.result.document.limitsReached?.includes('scanned_elements')
    || Buffer.byteLength(boundedContext.result.document.bodyText, 'utf8') > 20 * 1024) {
    throw new Error(`Structured context did not enforce scan/text byte limits: ${JSON.stringify(boundedContext)}`);
  }
  await webPage.evaluate(() => document.getElementById('context-performance-fixture')?.remove());

  const handoffResponse = await callBridge(bridgeSocket, 'verify-handoff', 'browser.handoff.request', {
    tabId: targetTab.id,
    reason: 'qr_code',
    message: '请扫描测试二维码并确认登录',
  });
  if (handoffResponse.error || handoffResponse.result?.state !== 'waiting_for_user') {
    throw new Error(`Human handoff did not enter waiting state: ${JSON.stringify(handoffResponse)}`);
  }
  await options.getByText('请扫描测试二维码并确认登录', { exact: true }).waitFor();
  await floatingFrame.getByText('请扫描测试二维码并确认登录', { exact: true }).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-human-handoff.png') });
  await webPage.screenshot({ path: resolve(artifacts, 'floating-panel-handoff.png') });
  const handoffPopup = await context.newPage();
  await handoffPopup.setViewportSize({ width: 390, height: 560 });
  await handoffPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await handoffPopup.getByText('请扫描测试二维码并确认登录', { exact: true }).waitFor();
  await handoffPopup.screenshot({ path: resolve(artifacts, 'popup-human-handoff.png') });
  await handoffPopup.close();

  const handoffEventPromise = nextBridgeEvent(bridgeSocket, 'browser.handoff.changed');
  await floatingFrame.getByRole('button', { name: '已完成' }).click();
  const handoffEvent = await handoffEventPromise;
  if (handoffEvent.params?.id !== handoffResponse.result.id || handoffEvent.params?.state !== 'completed') {
    throw new Error(`Engine did not receive completed handoff event: ${JSON.stringify(handoffEvent)}`);
  }
  await options.getByText('请扫描测试二维码并确认登录', { exact: true }).waitFor({ state: 'detached' });

  await options.getByRole('button', { name: '操作记录' }).click();
  await options.getByText('browser.handoff.request', { exact: true }).first().waitFor();
  await options.waitForTimeout(300);
  await options.screenshot({ path: resolve(artifacts, 'options-activity.png') });
  const auditEvents = await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'audit.list', payload: { limit: 200 } });
    if (!response?.ok) throw new Error(response?.error || 'audit.list');
    return response.data;
  });
  if (JSON.stringify(auditEvents).includes('sensitive-e2e-value-239') || JSON.stringify(auditEvents).includes('context-node-secret-e2e-448')) throw new Error('Audit log leaked browser.eval or node action data');
  if (!auditEvents.some((event) => event.action === 'handoff.completed' && event.outcome === 'success')) throw new Error('Audit log is missing the completed handoff');
  const runtimeAndStorage = await options.evaluate(async () => {
    const runtimeResponse = await chrome.runtime.sendMessage({ action: 'agent.runtime.get' });
    if (!runtimeResponse?.ok) throw new Error(runtimeResponse?.error || 'agent.runtime.get');
    return {
      runtime: runtimeResponse.data,
      local: await chrome.storage.local.get(null),
      session: await chrome.storage.session.get(null),
    };
  });
  if (runtimeAndStorage.runtime.state !== 'running' || !runtimeAndStorage.runtime.actions.some((action) => action.method === 'browser.handoff.request' && action.state === 'success')) {
    throw new Error(`Agent runtime timeline is incomplete: ${JSON.stringify(runtimeAndStorage.runtime)}`);
  }
  for (const key of ['settings.proxy.v1', 'settings.user-agent.v1', 'settings.bridge.v2', 'ui.floating-panel.v1']) {
    if (!(key in runtimeAndStorage.local)) throw new Error(`Split local storage key is missing: ${key}`);
  }
  if ('yakit-extension-state-v5' in runtimeAndStorage.local || JSON.stringify(runtimeAndStorage.local).includes('proxy-session-secret-818')) {
    throw new Error('Local storage retained a legacy state blob or session-only proxy password');
  }
  for (const key of ['session.browser-agent.v1', 'session.bridge.v1', 'session.agent-runtime.v1']) {
    if (!(key in runtimeAndStorage.session)) throw new Error(`Split session storage key is missing: ${key}`);
  }

  await options.getByRole('button', { name: '网络活动' }).click();
  await options.locator('.network-control-bar .ui-switch').nth(0).click();
  await options.locator('.network-control-bar .ui-switch').nth(1).click();
  await options.getByRole('button', { name: '开始捕获' }).click();
  await webPage.evaluate(async () => {
    const response = await fetch('/api/session?source=browser-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yakit-e2e': 'request-header-value' },
      body: JSON.stringify({ marker: 'network-sensitive-e2e-771' }),
    });
    if (!response.ok) throw new Error(`E2E API returned ${response.status}`);
    await response.json();
  });
  const capturedNetworkRow = options.locator('.network-row').filter({ hasText: '/api/session?source=browser-agent' }).first();
  await capturedNetworkRow.waitFor();
  await capturedNetworkRow.click();
  await options.getByText(/x-yakit-e2e: request-header-value/i).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-network-activity.png') });

  const bridgeNetworkList = await callBridge(bridgeSocket, 'verify-network-list', 'browser.network.list', {
    tabId: targetTab.id,
    limit: 20,
  });
  const capturedRequest = bridgeNetworkList.result?.find((record) => record.url?.includes('/api/session'));
  if (bridgeNetworkList.error || !capturedRequest?.requestHeaders?.some((header) => header.name.toLowerCase() === 'x-yakit-e2e') || capturedRequest.requestBody?.data?.includes('network-sensitive-e2e-771') !== true) {
    throw new Error(`Agent network capture did not include the explicitly granted request: ${JSON.stringify(bridgeNetworkList)}`);
  }

  await options.getByRole('button', { name: 'Yakit' }).click();
  const fuzzerOpenMessage = await webFuzzerOpenRequest;
  const fuzzerPacket = Buffer.from(fuzzerOpenMessage.params?.rawRequestBase64 || '', 'base64').toString('utf8');
  if (!fuzzerPacket.includes('POST /api/session?source=browser-agent HTTP/1.1') || !/x-yakit-e2e: request-header-value/i.test(fuzzerPacket) || !fuzzerPacket.includes('network-sensitive-e2e-771') || !/cookie: .*yakit_e2e_session=authenticated/i.test(fuzzerPacket)) {
    throw new Error(`Web Fuzzer handoff did not contain the real authenticated request: ${fuzzerPacket}`);
  }
  await options.getByRole('button', { name: 'PoC' }).click();
  const pocMessage = await pocGenerateRequest;
  const pocPacket = Buffer.from(pocMessage.params?.rawRequestBase64 || '', 'base64').toString('utf8');
  if (!pocPacket.includes('network-sensitive-e2e-771')) throw new Error(`Yak PoC generation did not receive the captured request: ${pocPacket}`);
  await options.getByText('browser-e2e.yak', { exact: true }).waitFor();
  await options.getByRole('button', { name: '分析' }).click();
  const analysisMessage = await analysisPrepareRequest;
  if (JSON.stringify(analysisMessage.params?.observations || []).includes('observer-sensitive-preview-686')) {
    throw new Error('AI analysis payload included a sensitive observation preview');
  }
  await options.getByText('AI 分析上下文', { exact: true }).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-network-analysis.png') });
  const networkAudit = await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'audit.list', payload: { limit: 200 } });
    if (!response?.ok) throw new Error(response?.error || 'audit.list');
    return response.data;
  });
  if (JSON.stringify(networkAudit).includes('network-sensitive-e2e-771') || JSON.stringify(networkAudit).includes('yakit_e2e_session=authenticated')) {
    throw new Error('Audit log leaked captured network credentials or request body');
  }
  await options.getByRole('button', { name: '停止' }).click();
  await options.getByRole('button', { name: '登录态工作区' }).click();
  await options.locator('.context-options input').nth(0).check();
  await options.locator('.context-options input').nth(1).check();
  await options.getByRole('button', { name: '采集页面' }).click();
  await webPage.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'context-ui-diff';
    button.textContent = 'UI context change';
    document.querySelector('main')?.append(button);
  });
  await options.getByRole('button', { name: '刷新并比较' }).click();
  await options.getByText('发现变化', { exact: true }).first().waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-context-workspace.png') });
  const evalResponse = await options.evaluate(async ({ tabId }) => {
    return await chrome.runtime.sendMessage({
      action: 'context.eval',
      payload: {
        tabId,
        mode: 'program',
        timeoutMs: 5_000,
        code: `window.__yakitEvalMarker = 41; return Promise.resolve({ answer: window.__yakitEvalMarker + 1, encrypted: window.app.crypto.encrypt('ok'), host: location.hostname })`,
      },
    });
  }, { tabId: targetTab.id });
  if (!evalResponse?.ok || evalResponse.data?.value?.answer !== 42 || evalResponse.data?.value?.encrypted !== 'page:ok') {
    throw new Error(`Unexpected page Eval response: ${JSON.stringify(evalResponse)}`);
  }
  const timeoutResponse = await options.evaluate(async ({ tabId }) => {
    return await chrome.runtime.sendMessage({
      action: 'context.eval',
      payload: { tabId, mode: 'expression', timeoutMs: 250, code: `new Promise((resolve) => setTimeout(() => resolve('late'), 500))` },
    });
  }, { tabId: targetTab.id });
  if (timeoutResponse?.ok || !timeoutResponse?.error?.includes('250ms')) {
    throw new Error(`Page Eval timeout was not enforced: ${JSON.stringify(timeoutResponse)}`);
  }

  const panelMetrics = await webPage.locator('.floating-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  if (panelMetrics.left < 0 || panelMetrics.right > panelMetrics.viewportWidth || panelMetrics.height > 480 || panelMetrics.height > panelMetrics.viewportHeight) {
    throw new Error(`Floating panel is outside the viewport: ${JSON.stringify(panelMetrics)}`);
  }

  const mobileOptions = await context.newPage();
  await mobileOptions.setViewportSize({ width: 390, height: 844 });
  await mobileOptions.goto(`chrome-extension://${extensionId}/options.html#overview`);
  await mobileOptions.locator('.app-shell').waitFor();
  await mobileOptions.waitForTimeout(300);
  const mobileOverflow = await mobileOptions.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (mobileOverflow > 0) throw new Error(`Options mobile layout overflows by ${mobileOverflow}px`);
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-mobile.png'), fullPage: true });
  await mobileOptions.getByRole('button', { name: '网络活动' }).click();
  await mobileOptions.waitForTimeout(300);
  const mobileNetworkOverflow = await mobileOptions.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (mobileNetworkOverflow > 0) throw new Error(`Network mobile layout overflows by ${mobileNetworkOverflow}px`);
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-network-mobile.png'), fullPage: true });
  await mobileOptions.getByRole('button', { name: '登录态工作区' }).click();
  await mobileOptions.getByRole('button', { name: '采集页面' }).click();
  await mobileOptions.locator('.context-session-strip').waitFor();
  const mobileContextOverflow = await mobileOptions.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (mobileContextOverflow > 0) throw new Error(`Context mobile layout overflows by ${mobileContextOverflow}px`);
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-context-mobile.png'), fullPage: true });
  await mobileOptions.setViewportSize({ width: 320, height: 700 });
  await mobileOptions.goto(`chrome-extension://${extensionId}/options.html?tabId=${targetTab.id}#overview`);
  await mobileOptions.locator('.task-command-bar').waitFor();
  const narrowOptionsLayout = await mobileOptions.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    wrappedNavLabels: [...document.querySelectorAll('.sidebar nav button span')].filter((label) => {
      const style = getComputedStyle(label);
      return label.getBoundingClientRect().height > Number.parseFloat(style.lineHeight || '20') * 1.5;
    }).length,
  }));
  if (narrowOptionsLayout.overflow > 0 || narrowOptionsLayout.wrappedNavLabels > 0) throw new Error(`Options 320px navigation/layout failed: ${JSON.stringify(narrowOptionsLayout)}`);
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-overview-320.png'), fullPage: true });

  const narrowPage = await context.newPage();
  await narrowPage.setViewportSize({ width: 320, height: 640 });
  await narrowPage.goto(testUrl);
  await narrowPage.locator('.floating-panel__brand').waitFor({ state: 'visible' });
  await narrowPage.locator('.floating-panel__brand').click();
  await narrowPage.waitForTimeout(250);
  const narrowPanel = await narrowPage.locator('.floating-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, viewportWidth: innerWidth };
  });
  if (narrowPanel.left < 0 || narrowPanel.right > narrowPanel.viewportWidth) throw new Error(`Narrow floating panel overflows: ${JSON.stringify(narrowPanel)}`);
  await narrowPage.screenshot({ path: resolve(artifacts, 'floating-panel-narrow.png') });

  const agentCapture = await callBridge(bridgeSocket, 'verify-agent-capture-start', 'browser.network.start', {
    tabId: targetTab.id,
    captureHeaders: false,
    captureBody: false,
  });
  if (agentCapture.error || agentCapture.result?.active !== true) throw new Error(`Agent could not start a scoped capture: ${JSON.stringify(agentCapture)}`);
  const captureAfterRevoke = await options.evaluate(async ({ tabId }) => {
    const revoked = await chrome.runtime.sendMessage({ action: 'grant.revoke' });
    if (!revoked?.ok) throw new Error(revoked?.error || 'grant.revoke');
    const status = await chrome.runtime.sendMessage({ action: 'network.capture.status', payload: { tabId } });
    if (!status?.ok) throw new Error(status?.error || 'network.capture.status');
    return status.data;
  }, { tabId: targetTab.id });
  if (captureAfterRevoke.active) throw new Error(`Agent-owned capture survived grant revocation: ${JSON.stringify(captureAfterRevoke)}`);
  await options.evaluate(async ({ tabId }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write',
          'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create after capture revoke');
  }, { tabId: targetTab.id });

  await webPage.reload();
  const staleDocumentEval = await callBridge(bridgeSocket, 'verify-document-boundary', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'expression',
    code: 'document.title',
  });
  if (staleDocumentEval.error?.code !== 'stale_document') throw new Error(`Grant survived a same-origin document reload: ${JSON.stringify(staleDocumentEval)}`);
  await options.evaluate(async ({ tabId }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write',
          'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create after reload');
  }, { tabId: targetTab.id });

  await options.evaluate(async () => await chrome.runtime.sendMessage({ action: 'panel.update', payload: { enabled: false } }));
  await webPage.locator('.floating-panel__brand').waitFor({ state: 'hidden' });
  await options.evaluate(async () => await chrome.runtime.sendMessage({ action: 'panel.update', payload: { enabled: true } }));
  await webPage.locator('.floating-panel__brand').waitFor({ state: 'visible' });
  await webPage.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY', altKey: true, shiftKey: true, bubbles: true })));
  await webPage.locator('.floating-panel.is-expanded').waitFor();
  await webPage.locator('.floating-panel__brand').click();
  const currentOrigin = new URL(testUrl).origin;
  await options.evaluate(async (origin) => {
    const response = await chrome.runtime.sendMessage({ action: 'panel.update', payload: { siteMode: 'denylist', siteOrigins: [origin] } });
    if (!response?.ok) throw new Error(response?.error || 'panel.update denylist');
  }, currentOrigin);
  await webPage.locator('.floating-panel__brand').waitFor({ state: 'hidden' });
  await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'panel.update', payload: { siteMode: 'all', siteOrigins: [] } });
    if (!response?.ok) throw new Error(response?.error || 'panel.update all');
  });
  await webPage.locator('.floating-panel__brand').waitFor({ state: 'visible' });
  const diagnostics = await options.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'diagnostics.export' });
    if (!response?.ok) throw new Error(response?.error || 'diagnostics.export');
    return response.data;
  });
  const diagnosticsText = JSON.stringify(diagnostics);
  if (diagnosticsText.includes('sensitive-e2e-value-239') || diagnosticsText.includes('context-node-secret-e2e-448') || diagnosticsText.includes(testUrl)) {
    throw new Error('Diagnostics export leaked page, Eval, node or URL values');
  }
  if (diagnostics.metrics.serviceWorkerStarts < 1 || diagnostics.metrics.heartbeatSamples < 1 || !diagnostics.metrics.capabilities['browser.context']) {
    throw new Error(`Diagnostics metrics are incomplete: ${JSON.stringify(diagnostics.metrics)}`);
  }
  const crossOriginUrl = testUrl.replace('127.0.0.1', 'localhost');
  await webPage.goto(crossOriginUrl);
  const staleOriginEval = await callBridge(bridgeSocket, 'verify-origin-boundary', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'expression',
    code: 'document.title',
  });
  if (!staleOriginEval.error?.message?.includes('跨来源')) throw new Error(`Grant survived a cross-origin navigation: ${JSON.stringify(staleOriginEval)}`);
  const beforeRestart = await options.evaluate(async () => {
    const [state, runtime] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'state.get' }),
      chrome.runtime.sendMessage({ action: 'agent.runtime.get' }),
    ]);
    return { grantId: state.data?.activeGrant?.id, taskId: state.data?.activeGrant?.taskId, runtime: runtime.data };
  });
  const cdp = await context.newCDPSession(options);
  const versionPromise = new Promise((resolveVersion, rejectVersion) => {
    const timer = setTimeout(() => rejectVersion(new Error('Could not resolve extension Service Worker version')), 5_000);
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const version = versions.find((item) => item.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && item.runningStatus === 'running');
      if (!version) return;
      clearTimeout(timer);
      resolveVersion(version);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const runningVersion = await versionPromise;
  await cdp.send('ServiceWorker.stopWorker', { versionId: runningVersion.versionId });
  const afterRestart = await options.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ action: 'state.get' });
    const runtime = await chrome.runtime.sendMessage({ action: 'agent.runtime.get' });
    if (!state?.ok || !runtime?.ok) throw new Error(state?.error || runtime?.error || 'Service Worker restart state');
    return { grantId: state.data?.activeGrant?.id, taskId: state.data?.activeGrant?.taskId, runtime: runtime.data };
  });
  await cdp.detach();
  if (!beforeRestart.grantId || afterRestart.grantId !== beforeRestart.grantId || afterRestart.taskId !== beforeRestart.taskId || afterRestart.runtime.grantId !== beforeRestart.runtime.grantId) {
    throw new Error(`Service Worker restart lost grant/task runtime: ${JSON.stringify({ beforeRestart, afterRestart })}`);
  }
  const unpairedIdentity = await options.evaluate(async () => {
    const before = await chrome.runtime.sendMessage({ action: 'state.get' });
    const unpaired = await chrome.runtime.sendMessage({ action: 'bridge.unpair' });
    const after = await chrome.runtime.sendMessage({ action: 'state.get' });
    if (!before?.ok || !unpaired?.ok || !after?.ok) throw new Error(before?.error || unpaired?.error || after?.error || 'bridge.unpair');
    return {
      beforeInstallationId: before.data.bridge.installationId,
      afterInstallationId: after.data.bridge.installationId,
      pairedEngine: after.data.bridge.pairedEngine,
      autoConnect: after.data.bridge.autoConnect,
    };
  });
  if (!unpairedIdentity.beforeInstallationId
    || unpairedIdentity.afterInstallationId !== unpairedIdentity.beforeInstallationId
    || unpairedIdentity.pairedEngine !== undefined
    || unpairedIdentity.autoConnect !== false) {
    throw new Error(`Local unpair changed the stable browser installation identity: ${JSON.stringify(unpairedIdentity)}`);
  }
  if (browserErrors.length > 0) throw new Error(`Browser page errors:\n${browserErrors.join('\n')}`);

  console.log(JSON.stringify({ extensionId, testUrl, evalResult: evalResponse.data, timeoutError: timeoutResponse.error, bridgeEval: bridgeEval.result, cancelledBridgeError: cancelledBridgeEval.error, handoffEvent, auditEventCount: networkAudit.length, capturedNetworkUrl: capturedRequest.url, fuzzerPageId: 'e2e-fuzzer-page', protocolChecks, staleDocumentError: staleDocumentEval.error, staleOriginError: staleOriginEval.error?.message, serviceWorkerRestart: { beforeRestart, afterRestart }, unpairedIdentity, rightMetrics, panelMetrics, narrowPanel, artifacts }, null, 2));
} finally {
  await context?.close();
  server.close();
  for (const client of bridgeServer.clients) client.terminate();
  for (const client of pairingServer.clients) client.terminate();
  bridgeServer.close();
  pairingServer.close();
  bridgeHTTPServer.close();
  await rm(userDataDir, { recursive: true, force: true });
}
