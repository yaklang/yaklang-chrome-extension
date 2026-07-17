import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpaqueId } from './id';

describe('createOpaqueId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses getRandomValues without requiring randomUUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(value: T): T {
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0xab);
        return value;
      },
    });

    expect(createOpaqueId('request')).toBe(`request-${'ab'.repeat(16)}`);
  });

  it('remains unique when the crypto implementation is unavailable', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('unavailable'); } });

    const first = createOpaqueId('request');
    const second = createOpaqueId('request');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^request-[a-z0-9]+-[a-z0-9]+$/);
  });
});
