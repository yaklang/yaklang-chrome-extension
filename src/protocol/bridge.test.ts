import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_PROTOCOL_VERSION, parseBridgeEnvelope, parseBridgePairingEnvelope, parseCapabilityParams,
} from './bridge';

describe('Bridge v3 protocol', () => {
  it('accepts an identified hello_ack', () => {
    expect(parseBridgeEnvelope({
      type: 'hello_ack', protocolVersion: BRIDGE_PROTOCOL_VERSION, version: 'test', capabilities: [],
      sessionId: 'session-1', engineIdentityId: 'engine-identity-1', engineInstanceId: 'engine-1', connectionId: 'connection-1', resumed: true,
    })).toMatchObject({ type: 'hello_ack', resumed: true });
  });

  it('rejects mismatched versions and missing identities', () => {
    expect(() => parseBridgeEnvelope({ type: 'hello_ack', protocolVersion: 1, capabilities: [] })).toThrow('不兼容');
    expect(() => parseBridgeEnvelope({ type: 'hello_ack', protocolVersion: BRIDGE_PROTOCOL_VERSION, capabilities: [] })).toThrow('engineIdentityId');
  });

  it('validates engine challenges and pairing responses', () => {
    const publicKey = { kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' } as const;
    expect(parseBridgeEnvelope({
      type: 'challenge', protocolVersion: BRIDGE_PROTOCOL_VERSION, engineIdentityId: 'identity-1', engineInstanceId: 'instance-1',
      challenge: 'challenge-1', signature: 'signature-1', timestamp: Date.now(), publicKey,
    })).toMatchObject({ type: 'challenge', engineIdentityId: 'identity-1' });
    expect(parseBridgePairingEnvelope({
      type: 'pair_pending', protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: 'request-1', serverNonce: 'server-nonce',
      engineIdentityId: 'identity-1', code: '123456', expiresAt: Date.now() + 60_000, publicKey,
    })).toMatchObject({ type: 'pair_pending', code: '123456' });
  });

  it('validates heartbeat and chunk boundaries', () => {
    expect(parseBridgeEnvelope({ type: 'pong', id: 'p1', sequence: 3, timestamp: 100 })).toMatchObject({ sequence: 3 });
    expect(() => parseBridgeEnvelope({ type: 'ping' })).toThrow('心跳');
    expect(parseBridgeEnvelope({
      type: 'chunk', transferId: 't1', index: 0, total: 2, data: 'eA==', originalBytes: 2,
    })).toMatchObject({ transferId: 't1' });
    expect(() => parseBridgeEnvelope({
      type: 'chunk', transferId: 't1', index: 2, total: 2, data: 'eA==', originalBytes: 2,
    })).toThrow('序号');
  });

  it('requires explicit Eval mode and caps raw payloads', () => {
    expect(parseCapabilityParams('browser.eval', { mode: 'expression', code: 'document.title' })).toMatchObject({ mode: 'expression' });
    expect(() => parseCapabilityParams('browser.eval', { code: 'document.title' })).toThrow('mode');
    expect(() => parseBridgeEnvelope('x'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1))).toThrow('16 MiB');
  });
});
