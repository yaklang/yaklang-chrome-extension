import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { resolveChromiumPath } from './resolve-chromium.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const NodeJSEncrypt = require('jsencrypt');
const NodeSMCrypto = require('sm-crypto');
const NodeForge = require('node-forge');
const jsencryptBrowserPath = resolve(root, 'node_modules/jsencrypt/bin/jsencrypt.min.js');
const sm2BrowserPath = resolve(root, 'node_modules/sm-crypto/dist/sm2.js');
const sm3BrowserPath = resolve(root, 'node_modules/sm-crypto/dist/sm3.js');
const sm4BrowserPath = resolve(root, 'node_modules/sm-crypto/dist/sm4.js');
const nodeForgeBrowserPath = resolve(root, 'node_modules/node-forge/dist/forge.min.js');
const extensionPath = resolve(root, process.env.EXTENSION_PATH || '.output/chrome-mv3');
const extensionManifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'));
const shouldEnableUserScripts = process.env.ENABLE_USER_SCRIPTS !== '0' && extensionManifest.permissions?.includes('userScripts');
const artifacts = resolve(root, '.artifacts/ui');
const executablePath = await resolveChromiumPath();
const userDataDir = await mkdtemp(join(tmpdir(), 'yakit-extension-'));
await mkdir(artifacts, { recursive: true });

const cryptoLabAESBytes = Buffer.from('00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f', 'hex');
const cryptoLabHMACBytes = Buffer.from('ffeeddccbbaa998877665544332211000f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
const cryptoLabAESKey = webcrypto.subtle.importKey('raw', cryptoLabAESBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const cryptoLabHMACKey = webcrypto.subtle.importKey('raw', cryptoLabHMACBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
const rsaLabKeyPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
const rsaLabPublicKey = rsaLabKeyPair.publicKey.export({ type: 'spki', format: 'pem' });
const rsaLabPrivateKey = rsaLabKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const rsaLabPublicJWK = rsaLabKeyPair.publicKey.export({ format: 'jwk' });
const rsaLabPublicModulusHex = Buffer.from(rsaLabPublicJWK.n, 'base64url').toString('hex');
const rsaLabDecryptor = new NodeJSEncrypt();
rsaLabDecryptor.setPrivateKey(rsaLabPrivateKey);
const smLabKeyPair = NodeSMCrypto.sm2.generateKeyPairHex();
const smLabSM4Key = '0123456789abcdeffedcba9876543210';
const smLabSM4IV = 'fedcba98765432100123456789abcdef';
const forgeLabAESKey = '00112233445566778899aabbccddeeff';
const forgeLabAESIV = '102132435465768798a9bacbdcedfe0f';
const forgeLabPrivateKey = NodeForge.pki.privateKeyFromPem(rsaLabPrivateKey);
const closureHoldoutSeed = randomBytes(6).toString('hex');
const closureModulePath = `/assets/opaque-${closureHoldoutSeed}.mjs`;
const closureSubmitPath = `/gateway/opaque-${closureHoldoutSeed}`;
const closurePayloadField = `blob_${closureHoldoutSeed}`;
const closureDigestField = `proof_${closureHoldoutSeed}`;
const closureFunctionName = `build_${closureHoldoutSeed}`;
const closureSenderName = `send_${closureHoldoutSeed}`;
const closureInitialMarker = `module-recording-${closureHoldoutSeed}`;
const closureReplayMarker = `module-replay-${closureHoldoutSeed}`;
const WASM_XOR_MASK = 23;

function decryptRSALabValue(value) {
  const plaintext = rsaLabDecryptor.decrypt(value);
  if (typeof plaintext !== 'string') throw new Error('JSEncrypt server could not decrypt the RSA ciphertext');
  return plaintext;
}

async function decryptCryptoLabResponse(envelope) {
  const plaintext = await webcrypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: Buffer.from(envelope.iv, 'base64'),
    additionalData: Buffer.from(`response:${envelope.nonce}`),
  }, await cryptoLabAESKey, Buffer.from(envelope.ciphertext, 'base64'));
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.url?.startsWith(closureModulePath)) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(`const encoder = new TextEncoder();
      const wasmBytes = Uint8Array.from([0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,7,7,1,3,109,105,120,0,0,10,9,1,7,0,32,0,65,${WASM_XOR_MASK},115,11]);
      const { instance } = await WebAssembly.instantiate(wasmBytes);
      const toBase64 = (value) => {
        let binary = '';
        for (const byte of value) binary += String.fromCharCode(byte);
        return btoa(binary);
      };
      async function ${closureFunctionName}(payload) {
        const plaintext = encoder.encode(JSON.stringify(payload));
        const transformed = Uint8Array.from(plaintext, (byte) => instance.exports.mix(byte));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', transformed));
        return {
          [${JSON.stringify(closurePayloadField)}]: toBase64(transformed),
          [${JSON.stringify(closureDigestField)}]: toBase64(digest),
        };
      }
      async function ${closureSenderName}() {
        const marker = document.querySelector('#opaque-module-input').value;
        const envelope = await ${closureFunctionName}({ marker, nested: { seed: ${JSON.stringify(closureHoldoutSeed)} } });
        const response = await fetch(${JSON.stringify(closureSubmitPath)}, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
        });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'opaque module rejected');
        document.querySelector('#opaque-module-result').textContent = result.marker;
      }
      document.querySelector('#opaque-module-submit').addEventListener('click', () => void ${closureSenderName}());
      document.querySelector('#opaque-module-lab').dataset.ready = 'true';`);
    return;
  }
  if (request.url?.startsWith(closureSubmitPath)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const transformed = Buffer.from(envelope[closurePayloadField], 'base64');
      const plaintextBytes = Buffer.from(transformed.map((byte) => byte ^ WASM_XOR_MASK));
      const payload = JSON.parse(plaintextBytes.toString('utf8'));
      const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', transformed)).toString('base64');
      if (envelope[closureDigestField] !== digest) throw new Error('opaque module digest mismatch');
      if (typeof payload.marker !== 'string' || payload.nested?.seed !== closureHoldoutSeed) {
        throw new Error('opaque module payload mismatch');
      }
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, marker: payload.marker }));
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.url?.startsWith('/opaque-worker.js')) {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(`self.addEventListener('message', (event) => {
      const plaintext = JSON.stringify(event.data);
      const bytes = new TextEncoder().encode(plaintext);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      self.postMessage({ sealed: btoa(binary), byteLength: bytes.byteLength });
    });`);
    return;
  }
  if (request.url?.startsWith('/opaque-worker-submit')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const plaintext = JSON.parse(Buffer.from(envelope.sealed, 'base64').toString('utf8'));
      if (plaintext.marker !== 'worker-boundary-holdout-811') throw new Error('unexpected Worker plaintext');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, marker: plaintext.marker }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.url?.startsWith('/beacon-boundary')) {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.url?.startsWith('/semantic-adapter-submit')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const smPlaintext = NodeSMCrypto.sm2.doDecrypt(envelope.sm2Ciphertext, smLabKeyPair.privateKey, 1);
      if (smPlaintext !== envelope.expectedSMPlaintext) throw new Error('SM2 server decryption mismatch');
      if (!NodeSMCrypto.sm2.doVerifySignature(
        envelope.expectedSMPlaintext, envelope.sm2Signature, smLabKeyPair.publicKey,
      )) throw new Error('SM2 server signature verification failed');
      if (NodeSMCrypto.sm3(envelope.expectedSMPlaintext) !== envelope.sm3Digest) throw new Error('SM3 digest mismatch');
      const sm4Plaintext = NodeSMCrypto.sm4.decrypt(envelope.sm4Ciphertext, smLabSM4Key, {
        mode: 'cbc', iv: smLabSM4IV,
      });
      if (sm4Plaintext !== envelope.expectedSMPlaintext) throw new Error('SM4 server decryption mismatch');

      const decipher = NodeForge.cipher.createDecipher('AES-CBC', NodeForge.util.hexToBytes(forgeLabAESKey));
      decipher.start({ iv: NodeForge.util.hexToBytes(forgeLabAESIV) });
      decipher.update(NodeForge.util.createBuffer(NodeForge.util.hexToBytes(envelope.forgeAesCiphertext)));
      if (!decipher.finish()) throw new Error('node-forge AES server decryption failed');
      if (decipher.output.getBytes() !== envelope.expectedForgePlaintext) throw new Error('node-forge AES plaintext mismatch');
      const forgeRsaPlaintext = forgeLabPrivateKey.decrypt(
        NodeForge.util.decode64(envelope.forgeRsaCiphertext), 'RSAES-PKCS1-V1_5',
      );
      if (forgeRsaPlaintext !== envelope.expectedForgePlaintext) throw new Error('node-forge RSA plaintext mismatch');
      const digest = NodeForge.md.sha256.create();
      digest.update(envelope.expectedForgePlaintext, 'utf8');
      if (digest.digest().toHex() !== envelope.forgeDigest) throw new Error('node-forge digest mismatch');
      const hmac = NodeForge.hmac.create();
      hmac.start('sha256', NodeForge.util.hexToBytes(forgeLabAESKey));
      hmac.update(envelope.expectedForgePlaintext);
      if (hmac.digest().toHex() !== envelope.forgeHmac) throw new Error('node-forge HMAC mismatch');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.url?.startsWith('/proxy-rules')) {
    if (request.headers['if-none-match'] === '"yakit-e2e-rules-v1"') {
      response.statusCode = 304;
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('etag', '"yakit-e2e-rules-v1"');
    response.end('[AutoProxy 0.2]\n@@||allowed.subscription.test^\n||blocked.subscription.test^\n');
    return;
  }
  if (request.url?.startsWith('/api/session')) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('x-yakit-e2e-response', 'captured');
      response.end(JSON.stringify({
        ok: true,
        receivedBytes: Buffer.concat(chunks).length,
        userAgent: request.headers['user-agent'] || '',
      }));
    });
    return;
  }
  if (request.url?.startsWith('/encrypt/rsa.php')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const ciphertext = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('data');
      if (!ciphertext) throw new Error('missing RSA form field data');
      const plaintext = decryptRSALabValue(ciphertext);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, plaintext }));
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.url?.startsWith('/crypto-lab/submit')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const signedValue = [envelope.timestamp, envelope.nonce, envelope.iv, envelope.ciphertext].join('.');
      const signatureValid = await webcrypto.subtle.verify(
        'HMAC', await cryptoLabHMACKey, Buffer.from(envelope.signature, 'base64'), Buffer.from(signedValue),
      );
      if (!signatureValid) throw new Error('invalid signature');
      const plaintext = await webcrypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: Buffer.from(envelope.iv, 'base64'),
        additionalData: Buffer.from(`${envelope.timestamp}:${envelope.nonce}`),
      }, await cryptoLabAESKey, Buffer.from(envelope.ciphertext, 'base64'));
      const payload = JSON.parse(Buffer.from(plaintext).toString('utf8'));
      if (payload.timestamp !== envelope.timestamp || payload.nonce !== envelope.nonce || typeof payload.password !== 'string') {
        throw new Error('invalid encrypted payload');
      }
      const responsePayload = Buffer.from(JSON.stringify({
        ok: true, account: payload.account, password: payload.password, nonce: payload.nonce,
      }));
      const responseIV = randomBytes(12);
      const responseCiphertext = await webcrypto.subtle.encrypt({
        name: 'AES-GCM',
        iv: responseIV,
        additionalData: Buffer.from(`response:${payload.nonce}`),
      }, await cryptoLabAESKey, responsePayload);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        nonce: payload.nonce,
        iv: responseIV.toString('base64'),
        ciphertext: Buffer.from(responseCiphertext).toString('base64'),
      }));
    } catch (error) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
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
  if (request.url?.startsWith('/recording-complete')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Recording Complete Dashboard</title></head><body><main><h1>Recording Complete Dashboard</h1><p>The login navigation completed in the same browser tab.</p></main></body></html>');
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
    </style></head><body><main><h1>Authenticated Security Console</h1><p>Local page for extension UI and main-world execution verification.</p><form><input name="account" value="analyst"><input name="token" value="redacted"><button type="button">Run check</button></form><section id="crypto-lab"><input id="crypto-password" value="initial-password"><button id="crypto-submit" type="button">Submit encrypted login</button><output id="crypto-result"></output></section><section id="opaque-module-lab" data-ready="false"><input id="opaque-module-input" value="module-initial"><button id="opaque-module-submit" type="button">Submit opaque module</button><output id="opaque-module-result"></output></section></main><script>
      window.app = { crypto: { encrypt(value) { return 'page:' + value; } } };
      (() => {
        if (!crypto.subtle) {
          document.querySelector('#crypto-lab').dataset.ready = 'unsupported';
          return;
        }
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const aesBytes = Uint8Array.from(${JSON.stringify([...cryptoLabAESBytes])});
        const hmacBytes = Uint8Array.from(${JSON.stringify([...cryptoLabHMACBytes])});
        const aesKeyPromise = crypto.subtle.importKey('raw', aesBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const hmacKeyPromise = crypto.subtle.importKey('raw', hmacBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const toBase64 = (value) => {
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return btoa(binary);
        };
        const fromBase64 = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
        async function buildLoginEnvelope(password, account = 'analyst') {
          const [aesKey, hmacKey] = await Promise.all([aesKeyPromise, hmacKeyPromise]);
          const timestamp = Date.now();
          const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
          const ivBytes = crypto.getRandomValues(new Uint8Array(12));
          const iv = toBase64(ivBytes);
          const plaintext = encoder.encode(JSON.stringify({ account, password, timestamp, nonce }));
          const ciphertext = toBase64(await crypto.subtle.encrypt({
            name: 'AES-GCM', iv: ivBytes, additionalData: encoder.encode(timestamp + ':' + nonce),
          }, aesKey, plaintext));
          const signedValue = [timestamp, nonce, iv, ciphertext].join('.');
          const signature = toBase64(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(signedValue)));
          return { timestamp, nonce, iv, ciphertext, signature };
        }
        async function openLoginResponse(envelope) {
          const aesKey = await aesKeyPromise;
          const plaintext = await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode('response:' + envelope.nonce),
          }, aesKey, fromBase64(envelope.ciphertext));
          return JSON.parse(decoder.decode(plaintext));
        }
        async function submitEncryptedLogin() {
          const password = document.querySelector('#crypto-password').value;
          const envelope = await buildLoginEnvelope(password);
          const response = await fetch('/crypto-lab/submit', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
          });
          document.querySelector('#crypto-result').textContent = JSON.stringify(await openLoginResponse(await response.json()));
        }
        document.querySelector('#crypto-submit').addEventListener('click', () => void submitEncryptedLogin());
        Promise.all([aesKeyPromise, hmacKeyPromise]).then(() => { document.querySelector('#crypto-lab').dataset.ready = 'true'; });
      })();
    </script><script type="module" src="${closureModulePath}"></script><iframe title="Billing frame" src="/frame-same"></iframe><iframe title="Account frame" src="http://localhost:${port}/frame-cross"></iframe></body></html>`);
});
const pageSocketServer = new WebSocketServer({ server, path: '/page-socket' });
pageSocketServer.on('connection', (socket) => socket.on('message', (message) => socket.send(`echo:${message.toString()}`)));
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/authenticated`;
const insecureTestUrl = `http://yakit-insecure.test:${address.port}/insecure`;

