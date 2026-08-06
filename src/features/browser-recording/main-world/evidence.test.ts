import { describe, expect, it } from 'vitest';
import { createRecordingEvidenceRuntime } from './evidence';

function scopeWithDeterministicSeed(): Window {
  let seed = 10;
  return {
    JSON,
    btoa: globalThis.btoa.bind(globalThis),
    URLSearchParams,
    FormData,
    Blob,
    crypto: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint32Array) {
          array[0] = seed++;
          array[1] = seed++;
        }
        return array;
      },
    },
  } as unknown as Window;
}

describe('recording evidence runtime', () => {
  it('extracts bounded JSON, form and byte evidence without exposing values by default', () => {
    const options = { captureValues: false, maxValueBytes: 16 };
    const runtime = createRecordingEvidenceRuntime(scopeWithDeterministicSeed(), () => options);
    runtime.reseed();
    const evidence = runtime.collect({
      json: '{"account":"admin","password":"secret"}',
      form: 'encryptedData=cipher%2Bvalue&nonce=one',
      bytes: new Uint8Array([0, 1, 2, 255]),
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.length).toBeLessThanOrEqual(48);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.json:json.account', preview: undefined }),
      expect.objectContaining({ path: '$.form:form.encryptedData', preview: undefined }),
      expect.objectContaining({ path: '$.bytes', encoding: 'hex', byteLength: 4 }),
      expect.objectContaining({ path: '$.bytes', encoding: 'base64', byteLength: 4 }),
    ]));
    expect(runtime.collect('YWJjZGVmZw==', '$.base64').map((item) => item.path)).toEqual(['$.base64']);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('cipher+value');
  });

  it('reads current capture options and reseeds fingerprints per recording', () => {
    const options = { captureValues: false, maxValueBytes: 5 };
    const runtime = createRecordingEvidenceRuntime(scopeWithDeterministicSeed(), () => options);
    runtime.reseed();
    const first = runtime.collect('plaintext')[0];
    options.captureValues = true;
    const visible = runtime.collect('plaintext')[0];
    runtime.reseed();
    const reseeded = runtime.collect('plaintext')[0];

    expect(first.preview).toBeUndefined();
    expect(visible.preview).toBe('plain');
    expect(visible.fingerprint).toBe(first.fingerprint);
    expect(reseeded.fingerprint).not.toBe(first.fingerprint);
  });

  it('reports native and library byte lengths without serializing unbounded values', () => {
    const runtime = createRecordingEvidenceRuntime(
      scopeWithDeterministicSeed(),
      () => ({ captureValues: false, maxValueBytes: 2_048 }),
    );
    expect(runtime.byteLength(new Uint8Array(12))).toBe(12);
    expect(runtime.byteLength({ sigBytes: 16, toString: () => 'ignored' })).toBe(16);
    expect(runtime.dataType(new Uint8Array())).toBe('Uint8Array');
    expect(runtime.preview('secret')).toBeUndefined();
  });
});
