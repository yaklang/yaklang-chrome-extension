import { describe, expect, it } from 'vitest';
import type { BrowserRecordingValueEvidence } from '@/types/models';
import {
  createEncodingTransformRuntime,
  type EncodingTransformEvent,
} from './encoding';

function evidence(value: unknown, path: string): BrowserRecordingValueEvidence[] {
  const text = typeof value === 'string'
    ? value
    : value instanceof Uint8Array
      ? [...value].join(',')
      : String(value);
  return [{
    path,
    fingerprint: `fp:${text}`,
    encoding: value instanceof Uint8Array ? 'bytes' : 'text',
    byteLength: text.length,
  }];
}

describe('encoding transform runtime', () => {
  it('records Base64 input/output semantics without changing native behavior', () => {
    const originalBtoa = globalThis.btoa.bind(globalThis);
    const originalAtob = globalThis.atob.bind(globalThis);
    const scope = {
      btoa: originalBtoa,
      atob: originalAtob,
    } as unknown as Window;
    const events: EncodingTransformEvent[] = [];
    const runtime = createEncodingTransformRuntime(scope, {
      byteLength: (value) => String(value).length,
      preview: (value) => String(value),
      collectEvidence: evidence,
      stackInfo: () => ({ scriptUrl: 'https://example.test/app.js' }),
      emit: (event) => events.push(event),
    });

    runtime.start();
    const encoded = scope.btoa('plain');
    const decoded = scope.atob(encoded);

    expect(encoded).toBe(originalBtoa('plain'));
    expect(decoded).toBe('plain');
    expect(events).toEqual([
      expect.objectContaining({
        operation: 'base64.encode',
        transform: {
          adapterId: 'native.base64',
          providerKind: 'native',
          category: 'encoding',
          phase: 'output',
        },
      }),
      expect.objectContaining({
        operation: 'base64.decode',
        transform: {
          adapterId: 'native.base64',
          providerKind: 'native',
          category: 'encoding',
          phase: 'output',
        },
      }),
    ]);
    expect(events[0].inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$input' }),
      expect.objectContaining({ path: '$input:bytes' }),
    ]));

    runtime.stop();
    expect(scope.btoa).toBe(originalBtoa);
    expect(scope.atob).toBe(originalAtob);
  });

  it('preserves native exceptions and does not emit a partial event', () => {
    const scope = {
      btoa: globalThis.btoa.bind(globalThis),
      atob: globalThis.atob.bind(globalThis),
    } as unknown as Window;
    const events: EncodingTransformEvent[] = [];
    const runtime = createEncodingTransformRuntime(scope, {
      byteLength: () => 1,
      preview: () => undefined,
      collectEvidence: evidence,
      stackInfo: () => ({}),
      emit: (event) => events.push(event),
    });

    runtime.start();
    expect(() => scope.btoa('中文')).toThrow();
    expect(events).toHaveLength(0);
    runtime.stop();
  });
});