function installPageCryptoFixtures(publicKey) {
  window.CryptoJS = {
    SHA256(value) {
      return { sigBytes: 32, toString: () => `sha256:${value}` };
    },
  };
  if (typeof window.JSEncrypt !== 'function') throw new Error('The real JSEncrypt browser bundle did not install');
  window.__yakitRsa = new window.JSEncrypt();
  window.__yakitRsa.setPublicKey(publicKey);
  window.__yakitObserverOriginals = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    webSocket: window.WebSocket,
    worker: window.Worker,
    workerPostMessage: window.Worker?.prototype.postMessage,
    messageChannel: window.MessageChannel,
    messagePortPostMessage: window.MessagePort?.prototype.postMessage,
    sendBeacon: Navigator.prototype.sendBeacon,
    digest: Object.getPrototypeOf(crypto.subtle).digest,
    cryptoJsSha256: window.CryptoJS.SHA256,
    jsencryptEncrypt: window.JSEncrypt.prototype.encrypt,
    sm2Encrypt: window.sm2?.doEncrypt,
    sm3: window.sm3,
    sm4Encrypt: window.sm4?.encrypt,
    forgeCreateCipher: window.forge?.cipher.createCipher,
    forgePublicKeyFromPem: window.forge?.pki.publicKeyFromPem,
    forgeSha256Create: window.forge?.md.sha256.create,
    forgeHmacCreate: window.forge?.hmac.create,
  };
}

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

