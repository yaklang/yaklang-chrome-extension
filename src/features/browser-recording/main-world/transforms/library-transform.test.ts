import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRecordingValueEvidence } from '@/types/models';
import {
  createLibraryTransformRuntime,
  type LibraryTransformHost,
} from './library-transform';

function evidence(value: unknown, path: string): BrowserRecordingValueEvidence[] {
  if (value === undefined) return [];
  if (value instanceof Uint8Array) {
    return [{
      path,
      fingerprint: `bytes:${[...value].join(',')}`,
      encoding: 'bytes',
      byteLength: value.byteLength,
    }];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 8)
      .flatMap(([key, item]) => evidence(item, `${path}.${key}`));
  }
  const text = String(value);
  return [{ path, fingerprint: `text:${text}`, encoding: 'text', byteLength: text.length }];
}

function environment() {
  const events: Array<Record<string, unknown>> = [];
  const listeners = new Set<EventListener>();
  const document = {
    addEventListener(type: string, listener: EventListener) {
      if (type === 'load') listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type === 'load') listeners.delete(listener);
    },
  };
  const scope = {
    document,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window & Record<string, unknown>;
  const host: LibraryTransformHost = {
    currentTrace: () => ({ traceId: 'trace-1', interactionId: 'interaction-1' }),
    collectEvidence: evidence,
    byteLength: (value) => value instanceof Uint8Array
      ? value.byteLength
      : typeof value === 'string' ? value.length : undefined,
    dataType: (value) => value instanceof Uint8Array ? 'Uint8Array' : typeof value,
    preview: () => undefined,
    stackInfo: () => ({ scriptUrl: 'https://example.test/app.js' }),
    emit: (event, context) => events.push({ ...event, ...context }),
  };
  return { events, host, listeners, scope };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('library transform evidence', () => {
  it('records MessagePack and pako as transforms without changing their return values', () => {
    vi.useFakeTimers();
    const { events, host, scope } = environment();
    const encode = (input: { id: number }) => new Uint8Array([input.id, 2, 3]);
    const deflate = (input: Uint8Array) => new Uint8Array([...input].reverse());
    scope.msgpack = { encode };
    scope.pako = { deflate };
    const runtime = createLibraryTransformRuntime(scope, host);

    runtime.start();
    const packed = (scope.msgpack as { encode(value: { id: number }): Uint8Array })
      .encode({ id: 7 });
    const compressed = (scope.pako as { deflate(value: Uint8Array): Uint8Array })
      .deflate(packed);

    expect([...packed]).toEqual([7, 2, 3]);
    expect([...compressed]).toEqual([3, 2, 7]);
    expect(events.map((event) => event.operation)).toEqual([
      'messagepack.encode',
      'pako.deflate',
    ]);
    expect(events[0].transform).toEqual({
      adapterId: 'messagepack',
      providerKind: 'library',
      category: 'serializer',
      phase: 'output',
    });
    expect(events[1].transform).toEqual({
      adapterId: 'pako',
      providerKind: 'library',
      category: 'compression',
      phase: 'output',
    });

    runtime.stop();
    expect((scope.msgpack as { encode: Function }).encode).toBe(encode);
    expect((scope.pako as { deflate: Function }).deflate).toBe(deflate);
  });

  it('records CryptoJS codecs as value-preserving encoding transforms', () => {
    vi.useFakeTimers();
    const { events, host, scope } = environment();
    const parsed = new Uint8Array([1, 2, 3, 4]);
    const parse = (input: string) => input === 'AQIDBA==' ? parsed : new Uint8Array();
    const stringify = (input: Uint8Array) => [...input].join('-');
    scope.CryptoJS = { enc: { Base64: { parse, stringify } } };
    const runtime = createLibraryTransformRuntime(scope, host);

    runtime.start();
    const encoder = (scope.CryptoJS as {
      enc: { Base64: { parse(value: string): Uint8Array; stringify(value: Uint8Array): string } };
    }).enc.Base64;
    expect(encoder.parse('AQIDBA==')).toBe(parsed);
    expect(encoder.stringify(parsed)).toBe('1-2-3-4');
    expect(events.map((event) => event.operation)).toEqual(['CryptoJS.enc.Base64.parse']);
    expect(events[0].transform).toEqual({
      adapterId: 'cryptojs.enc.base64',
      providerKind: 'library',
      category: 'encoding',
      phase: 'output',
    });

    runtime.stop();
    expect(encoder.parse).toBe(parse);
    expect(encoder.stringify).toBe(stringify);
  });

  it('links protobuf encode/finish and wraps existing or future Axios request interceptors', () => {
    vi.useFakeTimers();
    const { events, host, scope } = environment();
    class Writer {
      constructor(private readonly id: number) {}

      finish() {
        return new Uint8Array([this.id, 9]);
      }
    }
    class Type {
      encode(input: { id: number }) {
        return new Writer(input.id);
      }
    }
    const handlers: Array<{ fulfilled(config: { value: number }): { value: number } }> = [{
      fulfilled: (config) => {
        config.value += 1;
        return config;
      },
    }];
    const requestManager = {
      handlers,
      use(fulfilled: (config: { value: number }) => { value: number }) {
        handlers.push({ fulfilled });
        return handlers.length - 1;
      },
    };
    scope.protobuf = { Type, Writer };
    scope.axios = { interceptors: { request: requestManager } };
    const runtime = createLibraryTransformRuntime(scope, host);

    runtime.start();
    const bytes = new Type().encode({ id: 5 }).finish();
    expect([...bytes]).toEqual([5, 9]);
    expect(handlers[0].fulfilled({ value: 2 })).toEqual({ value: 3 });
    requestManager.use((config) => ({ value: config.value * 2 }));
    expect(handlers[1].fulfilled({ value: 3 })).toEqual({ value: 6 });

    expect(events.map((event) => event.operation)).toEqual(expect.arrayContaining([
      'protobufjs.Type.encode',
      'protobufjs.Writer.finish',
      'axios.interceptor.request',
    ]));
    expect(events.filter((event) => event.operation === 'axios.interceptor.request')).toHaveLength(2);
    const interceptor = events.find((event) => event.operation === 'axios.interceptor.request');
    expect(interceptor?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$input.value', fingerprint: 'text:2' }),
    ]));
    expect(interceptor?.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$output.value', fingerprint: 'text:3' }),
    ]));
    runtime.stop();
  });

  it('preserves Promise identity and snapshots input evidence before asynchronous mutation', async () => {
    const { events, host, scope } = environment();
    let resolve!: (value: Uint8Array) => void;
    const resultPromise = new Promise<Uint8Array>((done) => { resolve = done; });
    const encode = () => resultPromise;
    scope.msgpack = { encode };
    const runtime = createLibraryTransformRuntime(scope, host);
    runtime.start();
    const input = { id: 4 };

    const result = (scope.msgpack as {
      encode(value: { id: number }): Promise<Uint8Array>;
    }).encode(input);
    input.id = 99;
    resolve(new Uint8Array([4]));
    await result;
    await Promise.resolve();

    expect(result).toBe(resultPromise);
    expect(events[0].inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$input.id', fingerprint: 'text:4' }),
    ]));
    runtime.stop();
  });
});
