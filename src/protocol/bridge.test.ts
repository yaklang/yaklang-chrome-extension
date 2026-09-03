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
    expect(() => parseBridgePairingEnvelope({
      type: 'pair_pending', protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: 'request-1', serverNonce: 'server-nonce',
      engineIdentityId: 'identity-1', code: '123456', expiresAt: Date.now() + 6 * 60_000, publicKey,
    })).toThrow('有效期异常');
  });

  it('rejects undeclared bridge and pairing fields', () => {
    expect(() => parseBridgeEnvelope({ type: 'response', id: 'r1', result: {}, legacy: true })).toThrow('$.legacy');
    expect(() => parseBridgeEnvelope({
      type: 'response', id: 'r1', error: { code: 'failed', message: 'failed', legacy: true },
    })).toThrow('$.error.legacy');
    expect(() => parseBridgePairingEnvelope({ type: 'pair_error', message: 'failed', legacy: true })).toThrow('$.legacy');
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

  it('opens only HTTP(S) pages in the attached browser instance', () => {
    expect(parseCapabilityParams('browser.tab.open', { url: 'https://www.baidu.com/' }))
      .toEqual({ url: 'https://www.baidu.com/' });
    expect(() => parseCapabilityParams('browser.tab.open', { url: 'chrome://settings' })).toThrow('HTTP(S)');
  });

  it('accepts exact Worker boundary handles for remote deep capture', () => {
    expect(parseCapabilityParams('browser.deep_capture.start', {
      matcher: {
        kind: 'boundary', eventKind: 'worker', operation: 'worker.postMessage', wrapperHandleId: 'boundary-wrapper-1',
      },
    })).toMatchObject({ matcher: { kind: 'boundary', eventKind: 'worker' } });
  });

  it('validates browser identity isolation capabilities without accepting an unbounded tab query', () => {
    expect(parseCapabilityParams('browser.isolation.inspect', {
      tabIds: [12, 13],
    })).toEqual({ tabIds: [12, 13] });
    expect(parseCapabilityParams('browser.isolation.proof', {
      leftTabId: 12,
      rightTabId: 13,
    })).toEqual({ leftTabId: 12, rightTabId: 13 });
    expect(parseCapabilityParams('browser.isolation.incognito.open', {
      url: 'https://example.test/login',
    })).toEqual({ url: 'https://example.test/login' });
    expect(() => parseCapabilityParams('browser.isolation.inspect', { tabIds: [] })).toThrow();
    expect(() => parseCapabilityParams('browser.isolation.proof', {
      leftTabId: 12,
      rightTabId: 12,
    })).toThrow();
    expect(() => parseCapabilityParams('browser.isolation.incognito.open', {
      url: 'chrome://extensions',
    })).toThrow();
  });

  it('binds authorization context capture to a proof, slot and exact document target', () => {
    expect(parseCapabilityParams('browser.authorization.context.capture', {
      tabId: 12,
      frameId: 0,
      documentId: 'document-1',
      isolationProofId: 'proof-1',
      slotId: 'left',
      accountLabel: '低权限账号',
    })).toEqual({
      tabId: 12,
      frameId: 0,
      documentId: 'document-1',
      isolationProofId: 'proof-1',
      slotId: 'left',
      accountLabel: '低权限账号',
    });
    expect(parseCapabilityParams('browser.authorization.context.get', {
      id: 'auth-context-1',
    })).toEqual({ id: 'auth-context-1' });
    expect(parseCapabilityParams('browser.authorization.context.attest', {
      tabId: 12,
      frameId: 0,
      documentId: 'document-1',
    })).toEqual({
      tabId: 12,
      frameId: 0,
      documentId: 'document-1',
    });
    expect(parseCapabilityParams('browser.authorization.context.attestation.get', {
      id: 'attestation-1',
    })).toEqual({ id: 'attestation-1' });
    expect(parseCapabilityParams('browser.isolation.container.open', {
      url: 'https://example.test/login',
      name: '身份 B',
    })).toEqual({
      url: 'https://example.test/login',
      name: '身份 B',
    });
    expect(parseCapabilityParams('browser.isolation.container.list', {})).toEqual({});
    expect(parseCapabilityParams('browser.isolation.container.remove', {
      cookieStoreId: 'firefox-container-7',
    })).toEqual({ cookieStoreId: 'firefox-container-7' });
    expect(parseCapabilityParams('browser.authorization.baseline.capture', {
      tabId: 12,
      frameId: 0,
      documentId: 'document-1',
      authContextKind: 'handle',
      authContextId: 'auth-context-1',
      networkRequestId: 'network-request-1',
      comparisonKey: 'A'.repeat(43),
    })).toMatchObject({
      authContextKind: 'handle',
      authContextId: 'auth-context-1',
      networkRequestId: 'network-request-1',
    });
    expect(parseCapabilityParams('browser.authorization.baseline.get', {
      id: 'baseline-1',
    })).toEqual({ id: 'baseline-1' });
    expect(parseCapabilityParams('browser.authorization.baseline.logical.bind', {
      id: 'baseline-1',
      profileId: 'profile-left',
      comparisonKey: 'A'.repeat(43),
    })).toEqual({
      id: 'baseline-1',
      profileId: 'profile-left',
      comparisonKey: 'A'.repeat(43),
    });
    expect(parseCapabilityParams('browser.authorization.baseline.candidates', {
      tabId: 12,
      frameId: 0,
      authContextKind: 'attestation',
      authContextId: 'attestation-1',
      limit: 50,
    })).toMatchObject({
      authContextKind: 'attestation',
      authContextId: 'attestation-1',
      limit: 50,
    });
    expect(parseCapabilityParams('browser.authorization.baseline.resource.get', {
      id: 'baseline-1',
      selector: { source: 'wire', location: 'query', path: 'query.orderId' },
    })).toEqual({
      id: 'baseline-1',
      selector: { source: 'wire', location: 'query', path: 'query.orderId' },
    });
    expect(parseCapabilityParams('browser.authorization.baseline.compile', {
      id: 'baseline-1',
      selector: { source: 'wire', location: 'query', path: 'query.orderId' },
      replacement: {
        version: 1,
        baselineId: 'baseline-2',
        source: 'wire',
        location: 'query',
        path: 'query.orderId',
        valueType: 'string',
        byteLength: 2,
        valueBase64: 'NDI=',
        valueFingerprint: `workspace-hmac-sha256:${'a'.repeat(64)}`,
      },
      comparisonKey: 'A'.repeat(43),
    })).toMatchObject({
      id: 'baseline-1',
      replacement: { baselineId: 'baseline-2', valueBase64: 'NDI=' },
    });
    expect(parseCapabilityParams('browser.authorization.baseline.compile', {
      id: 'baseline-1',
      selector: {
        source: 'wire',
        location: 'body',
        path: 'body.variables.orderId',
      },
      replacement: {
        version: 1,
        baselineId: 'baseline-2',
        source: 'wire',
        location: 'body',
        path: 'body.variables.orderId',
        valueType: 'number',
        byteLength: 2,
        valueBase64: 'ODQ=',
        valueFingerprint: `workspace-hmac-sha256:${'b'.repeat(64)}`,
      },
      comparisonKey: 'A'.repeat(43),
    })).toMatchObject({
      replacement: { valueType: 'number', valueBase64: 'ODQ=' },
    });
    expect(parseCapabilityParams('browser.authorization.baseline.transform.inspect', {
      id: 'baseline-1',
      profileId: 'profile-left',
    })).toEqual({
      id: 'baseline-1',
      profileId: 'profile-left',
    });
    expect(parseCapabilityParams('browser.authorization.baseline.packet.compile', {
      id: 'baseline-1',
    })).toEqual({ id: 'baseline-1' });
    expect(parseCapabilityParams('browser.authorization.baseline.transform.compile', {
      id: 'baseline-1',
      selector: { source: 'wire', location: 'query', path: 'query.orderId' },
      replacement: {
        version: 1,
        baselineId: 'baseline-2',
        source: 'wire',
        location: 'query',
        path: 'query.orderId',
        valueType: 'string',
        byteLength: 2,
        valueBase64: 'NDI=',
        valueFingerprint: `workspace-hmac-sha256:${'a'.repeat(64)}`,
      },
      comparisonKey: 'A'.repeat(43),
      profileId: 'profile-left',
      bindingFingerprint: `sha256:${'b'.repeat(64)}`,
    })).toMatchObject({
      id: 'baseline-1',
      profileId: 'profile-left',
      bindingFingerprint: `sha256:${'b'.repeat(64)}`,
    });
    expect(() => parseCapabilityParams('browser.authorization.context.capture', {
      tabId: 12,
      isolationProofId: 'proof-1',
      slotId: 'middle',
    })).toThrow();
    expect(() => parseCapabilityParams('browser.isolation.container.remove', {
      cookieStoreId: 'firefox-default',
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.context.get', {
      id: '',
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.context.attestation.get', {
      id: '',
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.baseline.capture', {
      tabId: 12,
      authContextKind: 'handle',
      authContextId: 'auth-context-1',
      networkRequestId: 'network-request-1',
      comparisonKey: 'short',
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.baseline.candidates', {
      tabId: 12,
      authContextKind: 'handle',
      authContextId: 'auth-context-1',
      limit: 201,
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.baseline.resource.get', {
      id: 'baseline-1',
      selector: { location: 'body', path: 'body.orderId' },
    })).toThrow();
    expect(() => parseCapabilityParams('browser.authorization.baseline.compile', {
      id: 'baseline-1',
      selector: { source: 'wire', location: 'query', path: 'query.orderId' },
      replacement: {
        version: 1,
        baselineId: 'baseline-2',
        source: 'wire',
        location: 'query',
        path: 'query.orderId',
        valueType: 'string',
        byteLength: 2,
        valueBase64: 'not base64',
        valueFingerprint: `workspace-hmac-sha256:${'a'.repeat(64)}`,
      },
      comparisonKey: 'A'.repeat(43),
    })).toThrow();
  });

  it('accepts automatic selected-frame capture and rejects the legacy expression contract', () => {
    expect(parseCapabilityParams('browser.callable.create', {
      source: 'deep-capture', strategy: 'selected-frame', callFrameId: 'frame-1', name: 'Envelope',
      candidateId: 'candidate-envelope',
    })).toMatchObject({ strategy: 'selected-frame', callFrameId: 'frame-1', candidateId: 'candidate-envelope' });
    expect(() => parseCapabilityParams('browser.callable.create', {
      source: 'deep-capture', callFrameId: 'frame-1', name: 'Envelope', functionExpression: 'buildEnvelope',
    })).toThrow();
  });

  it('accepts only an evidence candidate reference for request-transaction capture', () => {
    expect(parseCapabilityParams('browser.callable.create', {
      tabId: 12,
      frameId: 0,
      source: 'deep-capture',
      strategy: 'request-transaction',
      callFrameId: 'frame-1',
      name: 'Login envelope',
      candidateId: 'candidate-login',
    })).toMatchObject({
      strategy: 'request-transaction',
      candidateId: 'candidate-login',
    });
    expect(() => parseCapabilityParams('browser.callable.create', {
      source: 'deep-capture', strategy: 'request-transaction', callFrameId: 'frame-1',
      candidateId: 'candidate-login', transaction: {},
    })).toThrow();
  });

  it('validates the bounded browser crypto Agent tool contracts', () => {
    const packet = {
      method: 'POST',
      url: 'https://example.test/login',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: 'e30=',
    };
    expect(parseCapabilityParams('browser.recording.trace.list', {
      tabId: 12, frameId: 0, limit: 20,
    })).toMatchObject({ limit: 20 });
    expect(parseCapabilityParams('browser.recording.evidence.inspect', {
      tabId: 12, traceId: 'trace-1', includeValues: false,
    })).toMatchObject({ traceId: 'trace-1', includeValues: false });
    expect(parseCapabilityParams('browser.callable.inspect', {
      tabId: 12, callableId: 'callable-1',
    })).toMatchObject({ callableId: 'callable-1' });
    expect(parseCapabilityParams('browser.callable.replay', {
      tabId: 12, callableId: 'callable-1', args: [{ username: 'admin' }],
    })).toMatchObject({ callableId: 'callable-1' });
    expect(parseCapabilityParams('browser.packet.compare', {
      tabId: 12, actual: packet, expected: packet, mode: 'structure',
    })).toMatchObject({ mode: 'structure' });
    expect(parseCapabilityParams('browser.profile.propose', {
      tabId: 12,
      candidateId: 'candidate-1',
      callableId: 'callable-1',
      inputPaths: ['body'],
    })).toMatchObject({ candidateId: 'candidate-1', callableId: 'callable-1' });
    expect(parseCapabilityParams('browser.profile.validation.latest', {
      tabId: 12, frameId: 0, documentId: 'document-1',
    })).toMatchObject({ tabId: 12, documentId: 'document-1' });
    expect(parseCapabilityParams('browser.profile.validate', {
      tabId: 12,
      candidateId: 'candidate-1',
      callableId: 'callable-1',
      inputPaths: ['body'],
      packet,
    })).toMatchObject({
      tabId: 12,
      candidateId: 'candidate-1',
      callableId: 'callable-1',
    });
    expect(parseCapabilityParams('browser.transform.recovery.start', {
      id: 'profile-1',
    })).toMatchObject({ id: 'profile-1' });
    expect(parseCapabilityParams('browser.transform.recovery.capture', {
      id: 'profile-1',
      tabId: 12,
      frameId: 0,
      documentId: 'document-2',
      callFrameId: 'frame-1',
      strategy: 'request-transaction',
    })).toMatchObject({
      id: 'profile-1',
      documentId: 'document-2',
      strategy: 'request-transaction',
    });
    expect(parseCapabilityParams('browser.transform.recovery.validate', {
      id: 'profile-1',
      packet,
    })).toMatchObject({ id: 'profile-1' });
    expect(parseCapabilityParams('browser.transform.recovery.confirm', {
      id: 'profile-1',
      validationId: 'validation-1',
    })).toMatchObject({ validationId: 'validation-1' });
    expect(() => parseCapabilityParams('browser.profile.validate', {
      tabId: 12,
      profile: {},
      packet,
    })).toThrow();
  });
});
