import { describe, expect, it } from 'vitest';
import { recordingExpiryDelay } from './expiry';

describe('recording expiry timer', () => {
  it('does not overflow a permanent paired-browser grant into an immediate timeout', () => {
    expect(recordingExpiryDelay(Number.MAX_SAFE_INTEGER, 1_000)).toBeUndefined();
    expect(recordingExpiryDelay(11_000, 1_000)).toBe(10_000);
    expect(recordingExpiryDelay(999, 1_000)).toBe(0);
  });
});
