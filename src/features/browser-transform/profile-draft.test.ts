import { describe, expect, it } from 'vitest';
import type {
  ActiveTabInfo,
  BrowserPageCallable,
  BrowserProfileInferenceCandidate,
} from '@/types/models';
import { createBrowserTransformProfileInput } from './profile-draft';

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
    expect(profile.name).toContain('响应明文网关');
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
