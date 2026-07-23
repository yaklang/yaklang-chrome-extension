import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { KEYUTIL, KJUR } from 'jsrsasign';
import { compactDecrypt, jwtVerify } from 'jose';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const recorderPath = resolve(root, '.output/chrome-mv3/page-recorder-main-world.js');
const jsrsasignPath = resolve(dirname(require.resolve('jsrsasign')), 'jsrsasign-all-min.js');
const joseIndexPath = fileURLToPath(import.meta.resolve('jose'));
const joseRoot = dirname(joseIndexPath);
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('G4 browser fixture body exceeded 1 MiB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

let capturedRequest;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><body><button id="run">Run G4 fixture</button><script src="/jsrsasign.js"></script><script type="module">import * as jose from "/jose/index.js"; window.jose = {...jose}; window.__g4Ready = true;</script></body></html>');
      return;
    }
    if (url.pathname === '/jsrsasign.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(await readFile(jsrsasignPath));
      return;
    }
    if (url.pathname.startsWith('/jose/')) {
      const relative = url.pathname.slice('/jose/'.length);
      const path = resolve(joseRoot, relative);
      assert(path.startsWith(`${joseRoot}/`) || path === joseRoot, 'Invalid jose module path');
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(await readFile(path));
      return;
    }
    if (url.pathname === '/g4-submit') {
      capturedRequest = {
        method: request.method,
        signature: String(request.headers['x-signature'] || ''),
        body: JSON.parse(await readBody(request)),
      };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});

