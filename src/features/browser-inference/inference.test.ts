import { describe, expect, it } from 'vitest';
import type {
  BrowserRecordingCallArgument,
  BrowserRecordingEvent,
  BrowserRecordingLink,
} from '@/types/models';
import { inferBrowserTransformProfiles } from './inference';
import { buildRecordingLinks } from '@/features/browser-recording/timeline';

function event(overrides: Partial<BrowserRecordingEvent> & Pick<BrowserRecordingEvent, 'id' | 'sequence' | 'kind' | 'operation'>): BrowserRecordingEvent {
  return {
    timestamp: 1_000 + overrides.sequence,
    recordingId: 'recording-1',
    traceId: 'trace-1',
    inputs: [],
    outputs: [],
    sensitiveCaptured: false,
    ...overrides,
  };
}

function link(overrides: Pick<BrowserRecordingLink, 'id' | 'fromEventId' | 'fromPath' | 'toEventId' | 'toPath'>): BrowserRecordingLink {
  return { traceId: 'trace-1', kind: 'value', confidence: 'exact', ...overrides };
}

const safeArguments: BrowserRecordingCallArgument[] = [
  { index: 0, role: 'data', dataType: 'string', byteLength: 52, replaceable: true, retained: true },
  { index: 1, role: 'key', dataType: 'Object', byteLength: 16, replaceable: false, retained: true },
  {
    index: 2,
    role: 'options',
    dataType: 'Object',
    replaceable: false,
    retained: true,
    summary: 'mode=CBC padding=Pkcs7 ivBytes=16',
  },
];

const cryptoJsAES = {
  adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.encrypt', algorithm: 'AES.encrypt',
} as const;
const cryptoJsAESDecrypt = {
  adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.decrypt', algorithm: 'AES.decrypt',
} as const;
const webCryptoAES = {
  adapterId: 'webcrypto', providerKind: 'native', family: 'symmetric', operation: 'encrypt', algorithm: 'AES-GCM',
} as const;
const cryptoJsHmac = {
  adapterId: 'cryptojs', providerKind: 'library', family: 'mac', operation: 'HmacSHA256', algorithm: 'HmacSHA256',
} as const;

