import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRecordingValueEvidence } from '@/types/models';
import { createRequestPreparationRuntime, type RequestPreparationHost } from './request-preparation';

function evidence(value: unknown, path: string): BrowserRecordingValueEvidence[] {
  if (value === undefined) return [];
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof URLSearchParams)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => evidence(item, `${path}.${key}`));
  }
  const text = value instanceof URLSearchParams ? value.toString() : String(value);
  return [{ path, fingerprint: `fp:${text}`, encoding: 'text', byteLength: text.length }];
}

function environment() {
  const events: Array<Record<string, unknown>> = [];
  const listeners = new Set<EventListener>();
  const document = {
    addEventListener(type: string, listener: EventListener) { if (type === 'load') listeners.add(listener); },
    removeEventListener(type: string, listener: EventListener) { if (type === 'load') listeners.delete(listener); },
  };
  const window = {
    JSON: { stringify: JSON.stringify },
    URLSearchParams,
    document,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window & {
    axios?: unknown;
    JSON: Pick<JSON, 'stringify'>;
    URLSearchParams: typeof URLSearchParams;
  };
  const host: RequestPreparationHost = {
    currentTrace: () => ({ traceId: 'trace-1', interactionId: 'interaction-1' }),
    collectEvidence: evidence,
    byteLength: (value) => value === undefined ? undefined : new TextEncoder().encode(
      typeof value === 'string' ? value : String(value),
    ).byteLength,
    dataType: (value) => typeof value,
    preview: () => undefined,
    stackInfo: () => ({ scriptUrl: 'https://example.test/app.js' }),
    emit: (event, context) => events.push({ ...event, ...context }),
  };
  return { events, window, host };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('request preparation evidence', () => {
  it('links JSON and query canonicalization without changing native return values', () => {
    vi.useFakeTimers();
    const { events, window, host } = environment();
    const runtime = createRequestPreparationRuntime(window, host);
    runtime.start();

    expect(window.JSON.stringify({ b: 2, a: 1 })).toBe('{"b":2,"a":1}');
    const params = new window.URLSearchParams('z=2&a=1');
    params.sort();
    expect(params.toString()).toBe('a=1&z=2');

    expect(events.map((event) => event.operation)).toEqual([
      'JSON.stringify', 'URLSearchParams.sort', 'URLSearchParams.toString',
    ]);
    expect(events[0].transform).toEqual({
      adapterId: 'native.json',
      providerKind: 'native',
      category: 'serializer',
      phase: 'output',
    });
    expect(events[1].transform).toEqual({
      adapterId: 'native.url-search-params',
      providerKind: 'native',
      category: 'canonicalization',
      phase: 'output',
    });
    runtime.stop();
  });

  it('discovers Axios with bounded retry and exposes a transparent request-builder edge', () => {
    vi.useFakeTimers();
    const { events, window, host } = environment();
    const runtime = createRequestPreparationRuntime(window, host);
    runtime.start();

    class Axios {
      request(config: unknown) { return Promise.resolve(config); }
    }
    window.axios = { Axios };
    vi.advanceTimersByTime(50);
    const instance = new Axios();
    const result = instance.request({
      data: { account: 'admin' },
      headers: { 'X-Signature': 'signed-value' },
      params: { nonce: 'nonce-value' },
    });

    expect(result).toBeInstanceOf(Promise);
    const axios = events.find((event) => event.operation === 'axios.request');
    expect(axios?.transform).toEqual({
      adapterId: 'axios',
      providerKind: 'library',
      category: 'request-builder',
      phase: 'boundary',
    });
    expect(axios?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$headers.X-Signature', fingerprint: 'fp:signed-value' }),
      expect.objectContaining({ path: '$query.nonce', fingerprint: 'fp:nonce-value' }),
    ]));
    expect(axios?.outputs).toEqual(axios?.inputs);
    runtime.stop();
  });

  it('caps noisy serializer evidence per trace', () => {
    vi.useFakeTimers();
    const { events, window, host } = environment();
    const runtime = createRequestPreparationRuntime(window, host);
    runtime.start();
    for (let index = 0; index < 50; index += 1) window.JSON.stringify({ index });
    expect(events.filter((event) => event.operation === 'JSON.stringify')).toHaveLength(32);
    runtime.stop();
  });
});
