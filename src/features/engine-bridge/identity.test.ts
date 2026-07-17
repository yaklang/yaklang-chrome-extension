import { describe, expect, it } from 'vitest';
import type { BridgeEnvelope } from '@/types/messages';
import {
  clientAuthPayload, engineChallengePayload, pairingVerificationCode, signBridgePayload, verifyBridgePayload,
} from './identity';

describe('Bridge v3 identity transcript', () => {
  it('keeps the Go-compatible canonical field order', () => {
    expect(engineChallengePayload({
      engineIdentityId: 'identity-1', engineInstanceId: 'instance-1', challenge: 'nonce-1', timestamp: 123,
    })).toBe('yak-browser-bridge-v3\nengine-challenge\nidentity-1\ninstance-1\nnonce-1\n123');
    const envelope: BridgeEnvelope = {
      type: 'auth', installationId: 'install-1', client: 'client-1', version: '1.0.0',
      capabilities: ['z.capability', 'a.capability'], taskId: 'task-1', grantId: 'grant-1', resumeSessionId: 'session-1',
    };
    expect(clientAuthPayload({
      origin: 'chrome-extension://abc', engineIdentityId: 'identity-1', engineInstanceId: 'instance-1',
      challenge: 'nonce-1', envelope,
    })).toBe('yak-browser-bridge-v3\nclient-auth\nchrome-extension://abc\nidentity-1\ninstance-1\nnonce-1\ninstall-1\nclient-1\n1.0.0\na.capability,z.capability\ntask-1\ngrant-1\nsession-1');
  });

  it('matches the shared pairing verification vector', async () => {
    await expect(pairingVerificationCode({
      engineIdentityId: 'engine-id', requestId: 'request-1', origin: 'chrome-extension://abc', installationId: 'install-1',
      clientNonce: 'client-nonce-value', serverNonce: 'server-nonce-value',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' },
    })).resolves.toBe('113961');
  });

  it('signs and verifies ECDSA P-256 payloads', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJWK = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const publicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: publicJWK.x!, y: publicJWK.y! };
    const signature = await signBridgePayload(pair.privateKey, 'payload');
    await expect(verifyBridgePayload(publicKey, 'payload', signature)).resolves.toBe(true);
    await expect(verifyBridgePayload(publicKey, 'tampered', signature)).resolves.toBe(false);
  });
});