describe('browser profile inference', () => {
  it('turns a JSEncrypt RSA result mapped to a form field into a ready profile', () => {
    const rsa = event({
      id: 'rsa-1', sequence: 1, kind: 'crypto', operation: 'encrypt',
      crypto: {
        adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation: 'encrypt', algorithm: 'RSA',
        padding: 'PKCS1-v1_5', inputEncoding: 'utf8', outputEncoding: 'base64',
        key: { kind: 'public', bits: 1024, fingerprint: 'key-fingerprint' },
      },
      callHandleId: 'rsa-handle', callableCapable: true,
      arguments: [{ index: 0, role: 'data', dataType: 'string', byteLength: 44, replaceable: true, retained: true }],
      inputs: [{ path: '$input', fingerprint: 'plain-json', encoding: 'text', byteLength: 44 }],
      outputs: [{ path: '$output', fingerprint: 'rsa-cipher', encoding: 'text', byteLength: 172 }],
    });
    const request = event({
      id: 'request-rsa', sequence: 2, kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/encrypt/rsa.php',
      inputs: [{ path: '$body:form.data', fingerprint: 'rsa-cipher', encoding: 'text', byteLength: 172 }],
    });
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 },
      events: [rsa, request],
      links: [link({ id: 'rsa-link', fromEventId: rsa.id, fromPath: '$output', toEventId: request.id, toPath: '$body:form.data' })],
    });

    expect(candidate).toMatchObject({
      status: 'ready',
      request: {
        destination: 'body.data',
        serialization: 'form-field',
        mappings: [{ sourceEventId: 'rsa-1', destination: 'body.data', serialization: 'form-field' }],
      },
      source: {
        eventId: 'rsa-1',
        callHandleId: 'rsa-handle',
        crypto: { adapterId: 'jsencrypt', algorithm: 'RSA', padding: 'PKCS1-v1_5' },
      },
      confidence: { level: 'high', score: 100 },
    });
    expect(candidate.summary).toContain('JSEncrypt RSA');
  });

  it('turns an exact CryptoJS-to-JSON-field link into a high-confidence capture candidate', () => {
    const crypto = event({
      id: 'crypto-1', sequence: 1, kind: 'crypto', operation: 'AES.encrypt', crypto: cryptoJsAES,
      callHandleId: 'handle-1', callableCapable: true, arguments: safeArguments,
      inputs: [{ path: '$input', fingerprint: 'plain', encoding: 'text', byteLength: 52 }],
      outputs: [{ path: '$output:string', fingerprint: 'cipher', encoding: 'text', byteLength: 88 }],
    });
    const request = event({
      id: 'request-1', sequence: 2, kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/api/login',
      inputs: [{ path: '$body:json.encryptedData', fingerprint: 'cipher', encoding: 'text', byteLength: 88 }],
    });
    const candidates = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0, documentId: 'document-1' },
      events: [crypto, request],
      links: [link({ id: 'link-1', fromEventId: crypto.id, fromPath: '$output:string', toEventId: request.id, toPath: '$body:json.encryptedData' })],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: 'ready',
      request: { destination: 'body.encryptedData', serialization: 'json-field' },
      source: { eventId: 'crypto-1', callHandleId: 'handle-1', arguments: safeArguments },
      confidence: { level: 'high', score: 100 },
    });
    expect(candidates[0].evidence.some((item) => item.kind === 'exact-value' && item.strength === 'proven')).toBe(true);
    expect(candidates[0].aiContext.valuePolicy).toBe('metadata-only');
  });

  it('captures the business envelope when a request uses a structured crypto result subfield', () => {
    const crypto = event({
      id: 'structured-crypto', sequence: 1, kind: 'crypto', operation: 'encrypt', crypto: cryptoJsAES,
      callHandleId: 'structured-handle', callableCapable: true, arguments: safeArguments,
      inputs: [{ path: '$input', fingerprint: 'plain', encoding: 'text', byteLength: 8 }],
      outputs: [{ path: '$output.ciphertext', fingerprint: 'encoded-child', encoding: 'hex', byteLength: 16 }],
    });
    const request = event({
      id: 'structured-request', sequence: 2, kind: 'fetch', operation: 'request', method: 'POST',
      url: 'https://example.test/submit',
      inputs: [{ path: '$body:json.password', fingerprint: 'encoded-child', encoding: 'hex', byteLength: 16 }],
    });
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 },
      events: [crypto, request],
      links: [link({
        id: 'structured-output-link',
        fromEventId: crypto.id,
        fromPath: '$output.ciphertext',
        toEventId: request.id,
        toPath: '$body:json.password',
      })],
    });

    expect(candidate).toMatchObject({
      status: 'capture-required',
      request: { destination: 'body.password', serialization: 'json-field' },
      capturePlan: {
        transaction: {
          version: 2,
          prerequisites: [],
          request: { expectedDestinations: ['body.password'], bodyFormat: 'json' },
        },
      },
    });
    expect(candidate.missing[0].label).toContain('上层业务函数');
  });

  it('compiles an evidence-linked online key request into an ordered request transaction', () => {
    const keyRequest = event({
      id: 'key-request', sequence: 1, kind: 'fetch', operation: 'request', direction: 'send',
      channelId: 'fetch-key', method: 'GET', url: 'http://127.0.0.1:82/encrypt/server_generate_key.php',
    });
    const crypto = event({
      id: 'crypto-online-key', sequence: 3, kind: 'crypto', operation: 'AES.encrypt', crypto: cryptoJsAES,
      callHandleId: 'handle-online-key', callableCapable: true, arguments: safeArguments,
      inputs: [
        { path: '$key', fingerprint: 'server-key', encoding: 'base64', byteLength: 24 },
        { path: '$options.iv', fingerprint: 'server-iv', encoding: 'base64', byteLength: 24 },
      ],
      outputs: [{ path: '$output:string', fingerprint: 'server-cipher', encoding: 'text', byteLength: 88 }],
    });
    // Fetch body readers emit their final structured response after the consumer resumes.
    const keyResponse = event({
      id: 'key-response', sequence: 4, kind: 'fetch', operation: 'response', direction: 'receive',
      channelId: 'fetch-key', method: 'GET', url: 'http://127.0.0.1:82/encrypt/server_generate_key.php',
      statusCode: 200, dataType: 'Object', resultByteLength: 76,
      outputs: [
        { path: '$body.aes_key', fingerprint: 'server-key', encoding: 'base64', byteLength: 24 },
        { path: '$body.aes_iv', fingerprint: 'server-iv', encoding: 'base64', byteLength: 24 },
      ],
    });
    const finalRequest = event({
      id: 'server-aes-request', sequence: 5, kind: 'fetch', operation: 'request', direction: 'send',
      channelId: 'fetch-final', method: 'POST', url: 'http://127.0.0.1:82/encrypt/aesserver.php',
      inputs: [{ path: '$body:json.encryptedData', fingerprint: 'server-cipher', encoding: 'text', byteLength: 88 }],
    });
    const events = [keyRequest, crypto, keyResponse, finalRequest];
    const candidates = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0, documentId: 'document-1' },
      events,
      links: buildRecordingLinks(events),
    });
    const candidate = candidates.find((item) => item.request.eventId === finalRequest.id);

    expect(candidate).toMatchObject({
      status: 'capture-required',
      capturePlan: {
        transaction: {
          version: 2,
          prerequisites: [{
            boundary: 'fetch',
            method: 'GET',
            url: keyRequest.url,
            requestBodyFormat: 'none',
            response: {
              statusCode: 200,
              url: keyResponse.url,
              bodyFormat: 'json',
              requiredPaths: ['body.aes_key', 'body.aes_iv'],
            },
          }],
          request: {
            boundary: 'fetch',
            method: 'POST',
            url: finalRequest.url,
            expectedDestinations: ['body.encryptedData'],
            bodyFormat: 'json',
          },
        },
      },
    });
    expect(candidate?.summary).toContain('在线前置请求');
    expect(candidate?.evidence).toContainEqual(expect.objectContaining({
      kind: 'response-boundary', strength: 'proven', eventIds: [keyRequest.id, keyResponse.id, crypto.id],
    }));
  });

  it('follows a bounded exact-value chain through an intermediate encoder', () => {
    const crypto = event({
      id: 'crypto-1', sequence: 1, kind: 'crypto', operation: 'encrypt', crypto: webCryptoAES,
      callHandleId: 'handle-1', callableCapable: true, arguments: safeArguments,
      outputs: [{ path: '$output', fingerprint: 'raw-cipher', encoding: 'base64', byteLength: 64 }],
    });
    const encoder = event({
      id: 'encode-1', sequence: 2, kind: 'transform', operation: 'base64.encode',
      inputs: [{ path: '$input', fingerprint: 'raw-cipher', encoding: 'base64', byteLength: 64 }],
      outputs: [{ path: '$output', fingerprint: 'encoded-cipher', encoding: 'text', byteLength: 88 }],
    });
    const request = event({
      id: 'request-1', sequence: 3, kind: 'xhr', operation: 'request', method: 'POST', url: 'https://example.test/api/login',
      inputs: [{ path: '$headers.x-signature', fingerprint: 'encoded-cipher', encoding: 'text', byteLength: 88 }],
    });
    const candidates = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 },
      events: [crypto, encoder, request],
      links: [
        link({ id: 'link-1', fromEventId: crypto.id, fromPath: '$output', toEventId: encoder.id, toPath: '$input' }),
        link({ id: 'link-2', fromEventId: encoder.id, fromPath: '$output', toEventId: request.id, toPath: '$headers.x-signature' }),
      ],
    });

    const cryptoCandidate = candidates.find((item) => item.source.eventId === crypto.id);
    expect(candidates).toHaveLength(1);
    expect(cryptoCandidate?.request.destination).toBe('header.x-signature');
    expect(cryptoCandidate?.evidence.filter((item) => item.kind === 'exact-value')).toHaveLength(2);
    expect(cryptoCandidate?.flow).toContain('1 个中间转换');
  });

  it('keeps the field destination when an envelope also links to the whole request body', () => {
    const crypto = event({
      id: 'crypto-1', sequence: 1, kind: 'crypto', operation: 'SHA256', crypto: cryptoJsHmac,
      callHandleId: 'handle-1', callableCapable: true, arguments: safeArguments,
      outputs: [{ path: '$output', fingerprint: 'digest', encoding: 'text', byteLength: 64 }],
    });
    const envelope = event({
      id: 'form-envelope', sequence: 2, kind: 'transform', operation: 'URLSearchParams',
      inputs: [{ path: '$input:form.encryptedData', fingerprint: 'digest', encoding: 'text', byteLength: 64 }],
      outputs: [
        { path: '$output', fingerprint: 'form-body', encoding: 'text', byteLength: 96 },
        { path: '$output:form.encryptedData', fingerprint: 'digest', encoding: 'text', byteLength: 64 },
        { path: '$output:form.channel', fingerprint: 'channel', encoding: 'text', byteLength: 7 },
      ],
    });
    const request = event({
      id: 'request-1', sequence: 3, kind: 'fetch', operation: 'request', method: 'POST',
      url: 'https://example.test/session',
      inputs: [
        { path: '$body', fingerprint: 'form-body', encoding: 'text', byteLength: 96 },
        { path: '$body:form.encryptedData', fingerprint: 'digest', encoding: 'text', byteLength: 64 },
        { path: '$body:form.channel', fingerprint: 'channel', encoding: 'text', byteLength: 7 },
      ],
    });
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 },
      events: [crypto, envelope, request],
      links: [
        link({
          id: 'crypto-envelope',
          fromEventId: crypto.id,
          fromPath: '$output',
          toEventId: envelope.id,
          toPath: '$input:form.encryptedData',
        }),
        link({
          id: 'envelope-body',
          fromEventId: envelope.id,
          fromPath: '$output',
          toEventId: request.id,
          toPath: '$body',
        }),
        link({
          id: 'envelope-field',
          fromEventId: envelope.id,
          fromPath: '$output:form.encryptedData',
          toEventId: request.id,
          toPath: '$body:form.encryptedData',
        }),
        link({
          id: 'envelope-channel',
          fromEventId: envelope.id,
          fromPath: '$output:form.channel',
          toEventId: request.id,
          toPath: '$body:form.channel',
        }),
      ],
    });

    expect(candidate.request).toMatchObject({
      destination: 'body.encryptedData',
      serialization: 'form-field',
    });
    expect(candidate.status).toBe('capture-required');
    expect(candidate.evidence).toContainEqual(expect.objectContaining({
      id: 'evidence-link-envelope-field',
      toPath: '$body:form.encryptedData',
    }));
  });

  it.each([
    ['$body:form.encryptedData', 'body.encryptedData'],
    ['$query.signature', 'query.signature'],
  ])('maps generic serialized request evidence %s to %s', (toPath, destination) => {
    const crypto = event({
      id: 'crypto-1', sequence: 1, kind: 'crypto', operation: 'AES.encrypt', crypto: cryptoJsAES,
      callHandleId: 'handle-1', callableCapable: true, arguments: safeArguments,
      outputs: [{ path: '$output:string', fingerprint: 'cipher', encoding: 'text', byteLength: 88 }],
    });
    const request = event({
      id: 'request-1', sequence: 2, kind: 'fetch', operation: 'request', method: 'POST',
      url: 'https://example.test/session',
      inputs: [{ path: toPath, fingerprint: 'cipher', encoding: 'text', byteLength: 88 }],
    });
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 },
      events: [crypto, request],
      links: [link({ id: 'link-1', fromEventId: crypto.id, fromPath: '$output:string', toEventId: request.id, toPath })],
    });

    expect(candidate.request.destination).toBe(destination);
    expect(candidate.confidence.level).toBe('high');
    expect(candidate.request.serialization).toBe(toPath.startsWith('$body:form.') ? 'form-field' : 'query');
  });

  it('keeps a same-trace temporal guess low-confidence and never includes captured values in AI context', () => {
    const crypto = event({
      id: 'crypto-1', sequence: 1, kind: 'crypto', operation: 'HmacSHA256', crypto: cryptoJsHmac,
      inputPreview: 'plain-password', outputPreview: 'secret-signature', arguments: safeArguments,
    });
    const request = event({
      id: 'request-1', sequence: 2, kind: 'fetch', operation: 'request', method: 'POST',
      url: 'https://example.test/api/login?token=secret-query-value&mode=fast#private-fragment',
      inputPreview: '{"password":"plain-password"}',
    });
    const [candidate] = inferBrowserTransformProfiles({ target: { tabId: 7, frameId: 0 }, events: [crypto, request], links: [] });

    expect(candidate.status).toBe('capture-required');
    expect(candidate.confidence.level).toBe('low');
    expect(JSON.stringify(candidate)).not.toContain('plain-password');
    expect(JSON.stringify(candidate)).not.toContain('secret-signature');
    expect(JSON.stringify(candidate.aiContext)).not.toContain('secret-query-value');
    expect(JSON.stringify(candidate.aiContext)).not.toContain('private-fragment');
    expect(candidate.aiContext.request.url).toBe('https://example.test/api/login?mode&token');
    expect(candidate.summary).toContain('可继续捕获完整页面业务封装');
    expect(candidate.missing[0].label).not.toMatch(/更短|重新录制一次|操作太长/);
  });

  it('continues from an unknown request boundary even when no known crypto library is visible', () => {
    const request = event({
      id: 'opaque-request', sequence: 1, kind: 'fetch', operation: 'request', method: 'POST',
      url: 'https://example.test/opaque', stack: 'at pack (https://example.test/chunk-a.js:1:42)',
    });
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 }, events: [request], links: [],
    });

    expect(candidate).toMatchObject({ status: 'capture-required', source: { operation: 'unknown-business-envelope' } });
    expect(candidate.summary).toContain('算法或库未知不影响继续捕获');
    expect(candidate.aiContext.requiredDecision).toBe('capture-business-callable');
    expect(candidate.capturePlan).toMatchObject({ matcherEventId: request.id, sourceCount: 1 });
  });

  it('treats a Worker round trip as correlated evidence rather than an exact value proof', () => {
    const crypto = event({
      id: 'crypto', sequence: 1, kind: 'crypto', operation: 'encrypt', crypto: webCryptoAES,
      outputs: [{ path: '$output', fingerprint: 'plain-to-worker', encoding: 'base64', byteLength: 32 }],
    });
    const send = event({
      id: 'worker-send', sequence: 2, kind: 'worker', operation: 'worker.postMessage', direction: 'send', channelId: 'channel-1',
      inputs: [{ path: '$message', fingerprint: 'plain-to-worker', encoding: 'base64', byteLength: 32 }],
    });
    const receive = event({
      id: 'worker-receive', sequence: 3, kind: 'worker', operation: 'worker.message', direction: 'receive', channelId: 'channel-1',
      outputs: [{ path: '$message', fingerprint: 'worker-result', encoding: 'text', byteLength: 64 }],
    });
    const request = event({
      id: 'request', sequence: 4, kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/submit',
      inputs: [{ path: '$body:json.payload', fingerprint: 'worker-result', encoding: 'text', byteLength: 64 }],
    });
    const links: BrowserRecordingLink[] = [
      link({ id: 'value-in', fromEventId: crypto.id, fromPath: '$output', toEventId: send.id, toPath: '$message' }),
      { id: 'channel', traceId: 'trace-1', kind: 'channel', confidence: 'correlated', fromEventId: send.id, fromPath: '$message', toEventId: receive.id, toPath: '$message' },
      link({ id: 'value-out', fromEventId: receive.id, fromPath: '$message', toEventId: request.id, toPath: '$body:json.payload' }),
    ];
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 }, events: [crypto, send, receive, request], links,
    });

    expect(candidate.status).toBe('capture-required');
    expect(candidate.request.destination).toBe('body.payload');
    expect(candidate.evidence.some((item) => item.kind === 'message-boundary' && item.strength === 'supported')).toBe(true);
  });

  it('groups hybrid AES and RSA outputs into one request graph and refuses unsafe independent replay', () => {
    const sources = [
      event({
        id: 'aes-data', sequence: 1, kind: 'crypto', operation: 'AES.encrypt', crypto: cryptoJsAES,
        callHandleId: 'aes-handle', callableCapable: true, arguments: safeArguments,
        stack: 'at aes (https://example.test/vendor/aes.js:1:1)\n    at _0xPacket (https://example.test/app.js:40:2)\n    at onclick (https://example.test/app.js:90:1)',
        outputs: [{ path: '$output:string', fingerprint: 'cipher-data', encoding: 'text', byteLength: 88 }],
      }),
      event({
        id: 'rsa-key', sequence: 2, kind: 'crypto', operation: 'encrypt',
        crypto: { adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation: 'encrypt', algorithm: 'RSA' },
        callHandleId: 'rsa-key-handle', callableCapable: true, arguments: safeArguments.slice(0, 1),
        stack: 'at rsa (https://example.test/vendor/rsa.js:1:1)\n    at _0xPacket (https://example.test/app.js:51:2)\n    at onclick (https://example.test/app.js:90:1)',
        outputs: [{ path: '$output', fingerprint: 'cipher-key', encoding: 'text', byteLength: 172 }],
      }),
      event({
        id: 'rsa-iv', sequence: 3, kind: 'crypto', operation: 'encrypt',
        crypto: { adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation: 'encrypt', algorithm: 'RSA' },
        callHandleId: 'rsa-iv-handle', callableCapable: true, arguments: safeArguments.slice(0, 1),
        stack: 'at rsa (https://example.test/vendor/rsa.js:8:1)\n    at _0xPacket (https://example.test/app.js:58:2)\n    at onclick (https://example.test/app.js:90:1)',
        outputs: [{ path: '$output', fingerprint: 'cipher-iv', encoding: 'text', byteLength: 172 }],
      }),
    ];
    const request = event({
      id: 'hybrid-request', sequence: 4, kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/encrypt/aesrsa.php',
      inputs: [
        { path: '$body:json.encryptedData', fingerprint: 'cipher-data', encoding: 'text', byteLength: 88 },
        { path: '$body:json.encryptedKey', fingerprint: 'cipher-key', encoding: 'text', byteLength: 172 },
        { path: '$body:json.encryptedIv', fingerprint: 'cipher-iv', encoding: 'text', byteLength: 172 },
      ],
    });
    const links = sources.map((source, index) => link({
      id: `hybrid-link-${index}`,
      fromEventId: source.id,
      fromPath: source.outputs[0].path,
      toEventId: request.id,
      toPath: request.inputs[index].path,
    }));

    const [candidate] = inferBrowserTransformProfiles({ target: { tabId: 7, frameId: 0 }, events: [...sources, request], links });
    expect(candidate.sources).toHaveLength(3);
    expect(candidate.request.mappings.map((item) => item.destination)).toEqual([
      'body.encryptedData', 'body.encryptedKey', 'body.encryptedIv',
    ]);
    expect(candidate.request.bodyFormat).toBe('json');
    expect(candidate.status).toBe('capture-required');
    expect(candidate.summary).toContain('3 个密码调用');
    expect(candidate.missing[0].label).toContain('随机 Key、IV、Nonce');
    expect(candidate.capturePlan).toMatchObject({
      matcherEventId: sources[0].id,
      sourceCount: 3,
      expectedDestinations: ['body.encryptedData', 'body.encryptedKey', 'body.encryptedIv'],
    });
    expect(candidate.capturePlan?.frameHints[0]).toMatchObject({ functionName: '_0xPacket', support: 3 });
  });

  it('keeps a stateful signature session as one request source and exposes its ordered stages', () => {
    const crypto = (operation: string, phase: 'create' | 'update' | 'final') => ({
      adapterId: 'jsrsasign', providerKind: 'library' as const, family: 'signature' as const, operation,
      algorithm: 'SHA256withRSA',
      state: { model: 'session' as const, correlationId: 'signature-session-1', phase },
    });
    const create = event({
      id: 'signature-create', sequence: 1, kind: 'crypto', operation: 'Signature.create', crypto: crypto('Signature.create', 'create'),
    });
    const update = event({
      id: 'signature-update', sequence: 2, kind: 'crypto', operation: 'Signature.updateString', crypto: crypto('Signature.updateString', 'update'),
    });
    const final = event({
      id: 'signature-final', sequence: 3, kind: 'crypto', operation: 'Signature.sign', crypto: crypto('Signature.sign', 'final'),
      outputs: [{ path: '$output', fingerprint: 'signature', encoding: 'hex', byteLength: 64 }],
    });
    const request = event({
      id: 'signed-request', sequence: 4, kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/api/signed',
      inputs: [{ path: '$headers.x-signature', fingerprint: 'signature', encoding: 'hex', byteLength: 64 }],
    });
    const links: BrowserRecordingLink[] = [
      { id: 'state-create-update', traceId: 'trace-1', kind: 'state', confidence: 'correlated', fromEventId: create.id, fromPath: '$state.create', toEventId: update.id, toPath: '$state.update' },
      { id: 'state-update-final', traceId: 'trace-1', kind: 'state', confidence: 'correlated', fromEventId: update.id, fromPath: '$state.update', toEventId: final.id, toPath: '$state.final' },
      link({ id: 'signature-request', fromEventId: final.id, fromPath: '$output', toEventId: request.id, toPath: '$headers.x-signature' }),
    ];

    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 }, events: [create, update, final, request], links,
    });
    expect(candidate.sources).toHaveLength(1);
    expect(candidate.source.eventId).toBe(final.id);
    expect(candidate.request.destination).toBe('header.x-signature');
    expect(candidate.evidence).toContainEqual(expect.objectContaining({
      kind: 'state-sequence', eventIds: [create.id, update.id, final.id],
    }));
    expect(candidate.capturePlan).toMatchObject({ sourceCount: 3 });
  });

  it('traces canonical JSON through a signature and Axios into a request header', () => {
    const canonical = event({
      id: 'canonical-json', sequence: 1, kind: 'transform', operation: 'JSON.stringify',
      transform: {
        adapterId: 'native.json',
        providerKind: 'native',
        category: 'serializer',
        phase: 'output',
      },
      inputs: [{ path: '$input.account', fingerprint: 'account', encoding: 'text', byteLength: 5 }],
      outputs: [{ path: '$output', fingerprint: 'canonical', encoding: 'text', byteLength: 42 }],
    });
    const signature = event({
      id: 'signature', sequence: 2, kind: 'crypto', operation: 'HmacSHA256', crypto: cryptoJsHmac,
      callHandleId: 'signature-handle', callableCapable: true, arguments: safeArguments,
      inputs: [{ path: '$input', fingerprint: 'canonical', encoding: 'text', byteLength: 42 }],
      outputs: [{ path: '$output', fingerprint: 'signed', encoding: 'hex', byteLength: 64 }],
    });
    const axios = event({
      id: 'axios', sequence: 3, kind: 'transform', operation: 'axios.request',
      transform: {
        adapterId: 'axios',
        providerKind: 'library',
        category: 'request-builder',
        phase: 'boundary',
      },
      inputs: [{ path: '$headers.X-Signature', fingerprint: 'signed', encoding: 'hex', byteLength: 64 }],
      outputs: [{ path: '$headers.X-Signature', fingerprint: 'signed', encoding: 'hex', byteLength: 64 }],
    });
    const request = event({
      id: 'request', sequence: 4, kind: 'xhr', operation: 'request', method: 'POST', url: 'https://example.test/api/order',
      inputs: [{ path: '$headers.x-signature', fingerprint: 'signed', encoding: 'hex', byteLength: 64 }],
    });
    const events = [canonical, signature, axios, request];
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0 }, events, links: buildRecordingLinks(events),
    });

    expect(candidate.sources).toHaveLength(1);
    expect(candidate.request).toMatchObject({ destination: 'header.x-signature', serialization: 'header' });
    expect(candidate.evidence).toContainEqual(expect.objectContaining({
      kind: 'transform-lineage', strength: 'proven', eventIds: [canonical.id, signature.id],
    }));
    expect(candidate.flow).toContain('1 个输入准备步骤');
    expect(candidate.flow).toContain('1 个中间转换');
  });

  it.each([
    ['response observed before decrypt', 1, 2],
    ['response body reader completed after decrypt', 3, 2],
  ])('infers a ready response gateway when %s', (_label, responseSequence, decryptSequence) => {
    const response = event({
      id: 'encrypted-response', sequence: responseSequence, kind: 'fetch', operation: 'response',
      direction: 'receive', method: 'GET', url: 'https://example.test/api/profile', statusCode: 200,
      outputs: [{ path: '$body:json.encryptedData', fingerprint: 'response-cipher', encoding: 'text', byteLength: 88 }],
    });
    const decrypt = event({
      id: 'decrypt-response', sequence: decryptSequence, kind: 'crypto', operation: 'AES.decrypt',
      crypto: cryptoJsAESDecrypt,
      callHandleId: 'decrypt-handle', callableCapable: true,
      arguments: safeArguments,
      inputs: [{ path: '$input', fingerprint: 'response-cipher', encoding: 'text', byteLength: 88 }],
      outputs: [{ path: '$output', fingerprint: 'response-plain', encoding: 'text', byteLength: 42 }],
    });
    const events = [response, decrypt];
    const [candidate] = inferBrowserTransformProfiles({
      target: { tabId: 7, frameId: 0, documentId: 'document-1' },
      events,
      links: buildRecordingLinks(events),
    });

    expect(candidate).toMatchObject({
      direction: 'response',
      status: 'ready',
      request: {
        eventId: response.id,
        destination: 'body.encryptedData',
        serialization: 'json-field',
      },
      source: { eventId: decrypt.id, callHandleId: 'decrypt-handle' },
      confidence: { level: 'high', score: 100 },
    });
    expect(candidate.pipeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'context.read', source: 'body.encryptedData' }),
      expect.objectContaining({ kind: 'output.write', destination: 'body' }),
    ]));
    expect(candidate.evidence).toContainEqual(expect.objectContaining({
      kind: 'response-boundary', strength: 'proven',
    }));
    expect(candidate.aiContext.requiredDecision).toBe('none');
  });
});
