import { describe, expect, it } from 'vitest';
import type { BrowserProfileInferenceCandidate, BrowserRecordingEvent } from '@/types/models';
import { browserGatewayNextStep, recordingEventDirection } from './presentation';

const event = (id: string, kind: BrowserRecordingEvent['kind'], operation: string): BrowserRecordingEvent => ({
  id, kind, operation, sequence: 1, timestamp: 1, recordingId: 'recording-1', traceId: 'trace-1',
  inputs: [], outputs: [], sensitiveCaptured: false,
});

const candidate = (direction: 'request' | 'response', status: BrowserProfileInferenceCandidate['status']): BrowserProfileInferenceCandidate => ({
  id: `candidate-${direction}`, recordingId: 'recording-1', traceId: 'trace-1',
  target: { tabId: 1, frameId: 0 }, direction,
  request: { eventId: `${direction}-boundary`, method: 'POST', url: 'https://example.test/login', bodyFormat: 'json', mappings: [] },
  source: { eventId: `${direction}-crypto`, kind: 'crypto', operation: direction === 'request' ? 'AES.encrypt' : 'AES.decrypt', arguments: [] },
  sources: [], status, confidence: { score: 100, level: 'high' }, summary: '', flow: [], pipeline: [], evidence: [{
    id: `${direction}-evidence`, kind: direction === 'request' ? 'request-boundary' : 'response-boundary', strength: 'proven',
    label: '', eventIds: [`${direction}-boundary`, `${direction}-crypto`, `${direction}-transform`],
  }], missing: status === 'capture-required' ? [{ kind: 'business-callable', label: 'capture', action: 'capture-business-function' }] : [],
  aiContext: {
    valuePolicy: 'metadata-only',
    request: { eventId: `${direction}-boundary`, method: 'POST', url: 'https://example.test/login' },
    source: { eventId: `${direction}-crypto`, kind: 'crypto', operation: direction === 'request' ? 'AES.encrypt' : 'AES.decrypt', arguments: [] },
    sources: [], evidenceIds: [], requiredDecision: status === 'ready' ? 'none' : 'capture-business-callable',
  },
});

describe('recording presentation', () => {
  it('labels network boundaries and linked transform events by direction', () => {
    const request = candidate('request', 'ready');
    const response = candidate('response', 'ready');

    expect(recordingEventDirection(event('request-boundary', 'fetch', 'request'), [request, response])).toBe('request');
    expect(recordingEventDirection(event('response-boundary', 'fetch', 'response'), [request, response])).toBe('response');
    expect(recordingEventDirection(event('response-transform', 'transform', 'Hex.parse'), [request, response])).toBe('response');
    expect(recordingEventDirection(event('unrelated', 'transform', 'JSON.stringify'), [request, response])).toBeUndefined();
  });

  it('offers the next incomplete direction instead of claiming the gateway is finished', () => {
    const request = candidate('request', 'capture-required');
    const response = candidate('response', 'ready');

    expect(browserGatewayNextStep(response, request)).toMatchObject({
      kind: 'capture', candidate: request, label: '继续捕获请求方向',
    });
    expect(browserGatewayNextStep(response, { ...request, status: 'ready' })).toMatchObject({
      kind: 'create', label: '生成双向协议网关',
    });
    expect(browserGatewayNextStep(response)).toMatchObject({
      kind: 'create', label: '生成仅响应网关',
    });
  });
});