let browser;
try {
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const keypair = KEYUTIL.generateKeypair('RSA', 1024);
  const privateKey = KEYUTIL.getPEM(keypair.prvKeyObj, 'PKCS8PRV');
  const publicKey = KEYUTIL.getPEM(keypair.pubKeyObj);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const secretBase64 = Buffer.from(secret).toString('base64');

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__g4Ready === true);
  await page.evaluate(({ privateKey, secretBase64 }) => {
    const bytes = Uint8Array.from(atob(secretBase64), (character) => character.charCodeAt(0));
    class Axios {
      async request(config) {
        const canonical = JSON.stringify(config.data);
        const signer = new window.KJUR.crypto.Signature({ alg: 'SHA256withRSA' });
        signer.init(privateKey);
        signer.updateString(canonical);
        const signature = signer.sign();
        const jwt = await new window.jose.SignJWT({ account: config.data.account })
          .setProtectedHeader({ alg: 'HS256' })
          .sign(bytes);
        const jwe = await new window.jose.CompactEncrypt(new TextEncoder().encode(canonical))
          .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
          .encrypt(bytes);
        const response = await fetch('/g4-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
          body: JSON.stringify({ canonical, jwt, jwe }),
        });
        return await response.json();
      }
    }
    window.axios = { Axios };
    window.__g4Fixture = { privateKey, bytes };
    window.__g4Originals = {
      stringify: JSON.stringify,
      axiosRequest: Axios.prototype.request,
      signature: window.KJUR.crypto.Signature,
      signJwt: window.jose.SignJWT,
      compactEncrypt: window.jose.CompactEncrypt,
    };
  }, { privateKey, secretBase64 });
  await page.addScriptTag({ path: recorderPath });
  await page.evaluate(() => {
    window.__YAKIT_PAGE_RECORDER_V9__.command('start', {
      captureValues: false,
      maxEntries: 200,
      maxValueBytes: 2_048,
    });
  });
  await page.click('#run');
  const result = await page.evaluate(async () => {
    const client = new window.axios.Axios();
    return await client.request({ data: { account: 'admin', nonce: '1700000000' } });
  });
  assert(result?.ok === true, 'Browser G4 request did not complete');
  await page.waitForTimeout(50);

  const snapshot = await page.evaluate(() => window.__YAKIT_PAGE_RECORDER_V9__.command('get', { limit: 200 }));
  const events = snapshot.events || [];
  const jsrsasignEvents = events.filter((event) => event.crypto?.adapterId === 'jsrsasign');
  const joseEvents = events.filter((event) => event.crypto?.adapterId === 'jose');
  const transformOperations = new Set(events.filter((event) => event.kind === 'transform').map((event) => event.operation));
  const requestEvent = events.find((event) => event.kind === 'fetch' && event.url?.includes('/g4-submit'));

  for (const phase of ['create', 'init', 'update', 'final']) {
    assert(jsrsasignEvents.some((event) => event.crypto?.state?.phase === phase), `Browser jsrsasign missed ${phase}`);
  }
  const jsrsasignCorrelation = new Set(jsrsasignEvents.map((event) => event.crypto?.state?.correlationId).filter(Boolean));
  assert(jsrsasignCorrelation.size === 1, 'Browser jsrsasign stages did not share one correlation ID');
  for (const operation of ['SignJWT.create', 'SignJWT.sign', 'CompactEncrypt.create', 'CompactEncrypt.encrypt']) {
    assert(joseEvents.some((event) => event.crypto?.operation === operation), `Browser jose missed ${operation}`);
  }
  assert(joseEvents.filter((event) => ['SignJWT.sign', 'CompactEncrypt.encrypt'].includes(event.crypto?.operation)).every((event) => event.durationMs >= 0), 'Browser jose Promise results did not settle');
  assert(transformOperations.has('JSON.stringify'), 'Browser fixture missed JSON serialization evidence');
  assert(transformOperations.has('axios.request'), 'Browser fixture missed Axios request-builder evidence');
  assert(requestEvent?.inputs?.some((item) => item.path === '$headers.x-signature'), 'Browser fixture missed Header signature evidence');
  const metadata = JSON.stringify(snapshot);
  assert(!metadata.includes(privateKey), 'Recorder metadata leaked the private key');
  assert(!metadata.includes(capturedRequest.body.canonical), 'Metadata-only recording leaked the canonical plaintext');

  const verifier = new KJUR.crypto.Signature({ alg: 'SHA256withRSA' });
  verifier.init(publicKey);
  verifier.updateString(capturedRequest.body.canonical);
  assert(verifier.verify(capturedRequest.signature), 'Independent jsrsasign verifier rejected the browser signature');
  const jwt = await jwtVerify(capturedRequest.body.jwt, secret, { algorithms: ['HS256'] });
  assert(jwt.payload.account === 'admin', 'Independent jose verifier rejected the browser JWT');
  const decrypted = await compactDecrypt(capturedRequest.body.jwe, secret, {
    keyManagementAlgorithms: ['dir'],
    contentEncryptionAlgorithms: ['A256GCM'],
  });
  assert(new TextDecoder().decode(decrypted.plaintext) === capturedRequest.body.canonical, 'Independent jose decrypt did not recover the canonical request');

  const restored = await page.evaluate(() => {
    window.__YAKIT_PAGE_RECORDER_V9__.command('stop');
    return {
      stringify: JSON.stringify === window.__g4Originals.stringify,
      axiosRequest: window.axios.Axios.prototype.request === window.__g4Originals.axiosRequest,
      signature: window.KJUR.crypto.Signature === window.__g4Originals.signature,
      signJwt: window.jose.SignJWT === window.__g4Originals.signJwt,
      compactEncrypt: window.jose.CompactEncrypt === window.__g4Originals.compactEncrypt,
    };
  });
  assert(Object.values(restored).every(Boolean), `G4 runtime did not restore page methods: ${JSON.stringify(restored)}`);

  console.log(JSON.stringify({
    jsrsasignEvents: jsrsasignEvents.length,
    joseEvents: joseEvents.length,
    transforms: [...transformOperations],
    requestHeaderLinked: true,
    independentVerification: true,
    restored: true,
  }, null, 2));
} finally {
  await browser?.close();
  await close(server);
}
