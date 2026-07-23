import { describe, expect, it } from 'vitest';
import type { BrowserRecordingEvent } from '@/types/models';
import {
  cryptoDeepCaptureMatcher,
  cryptoEventLabel,
  isForwardCryptoEvent,
  normalizeBrowserRecordingCrypto,
} from './model';

function cryptoEvent(operation: string): BrowserRecordingEvent {
  return {
    id: 'crypto-1', sequence: 1, timestamp: 1, recordingId: 'recording-1', traceId: 'trace-1',
    kind: 'crypto', operation, inputs: [], outputs: [], sensitiveCaptured: false,
    wrapperHandleId: 'wrapper-jsencrypt-encrypt',
    scriptUrl: 'https://example.test/app.js',
    crypto: {
      adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation,
      algorithm: 'RSA', padding: 'PKCS1-v1_5', outputEncoding: 'base64',
      state: { model: 'receiver', phase: 'one-shot' },
      key: { kind: 'public', bits: 1024, fingerprint: 'v2:key' },
    },
  };
}

describe('browser crypto model', () => {
  it('normalizes bounded JSEncrypt metadata without carrying key material', () => {
    expect(normalizeBrowserRecordingCrypto({
      adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation: 'encrypt', algorithm: 'RSA',
      padding: 'PKCS1-v1_5', inputEncoding: 'utf8', outputEncoding: 'base64',
      state: { model: 'receiver', phase: 'one-shot', internalState: 'must-not-survive' },
      key: { kind: 'public', bits: 1024, fingerprint: 'v2:key', pem: 'must-not-survive' },
      publicKey: 'must-not-survive',
    })).toEqual({
      adapterId: 'jsencrypt', providerKind: 'library', family: 'asymmetric', operation: 'encrypt', algorithm: 'RSA',
      padding: 'PKCS1-v1_5', inputEncoding: 'utf8', outputEncoding: 'base64',
      state: { model: 'receiver', phase: 'one-shot' },
      key: { kind: 'public', bits: 1024, fingerprint: 'v2:key' },
    });
  });

  it('accepts bounded adapter IDs while rejecting malformed adapter metadata', () => {
    expect(normalizeBrowserRecordingCrypto({
      adapterId: 'vendor-suite.v2', providerKind: 'library', family: 'asymmetric', operation: 'encrypt',
    })?.adapterId).toBe('vendor-suite.v2');
    expect(normalizeBrowserRecordingCrypto({
      adapterId: '<img onerror=1>', providerKind: 'library', family: 'asymmetric', operation: 'encrypt',
    })).toBeUndefined();
  });

  it('classifies forward and reverse RSA calls', () => {
    expect(isForwardCryptoEvent(cryptoEvent('encrypt'))).toBe(true);
    expect(isForwardCryptoEvent(cryptoEvent('decrypt'))).toBe(false);
  });

  it('uses adapter-aware labels and exact wrapper handles for deep capture', () => {
    const event = cryptoEvent('encrypt');
    expect(cryptoEventLabel(event)).toBe('JSEncrypt RSA');
    expect(cryptoDeepCaptureMatcher(event)).toEqual({
      kind: 'crypto',
      adapterId: 'jsencrypt',
      operation: 'encrypt',
      wrapperHandleId: 'wrapper-jsencrypt-encrypt',
      scriptUrl: 'https://example.test/app.js',
    });
  });
});
