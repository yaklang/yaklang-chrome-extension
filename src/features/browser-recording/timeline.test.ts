import { describe, expect, it } from 'vitest';
import type { BrowserRecordingEvent } from '@/types/models';
import {
  buildRecordingLinks,
  buildRecordingTraces,
  mergeRecordingEvents,
  nextRecordingSequence,
} from './timeline';

function event(
  id: string,
  sequence: number,
  traceId: string,
  overrides: Partial<BrowserRecordingEvent> = {},
): BrowserRecordingEvent {
  return {
    id,
    sequence,
    timestamp: 1_000 + sequence * 10,
    recordingId: 'session-1',
    traceId,
    kind: 'interaction',
    operation: 'click',
    inputs: [],
    outputs: [],
    sensitiveCaptured: false,
    ...overrides,
  };
}

describe('browser recording timeline', () => {
  it('keeps traces and their steps in top-to-bottom chronological order', () => {
    const events = [
      event('request', 3, 'trace-login', { kind: 'fetch', operation: 'request', method: 'POST', url: 'https://example.test/login' }),
      event('second-click', 5, 'trace-search', { label: '查询' }),
      event('first-click', 1, 'trace-login', { label: '登录' }),
      event('crypto', 2, 'trace-login', { kind: 'crypto', operation: 'AES.encrypt', crypto: { adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.encrypt' } }),
      event('navigation', 4, 'trace-login', {
        kind: 'navigation',
        operation: 'navigation.document',
        navigation: { phase: 'completed', kind: 'document', toUrl: 'https://example.test/success', sameDocument: false },
      }),
    ];
    const traces = buildRecordingTraces(events, []);

    expect(traces.map((trace) => trace.label)).toEqual(['登录', '查询']);
    expect(traces[0].eventIds).toEqual(['first-click', 'crypto', 'request', 'navigation']);
    expect(traces[0]).toMatchObject({ requestCount: 1, cryptoCount: 1, navigationCount: 1 });
  });

  it('updates one navigation boundary instead of duplicating its lifecycle phases', () => {
    const started = event('navigation', 2, 'trace-login', {
      kind: 'navigation',
      operation: 'navigation.document',
      navigation: { phase: 'started', kind: 'document', fromUrl: 'https://example.test/', toUrl: 'https://example.test/success', sameDocument: false },
    });
    const completed = {
      ...started,
      durationMs: 84,
      navigation: { ...started.navigation!, phase: 'completed' as const, documentId: 'document-2' },
    };
    const merged = mergeRecordingEvents([[started], [completed]]);

    expect(merged).toHaveLength(1);
    expect(merged[0].navigation?.phase).toBe('completed');
    expect(merged[0].durationMs).toBe(84);
    expect(nextRecordingSequence(merged)).toBe(3);
    expect(buildRecordingTraces(merged, [])[0]).toMatchObject({ startedAt: 1_020, endedAt: 1_104 });
  });

  it('preserves sensitive previews and the most advanced navigation phase across status snapshots', () => {
    const sensitive = event('crypto', 1, 'trace-login', {
      kind: 'crypto',
      operation: 'AES.encrypt',
      crypto: { adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.encrypt' },
      sensitiveCaptured: true,
      inputPreview: 'plain-value',
      inputs: [{ path: '$input', fingerprint: 'plain', encoding: 'text', byteLength: 11, preview: 'plain-value' }],
    });
    const metadataOnly = {
      ...sensitive,
      sensitiveCaptured: false,
      inputPreview: undefined,
      inputs: sensitive.inputs.map(({ preview: _preview, ...item }) => item),
    };
    const completedNavigation = event('navigation', 2, 'trace-login', {
      kind: 'navigation',
      operation: 'navigation.document',
      durationMs: 48,
      navigation: { phase: 'completed', kind: 'document', toUrl: 'https://example.test/success', sameDocument: false },
    });
    const pageNavigation = {
      ...completedNavigation,
      durationMs: undefined,
      navigation: { ...completedNavigation.navigation!, phase: 'started' as const },
    };

    const merged = mergeRecordingEvents([[sensitive, completedNavigation], [metadataOnly, pageNavigation]]);
    expect(merged[0]).toMatchObject({ sensitiveCaptured: true, inputPreview: 'plain-value' });
    expect(merged[0].inputs[0].preview).toBe('plain-value');
    expect(merged[1].navigation?.phase).toBe('completed');
    expect(merged[1].durationMs).toBe(48);
  });

  it('keeps exact value links separate from chronological navigation edges', () => {
    const crypto = event('crypto', 1, 'trace-login', {
      kind: 'crypto',
      operation: 'AES.encrypt',
      crypto: { adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.encrypt' },
      outputs: [{ path: '$output', fingerprint: 'cipher', encoding: 'text', byteLength: 32 }],
    });
    const request = event('request', 2, 'trace-login', {
      kind: 'fetch',
      operation: 'request',
      inputs: [{ path: '$body.encryptedData', fingerprint: 'cipher', encoding: 'text', byteLength: 32 }],
    });
    const navigation = event('navigation', 3, 'trace-login', {
      kind: 'navigation',
      operation: 'navigation.document',
      navigation: { phase: 'completed', kind: 'document', toUrl: 'https://example.test/success', sameDocument: false },
    });

    const links = buildRecordingLinks([crypto, request, navigation]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromEventId: 'crypto', toEventId: 'request' });
  });

  it('correlates delayed Worker replies with the originating channel without claiming value equality', () => {
    const send = event('send', 1, 'trace-worker', {
      kind: 'worker', operation: 'worker.postMessage', direction: 'send', channelId: 'worker-1',
    });
    const receive = event('receive', 2, 'trace-worker', {
      kind: 'worker', operation: 'worker.message', direction: 'receive', channelId: 'worker-1',
    });
    const links = buildRecordingLinks([send, receive]);

    expect(links).toEqual([expect.objectContaining({
      kind: 'channel', confidence: 'correlated', fromEventId: 'send', toEventId: 'receive',
    })]);
    expect(buildRecordingTraces([send, receive], links)[0]).toMatchObject({ messageCount: 2, linkedValueCount: 0 });
  });

  it('links ordered constructor and session stages without claiming value equality', () => {
    const state = (phase: 'create' | 'update' | 'final') => ({
      adapterId: 'jsrsasign',
      providerKind: 'library' as const,
      family: 'signature' as const,
      operation: phase === 'final' ? 'sign' : phase,
      state: { model: 'session' as const, correlationId: 'signature-session-1', phase },
    });
    const create = event('create', 1, 'trace-sign', {
      kind: 'crypto', operation: 'Signature.create', crypto: state('create'),
    });
    const update = event('update', 2, 'trace-sign', {
      kind: 'crypto', operation: 'Signature.updateString', crypto: state('update'),
    });
    const final = event('final', 3, 'trace-sign', {
      kind: 'crypto', operation: 'Signature.sign', crypto: state('final'),
      outputs: [{ path: '$output', fingerprint: 'signature', encoding: 'hex', byteLength: 64 }],
    });
    const request = event('request', 4, 'trace-sign', {
      kind: 'fetch', operation: 'request',
      inputs: [{ path: '$headers.x-signature', fingerprint: 'signature', encoding: 'hex', byteLength: 64 }],
    });

    const links = buildRecordingLinks([create, update, final, request]);
    expect(links.filter((link) => link.kind === 'state')).toEqual([
      expect.objectContaining({ fromEventId: 'create', toEventId: 'update', confidence: 'correlated' }),
      expect.objectContaining({ fromEventId: 'update', toEventId: 'final', confidence: 'correlated' }),
    ]);
    expect(links.filter((link) => link.kind === 'value')).toEqual([
      expect.objectContaining({ fromEventId: 'final', toEventId: 'request', confidence: 'exact' }),
    ]);
    expect(buildRecordingTraces([create, update, final, request], links)[0].linkedValueCount).toBe(1);
  });
});
