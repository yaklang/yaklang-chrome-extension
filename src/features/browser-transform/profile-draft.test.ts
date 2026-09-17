import { describe, expect, it } from 'vitest';
import type {
  ActiveTabInfo,
  BrowserPageCallable,
  BrowserProfileInferenceCandidate,
} from '@/types/models';
import { createBrowserTransformProfileInput, pairedBrowserTransformCandidate } from './profile-draft';
import { executeTransformDirection } from './mapping';

const tab: ActiveTabInfo = {
  id: 7,
  windowId: 1,
  title: 'Encrypted API',
  url: 'https://example.test/app',
  incognito: false,
};

const callable: BrowserPageCallable = {
  id: 'decrypt-callable',
  name: '页面 AES 解密',
  kind: 'recorded-call',
  operation: 'AES.decrypt',
  origin: 'https://example.test',
  target: { tabId: 7, frameId: 0, documentId: 'document-1' },
  lifecycle: 'document',
  execution: { resultMode: 'sync', timeoutMs: 8_000 },
  inputSlots: [{
    id: 'data', name: 'data', index: 0, role: 'data', dataType: 'string', required: true, retained: false,
  }],
  output: { dataType: 'string', encoding: 'utf8', shape: 'value', paths: [] },
  provenance: { eventId: 'decrypt-event' },
  createdAt: 1,
};

const responseCandidate = {
  id: 'candidate-response',
  recordingId: 'recording-1',
  traceId: 'trace-1',
  target: callable.target,
  direction: 'response',
  request: {
    eventId: 'response-event', method: 'GET', url: 'https://example.test/api/profile', bodyFormat: 'json',
    destination: 'body.encryptedData', serialization: 'json-field',
    mappings: [{ sourceEventId: 'decrypt-event', destination: 'body.encryptedData', serialization: 'json-field' }],
  },
  source: {
    eventId: 'decrypt-event', kind: 'crypto', operation: 'AES.decrypt', callHandleId: 'decrypt-handle',
    arguments: callable.inputSlots.map((slot) => ({
      index: slot.index, role: slot.role, dataType: slot.dataType, replaceable: true, retained: false,
    })),
    destination: 'body.encryptedData', serialization: 'json-field',
  },
  sources: [],
  status: 'ready',
  confidence: { score: 100, level: 'high' },
  summary: 'ready',
  flow: [],
  pipeline: [],
  evidence: [],
  missing: [],
  aiContext: {
    valuePolicy: 'metadata-only',
    request: { eventId: 'response-event', method: 'GET', url: 'https://example.test/api/profile' },
    source: { eventId: 'decrypt-event', kind: 'crypto', operation: 'AES.decrypt', arguments: [] },
    sources: [], evidenceIds: [], requiredDecision: 'none',
  },
} satisfies BrowserProfileInferenceCandidate;