function nextBridgeResponse(socket, id, timeoutMs = 30_000) {
  return new Promise((resolveResponse, rejectResponse) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      rejectResponse(new Error(`Bridge response timed out: ${id}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolveResponse(message);
      } catch (error) {
        clearTimeout(timeout);
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
  });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 390, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('.popup-shell').waitFor();
  await popup.getByText('Authenticated Security Console', { exact: true }).waitFor();
  const popupBrandsLoaded = await popup.locator('.yak-mark, .yakit-mark').evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
  if (!popupBrandsLoaded) throw new Error('Popup brand assets did not load');
  await popup.locator('.popup-rail').waitFor();
  await popup.locator('.popup-brand-mark .yak-mark').waitFor();
  await popup.locator('.popup-engine-status').waitFor();
  await popup.screenshot({ path: resolve(artifacts, 'popup.png') });
  await popup.locator('.popup-engine-status').hover();
  await popup.getByText(/尚未配对引擎/).waitFor();

  await popup.getByRole('button', { name: '代理', exact: true }).click();
  await popup.locator('.popup-proxy-view').waitFor();
  await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ action: 'proxy.save', payload: {
      id: 'e2e-popup-proxy-a', name: 'E2E Proxy A', kind: 'fixed_servers', scheme: 'http',
      host: '127.0.0.1', port: 2080, bypass: [],
    } });
    if (!response?.ok) throw new Error(response?.error || 'Unable to create E2E Proxy A');
  });
  const siteProxySelect = popup.getByLabel('当前站点代理出口');
  await siteProxySelect.locator('option[value="e2e-popup-proxy-a"]').waitFor({ state: 'attached' });
  await siteProxySelect.selectOption('e2e-popup-proxy-a');
  await popup.locator('.popup-site-status.is-success').getByText('已应用 · E2E Proxy A', { exact: true }).waitFor();
  if (await popup.getByRole('button', { name: '保存', exact: true }).count()) {
    throw new Error('Popup site route still requires an explicit save button');
  }
  const popupSiteRoute = await popup.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ action: 'state.get' });
    const preview = await chrome.runtime.sendMessage({ action: 'proxy.rules.preview', payload: { url: location.href.replace('chrome-extension://', 'https://') } });
    return { state: state.data, preview };
  });
  const popupRouteRule = popupSiteRoute.state.proxyRules.find((rule) => rule.condition.type === 'host_exact' && rule.condition.value === '127.0.0.1');
  if (popupSiteRoute.state.activeProxyId !== 'auto' || popupRouteRule?.proxyProfileId !== 'e2e-popup-proxy-a') {
    throw new Error(`Popup site route did not select arbitrary proxy A: ${JSON.stringify(popupSiteRoute)}`);
  }
  await popup.locator('.popup-global-notice').waitFor({ state: 'detached' });
  await popup.waitForTimeout(120);
  const popupProxyBounds = await popup.evaluate(() => ({
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    shellTop: document.querySelector('.popup-shell')?.getBoundingClientRect().top,
    shellBottom: document.querySelector('.popup-shell')?.getBoundingClientRect().bottom,
  }));
  if (popupProxyBounds.scrollY !== 0 || popupProxyBounds.shellTop !== 0 || popupProxyBounds.shellBottom > popupProxyBounds.viewportHeight) {
    throw new Error(`Popup proxy escaped its viewport: ${JSON.stringify(popupProxyBounds)}`);
  }
  await popup.screenshot({ path: resolve(artifacts, 'popup-proxy.png') });
  const proxyOptionsPromise = context.waitForEvent('page');
  await popup.getByRole('button', { name: '打开代理策略', exact: true }).click();
  const proxyOptions = await proxyOptionsPromise;
  await proxyOptions.waitForLoadState('domcontentloaded');
  if (!proxyOptions.url().includes('/options.html') || !proxyOptions.url().endsWith('#rules')) {
    throw new Error(`Popup global action did not open proxy options: ${proxyOptions.url()}`);
  }
  await proxyOptions.close();
  await siteProxySelect.selectOption('__automatic__');
  await popup.locator('.popup-site-status.is-success').getByText('已恢复自动判断', { exact: true }).waitFor();
  const clearedPopupSiteRoute = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ action: 'state.get' })).data);
  if (clearedPopupSiteRoute.proxyRules.some((rule) => rule.condition.type === 'host_exact' && rule.condition.value === '127.0.0.1')) {
    throw new Error(`Popup site route reset left an exact override: ${JSON.stringify(clearedPopupSiteRoute.proxyRules)}`);
  }
  await popup.getByRole('button', { name: '运行概览', exact: true }).click();

  await popup.getByRole('button', { name: /Cookie Editor/ }).click();
  await popup.locator('.popup-cookie-view').waitFor();
  const popupSessionCookie = popup.locator('.popup-cookie-row').filter({ hasText: 'yakit_e2e_session' });
  await popupSessionCookie.waitFor();
  if (!(await popupSessionCookie.textContent()).includes('authenticated')) throw new Error('Popup Cookie Editor did not display the Cookie value directly');
  if (await popupSessionCookie.getByRole('button', { name: /显示|隐藏/ }).count()) {
    throw new Error('Popup Cookie Editor still renders a value visibility control');
  }
  await popup.getByRole('button', { name: '新增 Cookie' }).click();
  const popupCookieEditor = popup.locator('.popup-cookie-editor');
  await popupCookieEditor.locator('input').nth(0).fill('popup_e2e_cookie');
  await popupCookieEditor.locator('input').nth(1).fill('popup-cookie-value');
  await popup.getByRole('button', { name: '创建 Cookie' }).click();
  const popupCreatedCookie = popup.locator('.popup-cookie-row').filter({ hasText: 'popup_e2e_cookie' });
  await popupCreatedCookie.waitFor();
  await popupCreatedCookie.getByRole('button', { name: '删除 popup_e2e_cookie' }).click();
  await popupCreatedCookie.waitFor({ state: 'detached' });
  await popup.screenshot({ path: resolve(artifacts, 'popup-cookie-editor.png') });
  await popup.getByRole('button', { name: '运行概览' }).click();

  const requestUserAgent = async (source) => webPage.evaluate(async (requestSource) => {
    const response = await fetch(`/api/session?source=${encodeURIComponent(requestSource)}&nonce=${Date.now()}`);
    return (await response.json()).userAgent;
  }, source);
  const waitForRequestUserAgent = async (source, accept) => {
    let value = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      value = await requestUserAgent(`${source}-${attempt}`);
      if (accept(value)) return value;
      await webPage.waitForTimeout(100);
    }
    return value;
  };
  const browserDefaultUserAgent = await requestUserAgent('ua-default');
  await popup.getByRole('button', { name: 'User-Agent', exact: true }).click();
  await popup.locator('.popup-ua-view').waitFor();
  await popup.getByRole('radio', { name: /Chrome \/ Windows/ }).click();
  await popup.getByRole('button', { name: '应用并刷新' }).click();
  await popup.locator('.popup-ua-current > strong', { hasText: 'Chrome / Windows' }).waitFor();
  const chromeWindowsUserAgent = await waitForRequestUserAgent('ua-chrome-windows', (value) => (
    value.includes('Windows NT 10.0') && value.includes('Chrome/138')
  ));
  if (!chromeWindowsUserAgent.includes('Windows NT 10.0') || !chromeWindowsUserAgent.includes('Chrome/138')) {
    throw new Error(`Popup UA preset did not modify real request headers: ${chromeWindowsUserAgent}`);
  }
  await popup.getByRole('button', { name: '自定义…' }).click();
  const customUAEditor = popup.locator('.popup-ua-custom');
  await customUAEditor.locator('input').fill('Popup E2E Agent');
  await customUAEditor.locator('textarea').fill('Yakit-Popup-E2E/1.0');
  await popup.getByRole('button', { name: '保存、应用并刷新' }).click();
  await popup.locator('.popup-ua-current > strong', { hasText: 'Popup E2E Agent' }).waitFor();
  const customUserAgent = await waitForRequestUserAgent('ua-custom', (value) => value === 'Yakit-Popup-E2E/1.0');
  if (customUserAgent !== 'Yakit-Popup-E2E/1.0') throw new Error(`Popup custom UA did not apply: ${customUserAgent}`);
  await popup.screenshot({ path: resolve(artifacts, 'popup-user-agent.png') });
  await popup.getByRole('radio', { name: /浏览器默认/ }).click();
  await popup.getByRole('button', { name: '应用并刷新' }).click();
  await popup.locator('.popup-ua-current > strong', { hasText: '浏览器默认' }).waitFor();
  const restoredUserAgent = await waitForRequestUserAgent('ua-restored', (value) => value === browserDefaultUserAgent);
  if (restoredUserAgent !== browserDefaultUserAgent) throw new Error(`Popup UA reset did not restore browser default: ${restoredUserAgent}`);
  const customProfileCleanup = await popup.evaluate(async () => {
    const catalog = await chrome.runtime.sendMessage({ action: 'ua.catalog' });
    const profile = catalog.data?.find((item) => item.name === 'Popup E2E Agent');
    return profile ? await chrome.runtime.sendMessage({ action: 'ua.profile.delete', payload: { id: profile.id } }) : undefined;
  });
  if (customProfileCleanup && !customProfileCleanup.ok) throw new Error(`Could not remove Popup E2E UA profile: ${JSON.stringify(customProfileCleanup)}`);
  await popup.getByRole('button', { name: '运行概览' }).click();
  await webPage.addScriptTag({ path: jsencryptBrowserPath });
  await webPage.addScriptTag({ path: sm2BrowserPath });
  await webPage.addScriptTag({ path: sm3BrowserPath });
  await webPage.addScriptTag({ path: sm4BrowserPath });
  await webPage.addScriptTag({ path: nodeForgeBrowserPath });
  const cryptoLibraryShape = await webPage.evaluate(() => ({
    jsencrypt: typeof window.JSEncrypt,
    sm2: typeof window.sm2?.doEncrypt,
    sm3: typeof window.sm3,
    sm4: typeof window.sm4?.encrypt,
    forgeCipher: typeof window.forge?.cipher?.createCipher,
    forgePki: typeof window.forge?.pki?.publicKeyFromPem,
  }));
  if (Object.values(cryptoLibraryShape).some((kind) => kind !== 'function')) {
    throw new Error(`Real browser crypto libraries did not install after the UA reload tests: ${JSON.stringify(cryptoLibraryShape)}`);
  }
  await webPage.evaluate(installPageCryptoFixtures, rsaLabPublicKey);
  await webPage.evaluate(() => {
    history.pushState({ source: 'e2e-after-ua' }, '', '/authenticated?spa=ua-restored');
    history.replaceState({ source: 'e2e' }, '', '/authenticated?spa=inventory');
  });

  const options = await context.newPage();
  await options.setViewportSize({ width: 1440, height: 900 });
  await options.goto(`chrome-extension://${extensionId}/options.html?tabId=${targetTab.id}#overview`);
  await options.locator('.app-shell').waitFor();
  await options.getByText('常用工具', { exact: true }).waitFor();
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
  const cookieValue = options.locator('.cookie-value').filter({ hasText: 'authenticated' }).first();
  await cookieValue.waitFor();
  if (await options.getByTitle(/显示 Cookie 值|隐藏 Cookie 值/).count()) throw new Error('Cookie Editor still renders value visibility controls');
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
  await options.getByRole('button', { name: 'UA 快速切换' }).click();
  await options.getByRole('heading', { name: 'User-Agent 快速切换' }).waitFor();
  await options.getByText('每个 hostname 只保留一个生效预设', { exact: true }).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-user-agent.png') });
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
  const proxyRuleChecks = await options.evaluate(async ({ url, sourceUrl }) => {
    const send = async (action, payload) => {
      const response = await chrome.runtime.sendMessage({ action, payload });
      if (!response?.ok) throw new Error(response?.error || action);
      return response.data;
    };
    const now = Date.now();
    const directRule = { id: 'e2e-direct-rule', name: 'E2E direct', enabled: true, condition: { type: 'host_exact', value: '127.0.0.1' }, proxyProfileId: 'direct', order: 0, createdAt: now, updatedAt: now };
    const mitmRule = { id: 'e2e-mitm-rule', name: 'E2E MITM', enabled: true, condition: { type: 'host_exact', value: '127.0.0.1' }, proxyProfileId: 'yakit-mitm', order: 1, createdAt: now, updatedAt: now };
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
    const savedSource = await send('proxy.source.save', {
      name: 'E2E AutoProxy subscription', url: sourceUrl, format: 'auto', enabled: true,
      matchProfileId: 'yakit-mitm', bypassProfileId: 'direct', updateIntervalMinutes: 60,
    });
    const refreshedSourceState = await send('proxy.source.refresh', { id: savedSource.id });
    const sourcePage = await send('proxy.source.rules', { id: savedSource.id, offset: 0, limit: 100 });
    const blockedPreview = await send('proxy.rules.preview', { url: 'https://blocked.subscription.test/path' });
    const allowedPreview = await send('proxy.rules.preview', { url: 'https://allowed.subscription.test/path' });
    const configuration = await send('proxy.config.export');
    const imported = await send('proxy.config.import', { configuration });
    const applied = await send('proxy.auto.apply');
    return { firstPreview, secondPreview, blockedPreview, allowedPreview, pac, auth, authStatus, applied, sourcePage, refreshedSources: refreshedSourceState.proxyRuleSources, reordered: reordered.proxyRules, imported: imported.proxyRouting, configuration };
  }, { url: testUrl, sourceUrl: new URL('/proxy-rules', testUrl).toString() });
  if (proxyRuleChecks.firstPreview.matchedRuleId !== 'e2e-direct-rule' || proxyRuleChecks.firstPreview.effectiveProfileId !== 'direct' || proxyRuleChecks.secondPreview.effectiveProfileId !== 'yakit-mitm') {
    throw new Error(`Proxy deterministic order/preview failed: ${JSON.stringify(proxyRuleChecks)}`);
  }
  if (!proxyRuleChecks.pac.pacScript.includes('PROXY 127.0.0.1:8083; DIRECT') || !proxyRuleChecks.auth.configured || !proxyRuleChecks.authStatus.configured || proxyRuleChecks.applied.activeProxyId !== 'auto') {
    throw new Error(`Proxy PAC/fail-open/auth failed: ${JSON.stringify(proxyRuleChecks)}`);
  }
  if (proxyRuleChecks.sourcePage.total !== 2 || proxyRuleChecks.blockedPreview.effectiveProfileId !== 'yakit-mitm'
    || proxyRuleChecks.allowedPreview.effectiveProfileId !== 'direct' || !proxyRuleChecks.configuration.sources[0]?.content?.includes('[AutoProxy 0.2]')) {
    throw new Error(`Proxy subscription/IndexedDB/config exchange failed: ${JSON.stringify(proxyRuleChecks)}`);
  }
  await options.getByRole('button', { name: '自动切换' }).click();
  await options.getByRole('heading', { name: '自动切换' }).waitFor();
  await options.getByText('配置与浏览器一致', { exact: true }).waitFor();
  await options.waitForTimeout(350);
  await options.screenshot({ path: resolve(artifacts, 'options-auto-switch.png') });
  await options.getByRole('button', { name: '规则订阅' }).click();
  await options.getByRole('heading', { name: '规则订阅' }).waitFor();
  await options.getByRole('heading', { name: 'E2E AutoProxy subscription' }).waitFor();
  await options.getByText('规范化规则', { exact: true }).waitFor();
  await options.waitForTimeout(350);
  await options.screenshot({ path: resolve(artifacts, 'options-rule-sources.png') });
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
          'browser.recording.read', 'browser.recording.control',
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
          'browser.recording.read', 'browser.recording.control',
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
  const recordingStart = await callBridge(bridgeSocket, 'verify-recording-start', 'browser.recording.start', {
    tabId: targetTab.id,
    captureValues: false,
    maxEntries: 200,
  });
  if (recordingStart.error || recordingStart.result?.status?.active !== true) {
    throw new Error(`Browser recording did not start: ${JSON.stringify(recordingStart)}`);
  }
  await webPage.evaluate(async (socketPort) => {
    const form = document.querySelector('form');
    form.addEventListener('submit', (event) => event.preventDefault(), { once: true });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const linkedValue = window.CryptoJS.SHA256('recorder-linked-secret-171').toString();
    await fetch('/api/session?source=recorder-linked-fetch', { method: 'POST', body: linkedValue });
    const formLinkedValue = window.CryptoJS.SHA256('recorder-form-linked-secret-181').toString();
    await fetch('/api/session?source=recorder-form-linked-fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ encryptedData: formLinkedValue, channel: 'browser' }),
    });
    const rsaPlaintext = JSON.stringify({ username: 'recorder-rsa-admin-191', password: 'recorder-rsa-password-192' });
    const rsaCiphertext = window.__yakitRsa.encrypt(rsaPlaintext);
    const rsaResponse = await fetch('/encrypt/rsa.php?source=recorder-rsa-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: rsaCiphertext }),
    });
    const rsaValidation = await rsaResponse.json();
    if (!rsaValidation.ok || rsaValidation.plaintext !== rsaPlaintext) {
      throw new Error(`Independent RSA server rejected the browser ciphertext: ${JSON.stringify(rsaValidation)}`);
    }
    await new Promise((resolveRequest, rejectRequest) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/session?source=recorder-xhr');
      request.onload = resolveRequest;
      request.onerror = rejectRequest;
      request.send('recorder-xhr-secret-272');
    });
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('recorder-webcrypto-secret-373'));
    await new Promise((resolveSocket, rejectSocket) => {
      const socket = new WebSocket(`ws://127.0.0.1:${socketPort}/page-socket`);
      socket.onopen = () => socket.send('recorder-websocket-secret-575');
      socket.onmessage = () => socket.close();
      socket.onclose = resolveSocket;
      socket.onerror = rejectSocket;
    });
    const marker = document.createElement('button');
    marker.textContent = 'Worker boundary holdout';
    document.body.append(marker);
    marker.click();
    marker.remove();
    await new Promise((resolveWorker, rejectWorker) => {
      const worker = new Worker('/opaque-worker.js?chunk=randomized-811');
      worker.addEventListener('message', async (event) => {
        try {
          const response = await fetch('/opaque-worker-submit?route=randomized-812', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event.data),
          });
          const result = await response.json();
          worker.terminate();
          if (!result.ok) throw new Error(JSON.stringify(result));
          resolveWorker();
        } catch (error) { rejectWorker(error); }
      }, { once: true });
      worker.addEventListener('error', rejectWorker, { once: true });
      worker.postMessage({ marker: 'worker-boundary-holdout-811', nested: { value: 812 } });
    });
    await new Promise((resolveMessage) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolveMessage(); };
      channel.port2.postMessage({ marker: 'message-port-boundary-813' });
    });
    if (!navigator.sendBeacon('/beacon-boundary?route=randomized-814', 'beacon-boundary-value-814')) {
      throw new Error('sendBeacon rejected the E2E boundary payload');
    }
  }, address.port);
  await webPage.evaluate(async ({
    smPublicKey, smPrivateKey, sm4Key, sm4IV, forgePublicKey, forgeAesKey, forgeAesIV,
  }) => {
    const marker = document.createElement('button');
    marker.textContent = 'Semantic adapter holdout';
    document.body.append(marker);
    marker.click();
    marker.remove();

    const expectedSMPlaintext = 'semantic-sm-plaintext-821';
    const sm2Ciphertext = window.sm2.doEncrypt(expectedSMPlaintext, smPublicKey, 1);
    const sm2Signature = window.sm2.doSignature(expectedSMPlaintext, smPrivateKey);
    const sm3Digest = window.sm3(expectedSMPlaintext);
    const sm4Ciphertext = window.sm4.encrypt(expectedSMPlaintext, sm4Key, { mode: 'cbc', iv: sm4IV });
    if (window.sm2.doDecrypt(sm2Ciphertext, smPrivateKey, 1) !== expectedSMPlaintext
      || !window.sm2.doVerifySignature(expectedSMPlaintext, sm2Signature, smPublicKey)
      || window.sm4.decrypt(sm4Ciphertext, sm4Key, { mode: 'cbc', iv: sm4IV }) !== expectedSMPlaintext) {
      throw new Error('Browser sm-crypto self verification failed');
    }

    const expectedForgePlaintext = 'semantic-forge-plaintext-822';
    const cipher = window.forge.cipher.createCipher('AES-CBC', window.forge.util.hexToBytes(forgeAesKey));
    cipher.start({ iv: window.forge.util.hexToBytes(forgeAesIV) });
    cipher.update(window.forge.util.createBuffer(expectedForgePlaintext, 'utf8'));
    if (!cipher.finish()) throw new Error('Browser node-forge AES encryption failed');
    const forgeAesCiphertext = cipher.output.toHex();
    const publicKey = window.forge.pki.publicKeyFromPem(forgePublicKey);
    const forgeRsaCiphertext = window.forge.util.encode64(publicKey.encrypt(
      expectedForgePlaintext, 'RSAES-PKCS1-V1_5',
    ));
    const digest = window.forge.md.sha256.create();
    digest.update(expectedForgePlaintext, 'utf8');
    const forgeDigest = digest.digest().toHex();
    const hmac = window.forge.hmac.create();
    hmac.start('sha256', window.forge.util.hexToBytes(forgeAesKey));
    hmac.update(expectedForgePlaintext);
    const forgeHmac = hmac.digest().toHex();

    const response = await fetch('/semantic-adapter-submit?route=randomized-823', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedSMPlaintext, sm2Ciphertext, sm2Signature, sm3Digest, sm4Ciphertext,
        expectedForgePlaintext, forgeAesCiphertext, forgeRsaCiphertext, forgeDigest, forgeHmac,
      }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Independent semantic adapter server rejected the envelope: ${JSON.stringify(result)}`);
  }, {
    smPublicKey: smLabKeyPair.publicKey,
    smPrivateKey: smLabKeyPair.privateKey,
    sm4Key: smLabSM4Key,
    sm4IV: smLabSM4IV,
    forgePublicKey: rsaLabPublicKey,
    forgeAesKey: forgeLabAESKey,
    forgeAesIV: forgeLabAESIV,
  });
  await webPage.locator('#opaque-module-lab[data-ready="true"]').waitFor();
  await webPage.locator('#opaque-module-input').fill(closureInitialMarker);
  await webPage.locator('#opaque-module-submit').click();
  await webPage.locator('#opaque-module-result').getByText(closureInitialMarker, { exact: true }).waitFor();
  await webPage.locator('#crypto-lab[data-ready="true"]').waitFor();
  await webPage.locator('#crypto-password').fill('recorder-webcrypto-envelope-474');
  await webPage.locator('#crypto-submit').click();
  await webPage.locator('#crypto-result').getByText('recorder-webcrypto-envelope-474').waitFor();
  const recordingSnapshot = await callBridge(bridgeSocket, 'verify-recording-get', 'browser.recording.get', { tabId: targetTab.id, limit: 200 });
  const observedKinds = new Set(recordingSnapshot.result?.events?.map((item) => item.kind));
  for (const kind of ['fetch', 'xhr', 'form', 'beacon', 'worker', 'message', 'websocket', 'crypto']) {
    if (!observedKinds.has(kind)) throw new Error(`Browser recording missed ${kind}: ${JSON.stringify(recordingSnapshot)}`);
  }
  const workerSendEvent = recordingSnapshot.result?.events?.find((item) => item.kind === 'worker' && item.operation === 'worker.postMessage');
  const workerReceiveEvent = recordingSnapshot.result?.events?.find((item) => item.kind === 'worker' && item.operation === 'worker.message');
  const workerRequestEvent = recordingSnapshot.result?.events?.find((item) => item.kind === 'fetch' && item.url?.includes('/opaque-worker-submit'));
  if (!workerSendEvent?.wrapperHandleId || !workerReceiveEvent || workerSendEvent.channelId !== workerReceiveEvent.channelId
    || workerSendEvent.traceId !== workerReceiveEvent.traceId
    || !recordingSnapshot.result?.links?.some((item) => item.kind === 'channel' && item.fromEventId === workerSendEvent.id && item.toEventId === workerReceiveEvent.id)) {
    throw new Error(`Worker boundary did not retain its exact handle and async Trace correlation: ${JSON.stringify(recordingSnapshot)}`);
  }
  const unknownBoundaryCandidate = recordingSnapshot.result?.profileCandidates?.find((candidate) => (
    candidate.request.eventId === workerRequestEvent?.id && candidate.source.operation === 'unknown-business-envelope'
  ));
  if (!unknownBoundaryCandidate || unknownBoundaryCandidate.status !== 'capture-required') {
    throw new Error(`Unknown Worker/ESM boundary did not remain actionable: ${JSON.stringify(recordingSnapshot)}`);
  }
  const observedCryptoProviders = new Set(recordingSnapshot.result?.events
    ?.filter((item) => item.kind === 'crypto')
    .map((item) => item.crypto?.adapterId));
  for (const provider of ['webcrypto', 'cryptojs', 'jsencrypt', 'sm-crypto', 'node-forge']) {
    if (!observedCryptoProviders.has(provider)) {
      throw new Error(`Browser recording missed the ${provider} crypto adapter: ${JSON.stringify(recordingSnapshot)}`);
    }
  }
  const smOperations = new Set(recordingSnapshot.result?.events
    ?.filter((item) => item.kind === 'crypto' && item.crypto?.adapterId === 'sm-crypto')
    .map((item) => item.crypto?.operation));
  for (const operation of ['sm2.encrypt', 'sm2.decrypt', 'sm2.sign', 'sm2.verify', 'sm3.digest', 'sm4.encrypt', 'sm4.decrypt']) {
    if (!smOperations.has(operation)) throw new Error(`Real sm-crypto fixture missed ${operation}: ${JSON.stringify(recordingSnapshot)}`);
  }
  const forgeEvents = recordingSnapshot.result?.events
    ?.filter((item) => item.kind === 'crypto' && item.crypto?.adapterId === 'node-forge') || [];
  for (const phase of ['create', 'init', 'update', 'final']) {
    if (!forgeEvents.some((item) => item.crypto?.state?.phase === phase && item.crypto?.state?.correlationId)) {
      throw new Error(`Real node-forge fixture missed correlated ${phase} state: ${JSON.stringify(recordingSnapshot)}`);
    }
  }
  if (!forgeEvents.some((item) => item.crypto?.operation === 'rsa.encrypt' && item.callHandleId && item.callableCapable)
    || !forgeEvents.some((item) => item.crypto?.operation === 'cipher.encrypt.output.toHex')) {
    throw new Error(`Real node-forge fixture missed RSA callable or cipher output boundary: ${JSON.stringify(recordingSnapshot)}`);
  }
  const linkedCryptoEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'crypto' && item.crypto?.adapterId === 'cryptojs' && item.crypto?.operation === 'SHA256'
  ));
  const webCryptoEncryptEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'crypto' && item.crypto?.adapterId === 'webcrypto'
      && item.crypto?.operation === 'encrypt' && item.wrapperHandleId
  ));
  const webCryptoDecryptEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'crypto' && item.crypto?.adapterId === 'webcrypto'
      && item.crypto?.operation === 'decrypt' && item.wrapperHandleId
  ));
  const closureRequestEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'fetch' && item.url?.includes(closureSubmitPath)
  ));
  const webCryptoDigestEvents = recordingSnapshot.result?.events?.filter((item) => (
    item.kind === 'crypto' && item.crypto?.adapterId === 'webcrypto'
      && item.crypto?.operation === 'digest' && item.wrapperHandleId
  )) || [];
  const webCryptoDigestEvent = webCryptoDigestEvents.find((item) => item.scriptUrl?.includes(closureModulePath))
    || webCryptoDigestEvents[0];
  const exactValueLinks = recordingSnapshot.result?.links?.filter((item) => (
    item.kind === 'value' && item.confidence === 'exact'
  )) || [];
  const closureReachableEvents = new Set(webCryptoDigestEvent ? [webCryptoDigestEvent.id] : []);
  for (let pass = 0; pass < exactValueLinks.length; pass += 1) {
    let changed = false;
    for (const link of exactValueLinks) {
      if (closureReachableEvents.has(link.fromEventId) && !closureReachableEvents.has(link.toEventId)) {
        closureReachableEvents.add(link.toEventId);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const closureDigestLink = recordingSnapshot.result?.links?.find((item) => (
    closureReachableEvents.has(item.fromEventId)
      && item.toEventId === closureRequestEvent?.id
      && item.toPath === `$body:json.${closureDigestField}`
      && item.kind === 'value'
      && item.confidence === 'exact'
  ));
  if (!linkedCryptoEvent?.wrapperHandleId || !webCryptoEncryptEvent?.wrapperHandleId
    || !webCryptoDecryptEvent?.wrapperHandleId || !webCryptoDigestEvent?.wrapperHandleId) {
    throw new Error(`Recording did not retain exact crypto wrapper handles: ${JSON.stringify({
      linkedCryptoEvent,
      webCryptoEncryptEvent,
      webCryptoDecryptEvent,
      webCryptoDigestEvents,
      cryptoOperations: recordingSnapshot.result?.events?.filter((item) => item.kind === 'crypto')
        .map((item) => `${item.crypto?.adapterId}:${item.crypto?.operation}:${Boolean(item.wrapperHandleId)}`),
    })}`);
  }
  if (!closureRequestEvent || !closureDigestLink) {
    throw new Error(`Randomized ESM/WASM holdout did not use the generic evidence graph: ${JSON.stringify({
      closureSubmitPath,
      closureDigestField,
      request: closureRequestEvent,
      digests: webCryptoDigestEvents,
      links: recordingSnapshot.result?.links?.filter((item) => item.toEventId === closureRequestEvent?.id),
    })}`);
  }
  const linkedFetchEvent = recordingSnapshot.result?.events?.find((item) => item.kind === 'fetch' && item.url?.includes('recorder-linked-fetch'));
  if (!linkedCryptoEvent || !linkedFetchEvent || !recordingSnapshot.result?.links?.some((link) => link.fromEventId === linkedCryptoEvent.id && link.toEventId === linkedFetchEvent.id)) {
    throw new Error(`Recording did not link CryptoJS output to Fetch input: ${JSON.stringify(recordingSnapshot)}`);
  }
  if (!recordingSnapshot.result?.traces?.some((trace) => trace.eventIds.includes(linkedCryptoEvent.id) && trace.eventIds.includes(linkedFetchEvent.id))) {
    throw new Error(`Linked events were not grouped into one business Trace: ${JSON.stringify(recordingSnapshot)}`);
  }
  const inferredProfile = recordingSnapshot.result?.profileCandidates?.find((candidate) => (
    candidate.source?.eventId === linkedCryptoEvent.id && candidate.request?.eventId === linkedFetchEvent.id
  ));
  if (inferredProfile?.status !== 'ready'
    || inferredProfile.request?.destination !== 'body'
    || inferredProfile.request?.serialization !== 'raw-body'
    || inferredProfile.confidence?.level !== 'high'
    || inferredProfile.source?.arguments?.[0]?.role !== 'data'
    || inferredProfile.aiContext?.valuePolicy !== 'metadata-only') {
    throw new Error(`Recording did not infer a safe high-confidence Profile candidate: ${JSON.stringify(recordingSnapshot)}`);
  }
  const formLinkedFetchEvent = recordingSnapshot.result?.events?.find((item) => item.kind === 'fetch' && item.url?.includes('recorder-form-linked-fetch'));
  const formFieldLink = recordingSnapshot.result?.links?.find((link) => (
    link.toEventId === formLinkedFetchEvent?.id && link.toPath === '$body:form.encryptedData'
  ));
  const formLinkedCandidate = recordingSnapshot.result?.profileCandidates?.find((candidate) => (
    candidate.source?.eventId === formFieldLink?.fromEventId && candidate.request?.eventId === formLinkedFetchEvent?.id
  ));
  if (!formLinkedFetchEvent || !formFieldLink || formLinkedCandidate?.request?.destination !== 'body.encryptedData'
    || formLinkedCandidate?.request?.serialization !== 'form-field'
    || formLinkedCandidate?.status !== 'ready' || formLinkedCandidate?.confidence?.level !== 'high') {
    throw new Error(`Recording did not preserve the generic form field value chain: ${JSON.stringify(recordingSnapshot)}`);
  }
  const rsaCryptoEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'crypto' && item.crypto?.adapterId === 'jsencrypt' && item.crypto?.operation === 'encrypt'
  ));
  const rsaRequestEvent = recordingSnapshot.result?.events?.find((item) => (
    item.kind === 'fetch' && item.url?.includes('/encrypt/rsa.php?source=recorder-rsa-profile')
  ));
  const rsaFieldLink = recordingSnapshot.result?.links?.find((link) => (
    link.fromEventId === rsaCryptoEvent?.id
      && link.toEventId === rsaRequestEvent?.id
      && link.toPath === '$body:form.data'
  ));
  const rsaCandidate = recordingSnapshot.result?.profileCandidates?.find((candidate) => (
    candidate.source?.eventId === rsaCryptoEvent?.id && candidate.request?.eventId === rsaRequestEvent?.id
  ));
  if (!rsaCryptoEvent || !rsaRequestEvent || !rsaFieldLink
    || rsaCryptoEvent.crypto?.family !== 'asymmetric'
    || rsaCryptoEvent.crypto?.padding !== 'PKCS1-v1_5'
    || rsaCryptoEvent.crypto?.key?.kind !== 'public'
    || rsaCryptoEvent.crypto?.key?.bits !== 1024
    || !rsaCryptoEvent.crypto?.key?.fingerprint
    || rsaCandidate?.status !== 'ready'
    || rsaCandidate.request?.destination !== 'body.data'
    || rsaCandidate.request?.serialization !== 'form-field') {
    throw new Error(`JSEncrypt RSA was not inferred as an executable form-field Profile: ${JSON.stringify(recordingSnapshot)}`);
  }
  const rsaAIContext = JSON.stringify(rsaCandidate.aiContext);
  if (rsaAIContext.includes('BEGIN PUBLIC KEY') || rsaAIContext.includes(rsaLabPublicModulusHex)) {
    throw new Error(`JSEncrypt inference leaked raw public-key material: ${rsaAIContext}`);
  }
  const redactedRecording = JSON.stringify(recordingSnapshot.result);
  for (const secret of ['recorder-linked-secret-171', 'recorder-form-linked-secret-181', 'recorder-rsa-admin-191', 'recorder-rsa-password-192', 'recorder-xhr-secret-272', 'recorder-webcrypto-secret-373', 'recorder-webcrypto-envelope-474', 'recorder-websocket-secret-575', 'worker-boundary-holdout-811', 'message-port-boundary-813', 'beacon-boundary-value-814', closureInitialMarker, 'BEGIN PUBLIC KEY']) {
    if (redactedRecording.includes(secret)) throw new Error(`Metadata-only recording leaked a value: ${secret}`);
  }
  for (const keyMaterial of [smLabKeyPair.privateKey, smLabSM4Key, forgeLabAESKey, 'semantic-sm-plaintext-821', 'semantic-forge-plaintext-822', 'BEGIN PRIVATE KEY']) {
    if (redactedRecording.includes(keyMaterial)) throw new Error('Metadata-only recording leaked semantic adapter key material or plaintext');
  }
  const deniedSensitiveRecording = await callBridge(bridgeSocket, 'verify-recording-sensitive-denied', 'browser.recording.start', {
    tabId: targetTab.id,
    captureValues: true,
  });
  if (!deniedSensitiveRecording.error?.message?.includes('browser.recording.sensitive.read')) {
    throw new Error(`Recording value capture did not require its sensitive scope: ${JSON.stringify(deniedSensitiveRecording)}`);
  }
  await callBridge(bridgeSocket, 'verify-recording-stop-metadata', 'browser.recording.stop', { tabId: targetTab.id });
  await options.evaluate(async ({ tabId, frameIds }) => {
    const response = await chrome.runtime.sendMessage({
      action: 'grant.create',
      payload: {
        targets: [{ tabId, frameId: 0 }, ...frameIds.map((frameId) => ({ tabId, frameId }))],
        scopes: [
          'browser.tabs.read', 'browser.dom.read', 'browser.storage.read', 'browser.cookies.read',
          'browser.dom.write', 'browser.tab.activate', 'browser.page.invoke', 'browser.page.eval.expression', 'browser.page.eval.program', 'browser.human.takeover',
          'browser.network.read', 'browser.network.capture', 'browser.network.sensitive.read',
          'browser.recording.read', 'browser.recording.control', 'browser.recording.sensitive.read', 'browser.callable.execute',
          'browser.debugger.read', 'browser.debugger.control',
          'browser.transform.read', 'browser.transform.manage', 'browser.transform.execute',
          'browser.proxy.read', 'browser.proxy.write',
        ],
        durationMinutes: 5,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'grant.create recording sensitive');
  }, { tabId: targetTab.id, frameIds: [sameOriginFrame.frameId, crossOriginFrame.frameId] });
  const sensitiveRecordingStart = await callBridge(bridgeSocket, 'verify-recording-sensitive-start', 'browser.recording.start', {
    tabId: targetTab.id,
    captureValues: true,
  });
  if (sensitiveRecordingStart.error) throw new Error(`Sensitive browser recording did not start: ${JSON.stringify(sensitiveRecordingStart)}`);
  const programEval = await callBridge(bridgeSocket, 'verify-program-eval', 'browser.eval', {
    tabId: targetTab.id,
    mode: 'program',
    code: 'const programValue = 41; return programValue + 1',
  });
  if (programEval.error || programEval.result?.value !== 42) throw new Error(`Program Eval scope did not execute: ${JSON.stringify(programEval)}`);
  await webPage.evaluate(() => {
    window.CryptoJS.SHA256('recorder-sensitive-preview-686');
    window.__yakitRsa.encrypt(JSON.stringify({ username: 'sensitive-rsa-admin-687', password: 'sensitive-rsa-password-688' }));
  });
  const sensitiveRecording = await callBridge(bridgeSocket, 'verify-recording-sensitive-get', 'browser.recording.get', { tabId: targetTab.id });
  if (!JSON.stringify(sensitiveRecording.result).includes('recorder-sensitive-preview-686')) {
    throw new Error(`Explicit recording value capture did not return its bounded preview: ${JSON.stringify(sensitiveRecording)}`);
  }
  const callableSource = sensitiveRecording.result?.events?.find((item) => (
    item.kind === 'crypto'
      && item.crypto?.adapterId === 'jsencrypt'
      && item.crypto?.operation === 'encrypt'
      && item.callHandleId
      && item.callableCapable
  ));
  if (!callableSource) throw new Error(`Sensitive recording did not retain an executable JSEncrypt call handle: ${JSON.stringify(sensitiveRecording)}`);
  const createdCallable = await callBridge(bridgeSocket, 'verify-callable-create', 'browser.callable.create', {
    tabId: targetTab.id,
    source: 'recording',
    callHandleId: callableSource.callHandleId,
    name: 'E2E JSEncrypt RSA Callable',
  });
  if (createdCallable.error || !createdCallable.result?.id) throw new Error(`Could not create a recorded page callable: ${JSON.stringify(createdCallable)}`);
  await callBridge(bridgeSocket, 'verify-recording-stop-sensitive', 'browser.recording.stop', { tabId: targetTab.id });
  const replayedCallable = await callBridge(bridgeSocket, 'verify-callable-execute-after-stop', 'browser.callable.execute', {
    tabId: targetTab.id,
    callableId: createdCallable.result.id,
    args: [{ username: 'callable-rsa-admin-797', password: 'callable-rsa-password-798' }],
  });
  const replayedRsaPlaintext = replayedCallable.result?.value
    ? decryptRSALabValue(replayedCallable.result.value)
    : undefined;
  const replayedRsaPayload = replayedRsaPlaintext ? JSON.parse(replayedRsaPlaintext) : undefined;
  if (replayedCallable.error
    || replayedRsaPayload?.username !== 'callable-rsa-admin-797'
    || replayedRsaPayload?.password !== 'callable-rsa-password-798') {
    throw new Error(`Document-bound JSEncrypt callable lost its receiver or input adaptation after recording stopped: ${JSON.stringify({ replayedCallable, replayedRsaPlaintext, replayedRsaPayload })}`);
  }

  await webPage.evaluate(() => {
    window.sendDigestWithNetwork = function sendDigestWithNetwork(value) {
      const encryptedData = window.CryptoJS.SHA256(value).toString();
      return fetch('/api/session?source=deep-risk-classification', {
        method: 'POST',
        body: encryptedData,
      });
    };
  });
  const riskyCaptureStart = await callBridge(bridgeSocket, 'verify-risky-capture-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: linkedCryptoEvent.crypto.adapterId,
      operation: linkedCryptoEvent.crypto.operation,
      wrapperHandleId: linkedCryptoEvent.wrapperHandleId,
    },
  });
  if (riskyCaptureStart.error || riskyCaptureStart.result?.state !== 'armed') {
    throw new Error(`Side-effect classification capture did not arm: ${JSON.stringify(riskyCaptureStart)}`);
  }
  await webPage.evaluate(() => setTimeout(() => void window.sendDigestWithNetwork('risk-classification-value'), 50));
  let riskyPause;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const next = await callBridge(bridgeSocket, `verify-risky-capture-status-${attempt}`, 'browser.deep_capture.status', { tabId: targetTab.id });
    if (next.error) throw new Error(`Side-effect classification status failed: ${JSON.stringify(next)}`);
    if (next.result?.state === 'paused') {
      riskyPause = next.result;
      await callBridge(bridgeSocket, `verify-risky-capture-keepalive-${attempt}`, 'browser.deep_capture.keepalive', { tabId: targetTab.id });
      const frame = riskyPause.pause?.frames?.find((item) => item.functionName === 'sendDigestWithNetwork');
      if (frame?.functionInspection) break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const riskyFrame = riskyPause?.pause?.frames?.find((frame) => frame.functionName === 'sendDigestWithNetwork');
  if (riskyFrame?.sourceKind !== 'page' || !riskyFrame.functionInspection?.resolved || !riskyFrame.functionInspection.riskFlags?.includes('network')) {
    throw new Error(`Network side effect was not classified on the business frame: ${JSON.stringify(riskyPause)}`);
  }
  if (riskyPause.pause?.automaticCapture?.state !== 'blocked') {
    throw new Error(`A network-sending business function was not blocked from automatic capture: ${JSON.stringify(riskyPause)}`);
  }
  const blockedRiskyCallable = await callBridge(bridgeSocket, 'verify-risky-callable-blocked', 'browser.callable.create', {
    tabId: targetTab.id,
    source: 'deep-capture',
    strategy: 'selected-frame',
    callFrameId: riskyFrame.id,
  });
  if (blockedRiskyCallable.error?.code !== 'callable_capture_blocked') {
    throw new Error(`Side-effect gate allowed a network-sending callable: ${JSON.stringify(blockedRiskyCallable)}`);
  }
  await callBridge(bridgeSocket, 'verify-risky-capture-resume', 'browser.deep_capture.resume', { tabId: targetTab.id });
  await callBridge(bridgeSocket, 'verify-risky-capture-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });

  const closureIsNotGlobal = await webPage.evaluate((functionName) => (
    typeof window[functionName] === 'undefined'
  ), closureFunctionName);
  if (!closureIsNotGlobal) throw new Error('The randomized ESM holdout accidentally exposed its business function globally');
  await webPage.locator('#opaque-module-input').fill(closureReplayMarker);
  const closureCaptureStart = await callBridge(bridgeSocket, 'verify-closure-capture-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: webCryptoDigestEvent.crypto.adapterId,
      operation: webCryptoDigestEvent.crypto.operation,
      wrapperHandleId: webCryptoDigestEvent.wrapperHandleId,
    },
  });
  if (closureCaptureStart.error || closureCaptureStart.result?.state !== 'armed') {
    throw new Error(`Randomized ESM/WASM closure capture did not arm: ${JSON.stringify(closureCaptureStart)}`);
  }
  await webPage.evaluate(() => {
    setTimeout(() => document.querySelector('#opaque-module-submit').click(), 50);
  });
  let closurePause;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = await callBridge(bridgeSocket, `verify-closure-capture-status-${attempt}`, 'browser.deep_capture.status', { tabId: targetTab.id });
    if (next.error) throw new Error(`Randomized ESM/WASM capture status failed: ${JSON.stringify(next)}`);
    if (next.result?.state === 'paused') {
      closurePause = next.result;
      await callBridge(bridgeSocket, `verify-closure-capture-keepalive-${attempt}`, 'browser.deep_capture.keepalive', { tabId: targetTab.id });
      const frame = closurePause.pause?.frames?.find((item) => item.functionName === closureFunctionName);
      if (!closurePause.pause?.collecting && frame?.functionInspection) break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const closureFrame = closurePause?.pause?.frames?.find((frame) => frame.functionName === closureFunctionName);
  const closureVariables = closureFrame?.scopes?.flatMap((scope) => scope.variables) || [];
  if (!closureFrame || closureFrame.sourceKind !== 'page' || !closureFrame.url.includes(closureModulePath)
    || !closureFrame.functionInspection?.resolved || closureFrame.functionInspection.riskFlags?.length
    || !closureVariables.some((variable) => variable.name === 'instance')
    || closurePause.pause?.recommendedFrameId !== closureFrame.id
    || closurePause.pause?.automaticCapture?.state !== 'ready'
    || closurePause.pause?.automaticCapture?.frameId !== closureFrame.id) {
    throw new Error(`Randomized ESM/WASM business frame was not recovered deterministically: ${JSON.stringify(closurePause)}`);
  }
  const closureCallable = await callBridge(bridgeSocket, 'verify-closure-callable-create', 'browser.callable.create', {
    tabId: targetTab.id,
    source: 'deep-capture',
    strategy: 'selected-frame',
    callFrameId: closureFrame.id,
    name: 'E2E opaque module envelope',
  });
  if (closureCallable.error || closureCallable.result?.kind !== 'business-closure') {
    throw new Error(`Randomized ESM/WASM callable could not be retained: ${JSON.stringify(closureCallable)}`);
  }
  await webPage.locator('#opaque-module-result').getByText(closureReplayMarker, { exact: true }).waitFor();
  const closureReplay = await callBridge(bridgeSocket, 'verify-closure-callable-execute', 'browser.callable.execute', {
    tabId: targetTab.id,
    callableId: closureCallable.result.id,
    args: [{ marker: closureReplayMarker, nested: { seed: closureHoldoutSeed } }],
  });
  if (closureReplay.error || !closureReplay.result?.value || typeof closureReplay.result.value !== 'object') {
    throw new Error(`Randomized ESM/WASM callable replay failed: ${JSON.stringify(closureReplay)}`);
  }
  const closureServerResponse = await fetch(new URL(closureSubmitPath, testUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(closureReplay.result.value),
  });
  const closureServerResult = await closureServerResponse.json();
  if (!closureServerResponse.ok || !closureServerResult.ok || closureServerResult.marker !== closureReplayMarker) {
    throw new Error(`Independent server rejected the retained ESM/WASM callable: ${JSON.stringify(closureServerResult)}`);
  }
  await callBridge(bridgeSocket, 'verify-closure-capture-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });

  await webPage.locator('#crypto-lab[data-ready="true"]').waitFor();
  await webPage.locator('#crypto-password').fill('deep-capture-first-901');
  const deepCaptureStart = await callBridge(bridgeSocket, 'verify-deep-capture-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: webCryptoEncryptEvent.crypto.adapterId,
      operation: webCryptoEncryptEvent.crypto.operation,
      wrapperHandleId: webCryptoEncryptEvent.wrapperHandleId,
    },
  });
  if (deepCaptureStart.error || deepCaptureStart.result?.state !== 'armed') {
    throw new Error(`Deep capture did not arm: ${JSON.stringify(deepCaptureStart)}`);
  }
  await webPage.evaluate(() => {
    setTimeout(() => document.querySelector('#crypto-submit').click(), 50);
  });
  let deepPause;
  let lastDeepStatus;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = await callBridge(bridgeSocket, `verify-deep-capture-status-${attempt}`, 'browser.deep_capture.status', { tabId: targetTab.id });
    if (next.error) throw new Error(`Deep capture status failed: ${JSON.stringify(next)}`);
    lastDeepStatus = next.result;
    if (next.result?.state === 'paused') {
      deepPause = next.result;
      await callBridge(bridgeSocket, `verify-deep-capture-keepalive-${attempt}`, 'browser.deep_capture.keepalive', { tabId: targetTab.id });
      const frame = deepPause.pause?.frames?.find((item) => item.functionName === 'buildLoginEnvelope');
      const variables = frame?.scopes?.flatMap((scope) => scope.variables) || [];
      if (!deepPause.pause?.collecting && variables.some((variable) => variable.name === 'password')) break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const businessFrame = deepPause?.pause?.frames?.find((frame) => frame.functionName === 'buildLoginEnvelope');
  const businessVariables = businessFrame?.scopes?.flatMap((scope) => scope.variables) || [];
  if (!businessFrame || businessFrame.sourceKind !== 'page'
    || deepPause?.pause?.frames?.[0]?.sourceKind !== 'extension-hook'
    || !businessFrame.scopes.some((scope) => scope.type === 'closure' || scope.type === 'local')
    || !businessFrame.functionInspection?.resolved || businessFrame.functionInspection.riskFlags?.length
    || !businessVariables.some((variable) => variable.name === 'password' && variable.preview.includes('deep-capture-first-901'))) {
    throw new Error(`Deep capture did not expose the real business frame and lexical inputs: ${JSON.stringify({ deepPause, lastDeepStatus })}`);
  }
  await options.getByRole('button', { name: '网络活动' }).click();
  await options.locator('#deep-mode-tab').click();
  const pausedDeepWorkbench = options.locator('.deep-paused-workbench');
  await pausedDeepWorkbench.waitFor();
  await options.locator('.deep-stack button.is-selected').getByText('buildLoginEnvelope', { exact: true }).waitFor();
  await options.locator('.deep-stack').getByText('插件 Hook', { exact: true }).first().waitFor();
  await options.locator('.deep-stack').getByText('页面函数', { exact: true }).first().waitFor();
  const expandablePassword = options.locator('.deep-scope-variable').filter({ hasText: 'password' }).first();
  await expandablePassword.locator(':scope > button').click();
  await expandablePassword.locator('pre').getByText('deep-capture-first-901', { exact: true }).waitFor();
  if (await expandablePassword.locator(':scope > button').getAttribute('aria-expanded') !== 'true') {
    throw new Error('Deep capture scope row did not expose its inline value block');
  }
  const pausedDeepBounds = await pausedDeepWorkbench.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (pausedDeepBounds.scrollWidth > pausedDeepBounds.clientWidth) {
    throw new Error(`Paused deep workbench overflowed horizontally: ${JSON.stringify(pausedDeepBounds)}`);
  }
  await options.screenshot({ path: resolve(artifacts, 'options-deep-capture-paused.png') });
  const capturedCallable = await callBridge(bridgeSocket, 'verify-captured-callable-create', 'browser.callable.create', {
    tabId: targetTab.id,
    source: 'deep-capture',
    strategy: 'selected-frame',
    callFrameId: businessFrame.id,
    name: 'E2E login envelope',
  });
  if (capturedCallable.error || capturedCallable.result?.provenance?.functionName !== 'buildLoginEnvelope') {
    throw new Error(`Could not retain the real business closure: ${JSON.stringify(capturedCallable)}`);
  }
  await options.locator('#recording-mode-tab').click();
  await webPage.locator('#crypto-result').getByText('deep-capture-first-901').waitFor();
  await webPage.locator('#crypto-password').fill('deep-capture-response-906');
  const responseCaptureStart = await callBridge(bridgeSocket, 'verify-response-capture-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: webCryptoDecryptEvent.crypto.adapterId,
      operation: webCryptoDecryptEvent.crypto.operation,
      wrapperHandleId: webCryptoDecryptEvent.wrapperHandleId,
    },
  });
  if (responseCaptureStart.error || responseCaptureStart.result?.state !== 'armed') {
    throw new Error(`Response decrypt capture did not arm: ${JSON.stringify(responseCaptureStart)}`);
  }
  await webPage.evaluate(() => {
    setTimeout(() => document.querySelector('#crypto-submit').click(), 50);
  });
  let responsePause;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = await callBridge(bridgeSocket, `verify-response-capture-status-${attempt}`, 'browser.deep_capture.status', { tabId: targetTab.id });
    if (next.error) throw new Error(`Response decrypt capture status failed: ${JSON.stringify(next)}`);
    if (next.result?.state === 'paused') {
      responsePause = next.result;
      await callBridge(bridgeSocket, `verify-response-capture-keepalive-${attempt}`, 'browser.deep_capture.keepalive', { tabId: targetTab.id });
      if (responsePause.pause?.frames?.some((frame) => frame.functionName === 'openLoginResponse')) break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const responseBusinessFrame = responsePause?.pause?.frames?.find((frame) => frame.functionName === 'openLoginResponse');
  if (!responseBusinessFrame) {
    throw new Error(`Deep capture did not expose the real response decrypt function: ${JSON.stringify(responsePause)}`);
  }
  const responseCallable = await callBridge(bridgeSocket, 'verify-response-callable-create', 'browser.callable.create', {
    tabId: targetTab.id,
    source: 'deep-capture',
    strategy: 'selected-frame',
    callFrameId: responseBusinessFrame.id,
    name: 'E2E login response decryptor',
  });
  if (responseCallable.error || responseCallable.result?.provenance?.functionName !== 'openLoginResponse') {
    throw new Error(`Could not retain the real response decrypt closure: ${JSON.stringify(responseCallable)}`);
  }
  await webPage.locator('#crypto-result').getByText('deep-capture-response-906').waitFor();
  const transformProfile = await callBridge(bridgeSocket, 'verify-transform-profile-save', 'browser.transform.profile.save', {
    name: 'E2E login plaintext gateway',
    enabled: true,
    target: { tabId: targetTab.id, frameId: 0 },
    origin: new URL(testUrl).origin,
    match: { methods: ['POST'], urlPattern: '*/crypto-lab/submit' },
    request: {
      enabled: true,
      nodes: [
        { id: 'request-password', name: 'Read password', kind: 'context.read', path: 'body.password' },
        { id: 'request-account', name: 'Read account', kind: 'context.read', path: 'body.account' },
        {
          id: 'build-login-envelope',
          name: 'Build real login envelope',
          kind: 'page.call',
          callableId: capturedCallable.result.id,
          arguments: [{ nodeId: 'request-password' }, { nodeId: 'request-account' }],
        },
        {
          id: 'write-login-envelope',
          name: 'Write encrypted envelope',
          kind: 'output.write',
          source: { nodeId: 'build-login-envelope' },
          destination: 'body',
          encoding: 'json',
        },
      ],
    },
    response: {
      enabled: true,
      nodes: [
        { id: 'response-body', name: 'Read response body', kind: 'context.read', path: 'body' },
        {
          id: 'open-login-response',
          name: 'Open real login response',
          kind: 'page.call',
          callableId: responseCallable.result.id,
          arguments: [{ nodeId: 'response-body' }],
        },
        {
          id: 'write-plaintext-response',
          name: 'Write plaintext response',
          kind: 'output.write',
          source: { nodeId: 'open-login-response' },
          destination: 'body',
          encoding: 'json',
        },
      ],
    },
    failMode: 'closed',
    maxConcurrency: 1,
  });
  if (transformProfile.error || !transformProfile.result?.id || !transformProfile.result?.target?.documentId) {
    throw new Error(`Could not bind the plaintext gateway to the live document: ${JSON.stringify(transformProfile)}`);
  }
  const plaintextGatewayBody = { account: 'gateway-operator', password: 'gateway-plaintext-906' };
  const transformedRequest = await callBridge(bridgeSocket, 'verify-transform-request', 'browser.transform.execute', {
    profileId: transformProfile.result.id,
    direction: 'request',
    packet: {
      method: 'POST',
      url: new URL('/crypto-lab/submit', testUrl).href,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: Buffer.from(JSON.stringify(plaintextGatewayBody)).toString('base64'),
    },
  });
  if (transformedRequest.error || transformedRequest.result?.profileId !== transformProfile.result.id) {
    throw new Error(`Plaintext gateway request transform failed: ${JSON.stringify(transformedRequest)}`);
  }
  const wireEnvelope = JSON.parse(Buffer.from(transformedRequest.result.bodyBase64, 'base64').toString('utf8'));
  if (!wireEnvelope.ciphertext || !wireEnvelope.signature || JSON.stringify(wireEnvelope).includes(plaintextGatewayBody.password)) {
    throw new Error(`Plaintext gateway did not produce a real encrypted wire body: ${JSON.stringify(wireEnvelope)}`);
  }
  const wireServerResponse = await fetch(new URL('/crypto-lab/submit', testUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wireEnvelope),
  }).then((response) => response.json());
  if (!wireServerResponse.ciphertext || JSON.stringify(wireServerResponse).includes(plaintextGatewayBody.password)) {
    throw new Error(`Real server did not accept the request and return an encrypted response: ${JSON.stringify(wireServerResponse)}`);
  }
  const transformedResponse = await callBridge(bridgeSocket, 'verify-transform-response', 'browser.transform.execute', {
    profileId: transformProfile.result.id,
    direction: 'response',
    packet: {
      method: 'POST',
      url: new URL('/crypto-lab/submit', testUrl).href,
      statusCode: 200,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: Buffer.from(JSON.stringify(wireServerResponse)).toString('base64'),
    },
  });
  const plaintextServerResponse = transformedResponse.error
    ? undefined
    : JSON.parse(Buffer.from(transformedResponse.result.bodyBase64, 'base64').toString('utf8'));
  if (!plaintextServerResponse?.ok || plaintextServerResponse.password !== plaintextGatewayBody.password
    || plaintextServerResponse.account !== plaintextGatewayBody.account) {
    throw new Error(`Plaintext gateway did not restore the real encrypted server response: ${JSON.stringify({ transformedResponse, plaintextServerResponse })}`);
  }
  const rejectedTransformRoute = await callBridge(bridgeSocket, 'verify-transform-route-closed', 'browser.transform.execute', {
    profileId: transformProfile.result.id,
    direction: 'request',
    packet: {
      method: 'POST',
      url: new URL('/api/session', testUrl).href,
      headers: [],
      bodyBase64: Buffer.from(JSON.stringify(plaintextGatewayBody)).toString('base64'),
    },
  });
  if (rejectedTransformRoute.error?.code !== 'transform_route_mismatch') {
    throw new Error(`Plaintext gateway did not fail closed on a mismatched route: ${JSON.stringify(rejectedTransformRoute)}`);
  }
  const rejectedTransformOrigin = await callBridge(bridgeSocket, 'verify-transform-origin-closed', 'browser.transform.execute', {
    profileId: transformProfile.result.id,
    direction: 'request',
    packet: {
      method: 'POST',
      url: `http://localhost:${address.port}/crypto-lab/submit`,
      headers: [],
      bodyBase64: Buffer.from(JSON.stringify(plaintextGatewayBody)).toString('base64'),
    },
  });
  if (rejectedTransformOrigin.error?.code !== 'transform_route_mismatch') {
    throw new Error(`Path-only plaintext gateway route crossed the bound origin: ${JSON.stringify(rejectedTransformOrigin)}`);
  }
  const visibleTransformProfiles = await callBridge(bridgeSocket, 'verify-transform-profile-list', 'browser.transform.profile.list', {
    tabId: targetTab.id,
  });
  if (visibleTransformProfiles.error || !visibleTransformProfiles.result?.some((profile) => profile.id === transformProfile.result.id)) {
    throw new Error(`Authorized transform profile was not visible to Yakit: ${JSON.stringify(visibleTransformProfiles)}`);
  }
  const callableExecutionA = await callBridge(bridgeSocket, 'verify-callable-execute-a', 'browser.callable.execute', {
    tabId: targetTab.id,
    callableId: capturedCallable.result.id,
    args: ['deep-capture-replay-902', 'automation-a'],
  });
  const callableExecutionB = await callBridge(bridgeSocket, 'verify-callable-execute-b', 'browser.callable.execute', {
    tabId: targetTab.id,
    callableId: capturedCallable.result.id,
    args: ['deep-capture-replay-903', 'automation-b'],
  });
  if (callableExecutionA.error || callableExecutionB.error
    || callableExecutionA.result?.value?.nonce === callableExecutionB.result?.value?.nonce
    || callableExecutionA.result?.value?.iv === callableExecutionB.result?.value?.iv) {
    throw new Error(`Page callable did not preserve dynamic browser behavior: ${JSON.stringify({ callableExecutionA, callableExecutionB })}`);
  }
  const callableWireResponse = await fetch(new URL('/crypto-lab/submit', testUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callableExecutionA.result.value),
  }).then((response) => response.json());
  const callableValidation = await decryptCryptoLabResponse(callableWireResponse);
  if (!callableValidation.ok || callableValidation.password !== 'deep-capture-replay-902' || callableValidation.account !== 'automation-a') {
    throw new Error(`Captured page callable did not pass server validation: ${JSON.stringify(callableValidation)}`);
  }
  const detachedDeepCapture = await callBridge(bridgeSocket, 'verify-deep-capture-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });
  if (detachedDeepCapture.error || detachedDeepCapture.result?.state !== 'detached') {
    throw new Error(`Deep capture did not detach cleanly: ${JSON.stringify(detachedDeepCapture)}`);
  }
  const deepRecordingSnapshot = await callBridge(
    bridgeSocket,
    'verify-deep-recording-source',
    'browser.recording.get',
    { tabId: targetTab.id, limit: 100 },
  );
  const filteredSource = [...(deepRecordingSnapshot.result?.events || [])].reverse()
    .find((event) => event.kind === 'crypto' && event.crypto?.adapterId === 'webcrypto'
      && event.crypto?.operation === 'encrypt' && event.scriptUrl && event.wrapperHandleId);
  if (!filteredSource?.scriptUrl || !filteredSource.wrapperHandleId) {
    throw new Error(`Deep capture did not retain a script source for filtered re-arm: ${JSON.stringify(deepRecordingSnapshot)}`);
  }
  await webPage.locator('#crypto-password').fill('deep-filter-match-904');
  const filteredCaptureStart = await callBridge(bridgeSocket, 'verify-deep-filter-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: filteredSource.crypto.adapterId,
      operation: filteredSource.crypto.operation,
      wrapperHandleId: filteredSource.wrapperHandleId,
      scriptUrl: filteredSource.scriptUrl,
    },
  });
  if (filteredCaptureStart.error || filteredCaptureStart.result?.state !== 'armed') {
    throw new Error(`Script-filtered deep capture did not arm: ${JSON.stringify(filteredCaptureStart)}`);
  }
  await webPage.evaluate(() => setTimeout(() => document.querySelector('#crypto-submit').click(), 50));
  let filteredPause;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const next = await callBridge(bridgeSocket, `verify-deep-filter-status-${attempt}`, 'browser.deep_capture.status', { tabId: targetTab.id });
    if (next.result?.state === 'paused') {
      filteredPause = next.result;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!filteredPause) throw new Error(`Script-filtered deep capture did not pause at its source: ${filteredSource.scriptUrl}`);
  const filteredResume = await callBridge(bridgeSocket, 'verify-deep-filter-resume', 'browser.deep_capture.resume', { tabId: targetTab.id });
  if (filteredResume.error) throw new Error(`Script-filtered deep capture did not resume: ${JSON.stringify(filteredResume)}`);
  await webPage.locator('#crypto-result').getByText('deep-filter-match-904').waitFor();
  await callBridge(bridgeSocket, 'verify-deep-filter-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });

  await webPage.locator('#crypto-password').fill('deep-filter-miss-905');
  const missedCaptureStart = await callBridge(bridgeSocket, 'verify-deep-filter-miss-start', 'browser.deep_capture.start', {
    tabId: targetTab.id,
    matcher: {
      kind: 'crypto',
      adapterId: filteredSource.crypto.adapterId,
      operation: filteredSource.crypto.operation,
      wrapperHandleId: filteredSource.wrapperHandleId,
      scriptUrl: 'https://not-the-calling-script.invalid/no-match.js',
    },
  });
  if (missedCaptureStart.error) throw new Error(`Non-matching deep capture did not arm: ${JSON.stringify(missedCaptureStart)}`);
  await webPage.evaluate(() => setTimeout(() => document.querySelector('#crypto-submit').click(), 50));
  await webPage.locator('#crypto-result').getByText('deep-filter-miss-905').waitFor();
  const missedCaptureStatus = await callBridge(bridgeSocket, 'verify-deep-filter-miss-status', 'browser.deep_capture.status', { tabId: targetTab.id });
  if (missedCaptureStatus.error || missedCaptureStatus.result?.state !== 'armed') {
    throw new Error(`A non-matching script incorrectly consumed the deep breakpoint: ${JSON.stringify(missedCaptureStatus)}`);
  }
  await callBridge(bridgeSocket, 'verify-deep-filter-miss-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });
  const idleRecorderDurationMs = await webPage.evaluate(() => {
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < 1_000; index += 1) {
      checksum += window.CryptoJS.SHA256(`idle-${index}`).sigBytes;
    }
    if (checksum !== 32_000) throw new Error('Idle recorder benchmark changed page return values');
    return performance.now() - started;
  });
  const performanceRecordingStart = await callBridge(
    bridgeSocket,
    'verify-recorder-performance-start',
    'browser.recording.start',
    { tabId: targetTab.id, captureValues: false, maxEntries: 20 },
  );
  if (performanceRecordingStart.error) {
    throw new Error(`Recorder performance session did not start: ${JSON.stringify(performanceRecordingStart)}`);
  }
  const recorderPerformance = await webPage.evaluate(() => {
    const smallStarted = performance.now();
    let checksum = 0;
    for (let index = 0; index < 1_000; index += 1) {
      checksum += window.CryptoJS.SHA256(`active-${index}`).sigBytes;
    }
    const smallCallsMs = performance.now() - smallStarted;
    const largePayload = 'x'.repeat(1024 * 1024);
    const largeStarted = performance.now();
    for (let index = 0; index < 10; index += 1) {
      checksum += window.CryptoJS.SHA256(largePayload).sigBytes;
    }
    const largeCallsMs = performance.now() - largeStarted;
    const oversizedPayload = 'y'.repeat(3 * 1024 * 1024);
    checksum += window.CryptoJS.SHA256(oversizedPayload).sigBytes;
    if (checksum !== 32_352) throw new Error('Active recorder benchmark changed page return values');
    return { smallCallsMs, largeCallsMs };
  });
  const performanceSnapshot = await callBridge(
    bridgeSocket,
    'verify-recorder-performance-get',
    'browser.recording.get',
    { tabId: targetTab.id, limit: 20 },
  );
  const oversizedEvent = performanceSnapshot.result?.events?.find((item) => item.byteLength === 3 * 1024 * 1024);
  if (performanceSnapshot.error || performanceSnapshot.result?.status?.count !== 20
    || performanceSnapshot.result?.status?.droppedCount < 991
    || oversizedEvent?.callHandleId || oversizedEvent?.callableCapable) {
    throw new Error(`Recorder budgets were not enforced under load: ${JSON.stringify({
      status: performanceSnapshot.result?.status,
      oversizedEvent,
    })}`);
  }
  if (recorderPerformance.smallCallsMs > 3_000 || recorderPerformance.largeCallsMs > 8_000) {
    throw new Error(`Recorder performance gate exceeded: ${JSON.stringify({ idleRecorderDurationMs, ...recorderPerformance })}`);
  }
  const performanceRecordingStop = await callBridge(
    bridgeSocket,
    'verify-recorder-performance-stop',
    'browser.recording.stop',
    { tabId: targetTab.id },
  );
  if (performanceRecordingStop.error || performanceRecordingStop.result?.status?.active) {
    throw new Error(`Recorder performance session did not stop cleanly: ${JSON.stringify(performanceRecordingStop)}`);
  }
  const observerRestored = await webPage.evaluate(() => ({
    fetch: window.fetch === window.__yakitObserverOriginals.fetch,
    xhrOpen: XMLHttpRequest.prototype.open === window.__yakitObserverOriginals.xhrOpen,
    xhrSend: XMLHttpRequest.prototype.send === window.__yakitObserverOriginals.xhrSend,
    webSocket: window.WebSocket === window.__yakitObserverOriginals.webSocket,
    worker: window.Worker === window.__yakitObserverOriginals.worker,
    workerPostMessage: window.Worker?.prototype.postMessage === window.__yakitObserverOriginals.workerPostMessage,
    messageChannel: window.MessageChannel === window.__yakitObserverOriginals.messageChannel,
    messagePortPostMessage: window.MessagePort?.prototype.postMessage === window.__yakitObserverOriginals.messagePortPostMessage,
    sendBeacon: Navigator.prototype.sendBeacon === window.__yakitObserverOriginals.sendBeacon,
    digest: Object.getPrototypeOf(crypto.subtle).digest === window.__yakitObserverOriginals.digest,
    cryptoJs: window.CryptoJS.SHA256 === window.__yakitObserverOriginals.cryptoJsSha256,
    jsencrypt: window.JSEncrypt.prototype.encrypt === window.__yakitObserverOriginals.jsencryptEncrypt,
    sm2: window.sm2.doEncrypt === window.__yakitObserverOriginals.sm2Encrypt,
    sm3: window.sm3 === window.__yakitObserverOriginals.sm3,
    sm4: window.sm4.encrypt === window.__yakitObserverOriginals.sm4Encrypt,
    forgeCipher: window.forge.cipher.createCipher === window.__yakitObserverOriginals.forgeCreateCipher,
    forgePki: window.forge.pki.publicKeyFromPem === window.__yakitObserverOriginals.forgePublicKeyFromPem,
    forgeDigest: window.forge.md.sha256.create === window.__yakitObserverOriginals.forgeSha256Create,
    forgeHmac: window.forge.hmac.create === window.__yakitObserverOriginals.forgeHmacCreate,
  }));
  if (Object.values(observerRestored).some((value) => !value)) throw new Error(`Page APIs were not restored after recording: ${JSON.stringify(observerRestored)}`);

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
  const insecureRecordingStart = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({
      action: 'recording.start',
      payload: { tabId, captureValues: false, maxEntries: 100 },
    });
  }, insecureTab.id);
  if (!insecureRecordingStart?.ok || insecureRecordingStart.data?.status?.active !== true) {
    throw new Error(`Insecure HTTP recording did not start: ${JSON.stringify(insecureRecordingStart)}`);
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
    throw new Error(`Recording changed insecure page behavior: ${JSON.stringify(insecureOriginalResults)}`);
  }
  const insecureRecording = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ action: 'recording.get', payload: { tabId, limit: 100 } });
  }, insecureTab.id);
  if (!insecureRecording?.ok) throw new Error(`Could not read insecure HTTP recording: ${JSON.stringify(insecureRecording)}`);
  const insecureKinds = new Set(insecureRecording.data.events.map((item) => item.kind));
  for (const kind of ['fetch', 'xhr', 'websocket', 'crypto']) {
    if (!insecureKinds.has(kind)) throw new Error(`Insecure HTTP recording missed ${kind}: ${JSON.stringify(insecureRecording)}`);
  }
  const insecureRecordingStop = await options.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ action: 'recording.stop', payload: { tabId } });
  }, insecureTab.id);
  if (!insecureRecordingStop?.ok) throw new Error(`Could not stop insecure HTTP recording: ${JSON.stringify(insecureRecordingStop)}`);
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

  const automaticCaptureStartedAt = Date.now();
  const automaticCaptureRecording = await callBridge(
    bridgeSocket,
    'verify-automatic-business-capture-recording-start',
    'browser.recording.start',
    { tabId: targetTab.id, captureValues: true, maxEntries: 80 },
  );
  if (automaticCaptureRecording.error) {
    throw new Error(`Could not start the automatic business capture recording: ${JSON.stringify(automaticCaptureRecording)}`);
  }
  await webPage.locator('#crypto-password').fill('automatic-capture-seed-951');
  await webPage.locator('#crypto-submit').click();
  await webPage.locator('#crypto-result').getByText('automatic-capture-seed-951').waitFor();
  const automaticCaptureSnapshot = await callBridge(
    bridgeSocket,
    'verify-automatic-business-capture-recording-get',
    'browser.recording.get',
    { tabId: targetTab.id, limit: 80 },
  );
  const automaticCandidate = automaticCaptureSnapshot.result?.profileCandidates?.find((candidate) => (
    candidate.status === 'capture-required'
      && candidate.sources?.length >= 2
      && candidate.request?.url?.includes('/crypto-lab/submit')
  ));
  const commonBusinessHint = automaticCandidate?.capturePlan?.frameHints?.find((hint) => (
    hint.functionName === 'buildLoginEnvelope'
  ));
  if (!automaticCandidate || automaticCandidate.capturePlan?.matcherEventId !== automaticCandidate.source.eventId
    || !commonBusinessHint || commonBusinessHint.support < 2) {
    throw new Error(`Multi-call inference did not identify a common business ancestor: ${JSON.stringify(automaticCaptureSnapshot)}`);
  }

  await options.getByRole('button', { name: '网络活动' }).click();
  await options.locator('#recording-mode-tab').click();
  await options.getByRole('button', { name: '刷新录制', exact: true }).click();
  const automaticInference = options.locator('.profile-inference').filter({ hasText: '/crypto-lab/submit' });
  await automaticInference.waitFor();
  await automaticInference.getByRole('button', { name: '自动捕获完整加密流程', exact: true }).click();
  await options.locator('#deep-mode-tab[aria-selected="true"]').waitFor();
  await options.getByText('等待目标页面命中', { exact: true }).waitFor();

  await webPage.locator('#crypto-password').fill('automatic-capture-replay-952');
  await webPage.locator('#crypto-submit').click();
  await options.locator('#gateway-mode-tab[aria-selected="true"]').waitFor({ timeout: 30_000 });
  const automaticGateway = options.locator('.transform-guide');
  await automaticGateway.waitFor();
  if (await automaticGateway.getByLabel('输出形态').inputValue() !== 'body') {
    throw new Error('Automatic multi-call capture did not generate a whole-envelope gateway');
  }
  const automaticInputs = automaticGateway.locator('.transform-guide-inputs > div');
  if (await automaticInputs.count() !== 2
    || await automaticInputs.nth(0).locator('select').inputValue() !== 'body-field'
    || await automaticInputs.nth(0).locator('input').inputValue() !== 'password'
    || await automaticInputs.nth(1).locator('select').inputValue() !== 'body-field'
    || await automaticInputs.nth(1).locator('input').inputValue() !== 'account') {
    throw new Error('Automatic business capture did not create parameter-level input bindings');
  }
  const automaticReplayBody = JSON.parse(await options.getByLabel('回放 Body').inputValue());
  if (automaticReplayBody.password !== 'automatic-capture-replay-952' || automaticReplayBody.account !== 'analyst') {
    throw new Error(`Automatic business capture did not preserve its paused local sample: ${JSON.stringify(automaticReplayBody)}`);
  }
  const automaticSampleLabel = await options.locator('.transform-test-field-label em').getAttribute('title');
  if (!automaticSampleLabel?.includes('buildLoginEnvelope')) {
    throw new Error(`Automatic business capture did not identify the replay sample source: ${automaticSampleLabel}`);
  }
  const automaticCallables = await callBridge(
    bridgeSocket,
    'verify-automatic-business-capture-callables',
    'browser.callable.list',
    { tabId: targetTab.id },
  );
  const automaticCallable = automaticCallables.result?.findLast((callable) => (
    callable.kind === 'business-closure'
      && callable.provenance?.functionName === 'buildLoginEnvelope'
      && callable.createdAt >= automaticCaptureStartedAt
  ));
  if (automaticCallables.error || !automaticCallable?.id || automaticCallable.inputSlots?.length !== 2
    || automaticCallable.inputSlots[0]?.name !== 'password' || automaticCallable.inputSlots[1]?.name !== 'account'
    || automaticCallable.operation !== 'buildLoginEnvelope') {
    throw new Error(`One-click capture did not retain the complete business callable: ${JSON.stringify(automaticCallables)}`);
  }
  await options.locator('.transform-editor-actions').getByRole('button', { name: '保存', exact: true }).click();
  const executeAutomaticPipeline = options.getByRole('button', { name: '执行 Pipeline', exact: true });
  await executeAutomaticPipeline.waitFor({ state: 'visible' });
  await executeAutomaticPipeline.click();
  await options.getByText('转换完成', { exact: true }).waitFor();
  const automaticLogicalOutput = JSON.parse(await options.locator('.transform-test-result pre').textContent());
  if (!automaticLogicalOutput.body?.ciphertext || !automaticLogicalOutput.body?.signature || !automaticLogicalOutput.body?.iv) {
    throw new Error(`Automatic business gateway did not execute the complete page closure: ${JSON.stringify(automaticLogicalOutput)}`);
  }
  const automaticProfiles = await callBridge(
    bridgeSocket,
    'verify-automatic-business-profile-list',
    'browser.transform.profile.list',
    { tabId: targetTab.id },
  );
  const automaticProfile = automaticProfiles.result?.find((profile) => (
    profile.createdAt >= automaticCaptureStartedAt
      && profile.request?.nodes?.some((node) => node.kind === 'page.call' && node.callableId === automaticCallable.id)
  ));
  if (automaticProfiles.error || !automaticProfile?.id) {
    throw new Error(`Automatic business gateway was not persisted for execution: ${JSON.stringify(automaticProfiles)}`);
  }
  const removedAutomaticProfile = await callBridge(
    bridgeSocket,
    'verify-automatic-business-profile-delete',
    'browser.transform.profile.delete',
    { id: automaticProfile.id },
  );
  if (removedAutomaticProfile.error || removedAutomaticProfile.result?.some((profile) => profile.id === automaticProfile.id)) {
    throw new Error(`Automatic business gateway test profile was not removed: ${JSON.stringify(removedAutomaticProfile)}`);
  }
  await webPage.locator('#crypto-result').getByText('automatic-capture-replay-952').waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-automatic-business-capture.png') });
  await callBridge(bridgeSocket, 'verify-automatic-business-recording-stop', 'browser.recording.stop', { tabId: targetTab.id });
  await callBridge(bridgeSocket, 'verify-automatic-business-capture-detach', 'browser.deep_capture.detach', { tabId: targetTab.id });

  const guidedFormRecordingStart = await callBridge(bridgeSocket, 'verify-guided-form-recording-start', 'browser.recording.start', {
    tabId: targetTab.id,
    captureValues: true,
    maxEntries: 40,
  });
  if (guidedFormRecordingStart.error) {
    throw new Error(`Could not start the guided form recording: ${JSON.stringify(guidedFormRecordingStart)}`);
  }
  await webPage.evaluate(async () => {
    const plaintext = JSON.stringify({ username: 'admin', password: '123456' });
    const encryptedData = window.__yakitRsa.encrypt(plaintext);
    const response = await fetch('/encrypt/rsa.php?source=guided-rsa-profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: encryptedData }),
    });
    const validation = await response.json();
    if (!validation.ok || validation.plaintext !== plaintext) {
      throw new Error(`Guided RSA request was not accepted by the independent server: ${JSON.stringify(validation)}`);
    }
  });
  const guidedFormRecording = await callBridge(bridgeSocket, 'verify-guided-form-recording-get', 'browser.recording.get', {
    tabId: targetTab.id,
    limit: 40,
  });
  const guidedFormCandidate = guidedFormRecording.result?.profileCandidates?.find((candidate) => (
    candidate.status === 'ready'
      && candidate.request?.serialization === 'form-field'
      && candidate.request?.destination === 'body.data'
      && candidate.source?.crypto?.adapterId === 'jsencrypt'
  ));
  if (!guidedFormCandidate?.source?.eventId) {
    throw new Error(`Dedicated recording did not produce a guided form candidate: ${JSON.stringify(guidedFormRecording)}`);
  }

  await options.getByRole('button', { name: '网络活动' }).click();
  await options.locator('#gateway-mode-tab').click();
  const transformWorkbench = options.locator('.transform-workbench');
  await transformWorkbench.waitFor();
  await options.getByText('E2E login plaintext gateway', { exact: true }).waitFor();
  const transformBounds = await transformWorkbench.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (transformBounds.scrollWidth > transformBounds.clientWidth) {
    throw new Error(`Plaintext gateway workbench overflowed horizontally: ${JSON.stringify(transformBounds)}`);
  }
  await options.screenshot({ path: resolve(artifacts, 'options-browser-transform-gateway.png') });
  await options.locator('#recording-mode-tab').click();
  await options.getByRole('button', { name: '刷新录制', exact: true }).click();
  const recordingWorkbench = options.locator('.recording-workbench');
  await recordingWorkbench.waitFor();
  await recordingWorkbench.scrollIntoViewIfNeeded();
  const recordingBounds = await recordingWorkbench.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (recordingBounds.scrollWidth > recordingBounds.clientWidth) {
    throw new Error(`Recording workbench overflowed horizontally: ${JSON.stringify(recordingBounds)}`);
  }
  const inferredProfilePanel = options.locator('.profile-inference');
  await inferredProfilePanel.waitFor();
  const inferredProfileHeading = await inferredProfilePanel.locator('.profile-inference__heading strong').innerText();
  if (!/JSEncrypt/.test(inferredProfileHeading) || /base64\.encode/i.test(inferredProfileHeading)) {
    throw new Error(`Profile inference promoted an encoding helper instead of the crypto source: ${inferredProfileHeading}`);
  }
  await inferredProfilePanel.getByText(/高置信度/).waitFor();
  await options.getByText('验证页面函数', { exact: true }).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-browser-recording.png') });
  await options.locator(`[data-event-id="${guidedFormCandidate.source.eventId}"]`).click();
  const formInferencePanel = options.locator('.profile-inference');
  await formInferencePanel.locator('.profile-inference__heading strong').getByText(/body\.data/).waitFor();
  await options.getByRole('button', { name: '停止录制并保存', exact: true }).click();
  const createRecordedCallable = options.getByRole('button', { name: '创建', exact: true });
  await createRecordedCallable.waitFor();
  await options.waitForTimeout(500);
  await createRecordedCallable.click();
  await options.getByText('验证页面函数', { exact: true }).waitFor();
  const guidedCallableList = await callBridge(
    bridgeSocket,
    'verify-guided-callable-list',
    'browser.callable.list',
    { tabId: targetTab.id },
  );
  const guidedCallableForDelete = guidedCallableList.result?.find((callable) => (
    callable.provenance?.eventId === guidedFormCandidate.source.eventId
  ));
  if (guidedCallableList.error || !guidedCallableForDelete?.name) {
    throw new Error(`The UI-created page callable was not retained: ${JSON.stringify(guidedCallableList)}`);
  }
  if (guidedCallableForDelete.crypto?.adapterId !== 'jsencrypt'
    || guidedCallableForDelete.crypto?.key?.bits !== 1024
    || guidedCallableForDelete.crypto?.padding !== 'PKCS1-v1_5') {
    throw new Error(`The UI-created callable lost its RSA adapter metadata: ${JSON.stringify(guidedCallableForDelete)}`);
  }
  const guidedRsaReplay = await callBridge(bridgeSocket, 'verify-guided-rsa-replay', 'browser.callable.execute', {
    tabId: targetTab.id,
    callableId: guidedCallableForDelete.id,
    args: [{ username: 'guided-rsa-admin', password: 'guided-rsa-password' }],
  });
  const guidedRsaReplayPlaintext = guidedRsaReplay.result?.value
    ? decryptRSALabValue(guidedRsaReplay.result.value)
    : undefined;
  const guidedRsaReplayPayload = guidedRsaReplayPlaintext ? JSON.parse(guidedRsaReplayPlaintext) : undefined;
  if (guidedRsaReplay.error
    || guidedRsaReplayPayload?.username !== 'guided-rsa-admin'
    || guidedRsaReplayPayload?.password !== 'guided-rsa-password') {
    throw new Error(`The UI-created RSA callable could not replay through its retained receiver: ${JSON.stringify({ guidedRsaReplay, guidedRsaReplayPlaintext, guidedRsaReplayPayload })}`);
  }
  await formInferencePanel.getByRole('button', { name: '生成明文网关', exact: true }).click();
  const guidedGateway = options.locator('.transform-guide');
  await guidedGateway.waitFor();
  if (await guidedGateway.getByLabel('输出形态').inputValue() !== 'form-field'
    || await guidedGateway.getByLabel('表单字段名').inputValue() !== 'data') {
    throw new Error('Form evidence was not compiled into a guided form-field gateway');
  }
  if (await options.getByLabel('URL 模式').inputValue() !== '*/encrypt/rsa.php'
    || !await options.getByLabel('回放请求 URL').inputValue().then((value) => value.startsWith(`${new URL(testUrl).origin}/encrypt/rsa.php?`))) {
    throw new Error('Relative request evidence was not resolved against the current page');
  }
  await guidedGateway.getByText('自动设置表单 Content-Type', { exact: true }).waitFor();
  if (await options.locator('.transform-node-list').isVisible()) {
    throw new Error('Guided gateway leaked the advanced DAG editor');
  }
  const replayBody = await options.getByLabel('回放 Body').inputValue();
  if (JSON.stringify(JSON.parse(replayBody)) !== JSON.stringify({ username: 'admin', password: '123456' })) {
    throw new Error(`Recorded short sample was not carried into local replay: ${replayBody}`);
  }
  await options.locator('.transform-test-field-label').getByText('短时样本', { exact: true }).waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-browser-transform-guided-rsa.png') });
  await options.locator('.transform-callable-menu > summary').click();
  const disposableCallable = options.locator('.transform-callable-list section').filter({ hasText: guidedCallableForDelete.name });
  await disposableCallable.getByRole('button', { name: `删除 ${guidedCallableForDelete.name}`, exact: true }).click();
  await disposableCallable.getByRole('button', { name: '确认删除', exact: true }).click();
  await disposableCallable.waitFor({ state: 'detached' });
  await options.screenshot({ path: resolve(artifacts, 'options-browser-transform-callables.png') });
  await options.locator('#recording-mode-tab').click();
  await options.locator('#deep-mode-tab').click();
  const deepCaptureWorkspace = options.locator('.deep-capture');
  await deepCaptureWorkspace.waitFor();
  await deepCaptureWorkspace.getByText('E2E login envelope', { exact: true }).waitFor();
  const deepCaptureBounds = await deepCaptureWorkspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (deepCaptureBounds.scrollWidth > deepCaptureBounds.clientWidth) {
    throw new Error(`Deep capture workbench overflowed horizontally: ${JSON.stringify(deepCaptureBounds)}`);
  }
  await options.screenshot({ path: resolve(artifacts, 'options-deep-capture.png') });
  await options.locator('#recording-mode-tab').click();
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
  await options.getByRole('button', { name: '分析', exact: true }).click();
  const analysisMessage = await analysisPrepareRequest;
  if (JSON.stringify(analysisMessage.params?.observations || []).includes('recorder-sensitive-preview-686')) {
    throw new Error('AI analysis payload included a sensitive recording preview');
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
  await mobileOptions.goto(`chrome-extension://${extensionId}/options.html?tabId=${targetTab.id}#overview`);
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
  await mobileOptions.locator('#gateway-mode-tab').click();
  const mobileTransformWorkbench = mobileOptions.locator('.transform-workbench');
  await mobileTransformWorkbench.waitFor();
  await mobileOptions.getByText('E2E login plaintext gateway', { exact: true }).waitFor();
  await mobileOptions.waitForTimeout(250);
  const mobileTransformBounds = await mobileTransformWorkbench.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    viewportOverflow: document.documentElement.scrollWidth - innerWidth,
  }));
  if (mobileTransformBounds.viewportOverflow > 0 || mobileTransformBounds.scrollWidth > mobileTransformBounds.clientWidth) {
    throw new Error(`Plaintext gateway mobile layout overflowed: ${JSON.stringify(mobileTransformBounds)}`);
  }
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-browser-transform-gateway-mobile.png'), fullPage: true });
  await mobileOptions.locator('#deep-mode-tab').click();
  await mobileOptions.locator('.deep-capture').waitFor();
  await mobileOptions.waitForTimeout(250);
  const mobileDeepOverflow = await mobileOptions.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (mobileDeepOverflow > 0) throw new Error(`Deep capture mobile layout overflows by ${mobileDeepOverflow}px`);
  await mobileOptions.screenshot({ path: resolve(artifacts, 'options-deep-capture-mobile.png'), fullPage: true });
  await mobileOptions.locator('#recording-mode-tab').click();
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

  await webPage.goto(testUrl);
  await webPage.locator('#crypto-lab[data-ready="true"]').waitFor();
  await webPage.evaluate(() => {
    window.CryptoJS = {
      SHA256(value) {
        return { sigBytes: 32, toString: () => `sha256:${value}` };
      },
    };
  });
  const navigationRecordingStart = await options.evaluate(async ({ tabId }) => {
    return await chrome.runtime.sendMessage({
      action: 'recording.start',
      payload: { tabId, frameId: 0, captureValues: true, maxEntries: 40, maxValueBytes: 8_192 },
    });
  }, { tabId: targetTab.id });
  if (!navigationRecordingStart?.ok || navigationRecordingStart.data?.status?.active !== true) {
    throw new Error(`Could not start the navigation recording: ${JSON.stringify(navigationRecordingStart)}`);
  }
  await webPage.evaluate(() => {
    window.CryptoJS.SHA256(JSON.stringify({ username: 'redirect-admin', password: 'redirect-secret' }));
  });
  const navigationSnapshotBefore = await options.evaluate(async ({ tabId }) => {
    return await chrome.runtime.sendMessage({ action: 'recording.get', payload: { tabId, frameId: 0, limit: 40 } });
  }, { tabId: targetTab.id });
  if (!navigationSnapshotBefore?.ok || !JSON.stringify(navigationSnapshotBefore.data).includes('redirect-admin')) {
    throw new Error(`Navigation recording did not cache the short sample: ${JSON.stringify(navigationSnapshotBefore)}`);
  }
  const recordingCompleteUrl = `${new URL(testUrl).origin}/recording-complete`;
  await webPage.goto(recordingCompleteUrl);
  await webPage.getByRole('heading', { name: 'Recording Complete Dashboard' }).waitFor();

  let navigationSession;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await options.evaluate(async ({ tabId }) => {
      return await chrome.runtime.sendMessage({ action: 'recording.get', payload: { tabId, frameId: 0, limit: 40 } });
    }, { tabId: targetTab.id });
    const navigationEvent = response?.data?.events?.find((item) => (
      item.kind === 'navigation' && item.navigation?.toUrl === recordingCompleteUrl
    ));
    if (response?.ok
      && response.data?.status?.active === true
      && response.data?.status?.documentAvailable === true
      && ['committed', 'completed'].includes(navigationEvent?.navigation?.phase)) {
      navigationSession = response.data;
      break;
    }
    await options.waitForTimeout(100);
  }
  const recordedNavigation = navigationSession?.events?.find((item) => (
    item.kind === 'navigation' && item.navigation?.toUrl === recordingCompleteUrl
  ));
  if (navigationSession?.status?.navigation?.toUrl !== recordingCompleteUrl
    || navigationSession.status.target?.tabId !== targetTab.id
    || !recordedNavigation
    || !JSON.stringify(navigationSession.events).includes('redirect-admin')) {
    throw new Error(`Recording did not continue across a same-tab navigation: ${JSON.stringify(navigationSession)}`);
  }

  await options.getByRole('button', { name: '网络活动' }).click();
  await options.locator('#recording-mode-tab').click();
  await options.getByRole('button', { name: '刷新录制', exact: true }).click();
  await options.locator('.recording-pipeline-step.is-navigation').waitFor();
  await options.getByText('页面跳转', { exact: true }).first().waitFor();
  await options.getByText(/最早 ↓ 最新/).waitFor();
  await options.waitForFunction(({ tabId }) => {
    const select = document.querySelector('[aria-label="目标标签页"]');
    return select instanceof HTMLSelectElement
      && select.value === String(tabId)
      && select.selectedOptions[0]?.textContent === 'Recording Complete Dashboard';
  }, { tabId: targetTab.id });
  if (Number(await options.getByLabel('目标标签页').inputValue()) !== targetTab.id) {
    throw new Error('Same-tab navigation changed the selected browser target');
  }
  await options.screenshot({ path: resolve(artifacts, 'options-browser-recording-navigation.png') });

  await webPage.goBack();
  await webPage.locator('#crypto-lab[data-ready="true"]').waitFor();
  let restoredRecording;
  let lastRestoredRecordingResponse;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await options.evaluate(async ({ tabId }) => {
      return await chrome.runtime.sendMessage({ action: 'recording.get', payload: { tabId, frameId: 0, limit: 40 } });
    }, { tabId: targetTab.id });
    lastRestoredRecordingResponse = response;
    const navigationEvents = response?.data?.events?.filter((item) => item.kind === 'navigation') || [];
    if (response?.ok
      && response.data?.status?.active === true
      && response.data?.status?.documentAvailable === true
      && navigationEvents.length >= 2
      && response.data.status.navigation?.kind === 'back-forward') {
      restoredRecording = response.data;
      break;
    }
    await options.waitForTimeout(100);
  }
  if (!restoredRecording || !JSON.stringify(restoredRecording.events).includes('redirect-admin')) {
    throw new Error(`Browser Back did not restore the active recording session: ${JSON.stringify(lastRestoredRecordingResponse)}`);
  }
  await options.getByRole('button', { name: '刷新录制', exact: true }).click();
  await options.waitForFunction(() => document.querySelectorAll('.recording-traces button').length >= 2);
  await options.locator('.recording-traces button').last().click();
  await options.locator('.recording-pipeline-step.is-navigation').waitFor();
  await options.screenshot({ path: resolve(artifacts, 'options-browser-recording-restored.png') });

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

  console.log(JSON.stringify({ extensionId, testUrl, evalResult: evalResponse.data, timeoutError: timeoutResponse.error, bridgeEval: bridgeEval.result, cancelledBridgeError: cancelledBridgeEval.error, handoffEvent, auditEventCount: networkAudit.length, capturedNetworkUrl: capturedRequest.url, fuzzerPageId: 'e2e-fuzzer-page', protocolChecks, staleDocumentError: staleDocumentEval.error, staleOriginError: staleOriginEval.error?.message, serviceWorkerRestart: { beforeRestart, afterRestart }, unpairedIdentity, recorderPerformance: { idleCallsMs: idleRecorderDurationMs, ...recorderPerformance }, rightMetrics, panelMetrics, narrowPanel, artifacts }, null, 2));
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
