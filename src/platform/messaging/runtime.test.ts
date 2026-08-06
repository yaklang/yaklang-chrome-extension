import { describe, expect, it } from 'vitest';
import { ExtensionError } from '@/shared/errors';
import { parseExtensionResponseEnvelope } from './runtime';

describe('runtime response envelope', () => {
  it('accepts declared success and structured error fields', () => {
    expect(parseExtensionResponseEnvelope({ ok: true, data: { value: 1 } }, 'test')).toEqual({
      ok: true,
      data: { value: 1 },
    });
    expect(parseExtensionResponseEnvelope({
      ok: false,
      error: 'failed',
      errorCode: 'test_failed',
      errorData: { reason: 'test' },
    }, 'test')).toMatchObject({ ok: false, errorCode: 'test_failed' });
  });

  it.each([
    [null, '不是对象'],
    [{ data: 1 }, '$.ok'],
    [{ ok: true, legacy: true }, '$.legacy'],
    [{ ok: false, error: 1 }, '$.error'],
  ])('rejects invalid cross-context envelope %#', (value, message) => {
    expect(() => parseExtensionResponseEnvelope(value, 'test')).toThrow(message);
  });

  it('returns a stable protocol error code', () => {
    try {
      parseExtensionResponseEnvelope(undefined, 'test');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionError);
      expect((error as ExtensionError).code).toBe('runtime_protocol_mismatch');
    }
  });
});