describe('browser transform profile draft', () => {
  it('reads only the captured form field for a single string input and rejects ambiguous fields', async () => {
    const candidate = { ...responseCandidate, direction: 'request' as const,
      request: { ...responseCandidate.request, bodyFormat: 'form' as const, serialization: 'form-field' as const } };
    const packet = { method: 'POST', url: candidate.request.url,
      headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded; charset=utf-8' }],
      bodyBase64: btoa('encryptedData={"username":"admin","password":"admin123"}') };
    const profile = createBrowserTransformProfileInput(tab, undefined, callable, candidate, packet);
    expect(profile.request.nodes.filter((node) => node.kind === 'context.read')).toMatchObject([{ path: 'body.encryptedData' }]);
    let received: unknown[] = [];
    await executeTransformDirection('test', 'request', profile.request, packet, async (callableId, args) => {
      received = args;
      return { callableId, type: 'string', preview: 'cipher', value: 'cipher', durationMs: 1 };
    });
    expect(received).toEqual(['{"username":"admin","password":"admin123"}']);
    for (const body of ['username=admin', 'encryptedData=a&encryptedData=b']) {
      expect(() => createBrowserTransformProfileInput(tab, undefined, callable, candidate, { ...packet, bodyBase64: btoa(body) })).toThrow(/input_paths/);
    }
    const jsonPacket = { ...packet, headers: [{ name: 'Content-Type', value: 'application/json' }], bodyBase64: btoa('{"username":"admin"}') };
    expect(createBrowserTransformProfileInput(tab, undefined, callable, candidate, jsonPacket).request.nodes[0]).toMatchObject({ path: 'body' });
  });
  it('compiles an inferred response decryptor into the response direction', () => {
    const profile = createBrowserTransformProfileInput(tab, undefined, callable, responseCandidate);

    expect(profile.request).toEqual({ enabled: false, nodes: [] });
    expect(profile.response.enabled).toBe(true);
    expect(profile.response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'context.read', path: 'body.encryptedData' }),
      expect.objectContaining({ kind: 'page.call', callableId: callable.id }),
      expect.objectContaining({ kind: 'output.write', destination: 'body' }),
    ]));
    expect(profile.match).toEqual({ methods: ['GET'], urlPattern: '*/api/profile' });
    expect(profile.name).toContain('浏览器协议网关');
  });

  it('maps response ciphertext, key, and iv into one decrypt callable', async () => {
    const dynamicCallable: BrowserPageCallable = {
      ...callable,
      inputSlots: [
        callable.inputSlots[0],
        { id: 'key', name: 'key', index: 1, role: 'key', dataType: 'string', required: true, retained: false },
        { id: 'iv', name: 'iv', index: 2, role: 'iv', dataType: 'string', required: true, retained: false },
      ],
    };
    const dynamicCandidate: BrowserProfileInferenceCandidate = {
      ...responseCandidate,
      request: {
        ...responseCandidate.request,
        mappings: [
          { sourceEventId: 'decrypt-event', destination: 'body.message', serialization: 'json-field' },
          { sourceEventId: 'decrypt-event', destination: 'body.key', serialization: 'json-field' },
          { sourceEventId: 'decrypt-event', destination: 'body.iv', serialization: 'json-field' },
        ],
      },
    };
    const profile = createBrowserTransformProfileInput(tab, undefined, dynamicCallable, dynamicCandidate);
    const packet = {
      method: 'POST', url: dynamicCandidate.request.url,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: btoa(JSON.stringify({ message: 'cipher', key: '0011', iv: 'aabb' })),
    };
    let received: unknown[] = [];

    await executeTransformDirection('test', 'response', profile.response, packet, async (callableId, args) => {
      received = args;
      return { callableId, type: 'string', preview: 'plain', value: 'plain', durationMs: 1 };
    });

    expect(received).toEqual(['cipher', '0011', 'aabb']);
  });

  it('pairs one browser transaction and compiles both directions into one profile', () => {
    const requestCandidate: BrowserProfileInferenceCandidate = {
      ...responseCandidate,
      id: 'candidate-request',
      transactionId: 'fetch-1',
      direction: 'request',
      request: { ...responseCandidate.request, eventId: 'request-event', method: 'POST' },
    };
    const pairedResponse: BrowserProfileInferenceCandidate = {
      ...responseCandidate,
      transactionId: 'fetch-1',
      request: { ...responseCandidate.request, method: 'POST' },
    };
    const encryptCallable: BrowserPageCallable = {
      ...callable,
      id: 'encrypt-callable',
      name: '页面 AES 加密',
      operation: 'AES.encrypt',
      provenance: { eventId: 'encrypt-event' },
    };

    expect(pairedBrowserTransformCandidate([requestCandidate, pairedResponse], requestCandidate)?.id)
      .toBe(pairedResponse.id);
    const profile = createBrowserTransformProfileInput(
      tab,
      undefined,
      encryptCallable,
      requestCandidate,
      undefined,
      { candidate: pairedResponse, callable },
    );

    expect(profile.request.enabled).toBe(true);
    expect(profile.response.enabled).toBe(true);
    expect(profile.request.nodes).toContainEqual(expect.objectContaining({ kind: 'page.call', callableId: encryptCallable.id }));
    expect(profile.response.nodes).toContainEqual(expect.objectContaining({ kind: 'page.call', callableId: callable.id }));
    expect(profile.name).toBe('POST */api/profile 浏览器协议网关');
  });

  it('does not guess when one trace contains multiple opposite candidates for the same route', () => {
    const requestCandidate = { ...responseCandidate, id: 'request', direction: 'request' as const };
    const responseA = { ...responseCandidate, id: 'response-a' };
    const responseB = { ...responseCandidate, id: 'response-b' };

    expect(pairedBrowserTransformCandidate([requestCandidate, responseA, responseB], requestCandidate)).toBeUndefined();
    expect(() => pairedBrowserTransformCandidate([requestCandidate, responseA, responseB], requestCandidate, true))
      .toThrow('尚未保存单向网关');
  });

  it('does not pair candidates from different recording sessions', () => {
    const requestCandidate = { ...responseCandidate, id: 'request', transactionId: 'fetch-1', direction: 'request' as const };
    const staleResponse = { ...responseCandidate, id: 'stale-response', transactionId: 'fetch-1', recordingId: 'recording-old' };

    expect(pairedBrowserTransformCandidate([requestCandidate, staleResponse], requestCandidate)).toBeUndefined();
  });

  it('does not fall back to the route when transaction IDs disagree', () => {
    const requestCandidate = { ...responseCandidate, id: 'request', transactionId: 'fetch-1', direction: 'request' as const };
    const otherResponse = { ...responseCandidate, id: 'other-response', transactionId: 'fetch-2' };

    expect(pairedBrowserTransformCandidate([requestCandidate, otherResponse], requestCandidate)).toBeUndefined();
  });

  it('serializes request-transaction profiles because they mutate one browser session', () => {
    const transactionCallable: BrowserPageCallable = {
      ...callable,
      id: 'request-transaction',
      kind: 'request-transaction',
      output: { dataType: 'object', encoding: 'json', shape: 'envelope', paths: ['body.encryptedData'] },
      transaction: {
        version: 2,
        prerequisites: [],
        request: {
          boundary: 'fetch', method: 'POST', url: 'https://example.test/login',
          expectedDestinations: ['body.encryptedData'], bodyFormat: 'json',
        },
        inputMode: 'auto',
      },
    };

    expect(createBrowserTransformProfileInput(tab, undefined, transactionCallable).maxConcurrency).toBe(1);
  });
});
