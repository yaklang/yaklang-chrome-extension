import { describe, expect, it } from 'vitest';
import { estimateRetainedCallBytes } from './retained-value-size';

describe('estimateRetainedCallBytes', () => {
  it('keeps a CryptoJS-style AES options object with shared cyclic mode references replayable', () => {
    const cipherBase: Record<string, unknown> = {};
    const encryptor = { $super: cipherBase };
    cipherBase.Encryptor = encryptor;
    const options = {
      iv: { words: [1, 2, 3, 4], sigBytes: 16 },
      mode: cipherBase,
      padding: { pad() {}, unpad() {} },
    };

    expect(() => JSON.stringify(options)).toThrow('circular');
    expect(estimateRetainedCallBytes([
      '{"username":"admin","password":"123456"}',
      { words: [1, 2, 3, 4], sigBytes: 16 },
      options,
    ])).toBeLessThan(2 * 1024 * 1024);
  });

  it('still rejects actual oversized retained data', () => {
    expect(estimateRetainedCallBytes(['x'.repeat(2 * 1024 * 1024)])).toBeGreaterThan(2 * 1024 * 1024);
    expect(estimateRetainedCallBytes([new Uint8Array(2 * 1024 * 1024)])).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('bounds hostile or accidentally enormous object graphs', () => {
    const value: Record<string, number> = {};
    for (let index = 0; index < 300; index += 1) value[`field-${index}`] = index;
    expect(estimateRetainedCallBytes([value])).toBeGreaterThan(2 * 1024 * 1024);
  });
});
