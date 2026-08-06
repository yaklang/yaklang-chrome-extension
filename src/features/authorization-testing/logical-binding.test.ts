import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserAuthorizationBaseline,
  BrowserTransformExecution,
  BrowserTransformProfile,
} from '@/types/models';
import type { BrowserTransformReplayDraft } from '@/features/browser-transform/replay-draft';
import {
  assertAuthorizationLogicalProtocol,
  assertAuthorizationLogicalPacketStructure,
  authorizationTransformOutputDestinations,
  buildAuthorizationLogicalRequestBinding,
  replaceAuthorizationLogicalResource,
} from './logical-binding';

const executeBrowserTransform = vi.fn();

vi.mock('wxt/browser', () => {
  const event = { addListener: vi.fn() };
  return {
    browser: {
      tabs: { onRemoved: event, onCreated: event },
      webNavigation: {
        onBeforeNavigate: event,
        onCommitted: event,
        onDOMContentLoaded: event,
        onCompleted: event,
        onHistoryStateUpdated: event,
        onReferenceFragmentUpdated: event,
        onErrorOccurred: event,
      },
    },
  };
});

vi.mock('@/features/browser-transform/service', () => ({
  executeBrowserTransform: (...args: unknown[]) => executeBrowserTransform(...args),
  getBrowserTransformProfile: vi.fn(),
}));

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes));
}

function comparisonKey(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(23)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function profile(outputs = ['body.encryptedData', 'header.Content-Type']): BrowserTransformProfile {
  return {
    id: 'profile-left',
    name: '登录请求加密',
    enabled: true,
    target: { tabId: 11, frameId: 0, documentId: 'document-left' },
    isolationContextId: 'browser-profile:store-left',
    cookieStoreId: 'store-left',
    origin: 'https://example.test',
    match: { methods: ['POST'], urlPattern: '*/api/login' },
    request: {
      enabled: true,
      nodes: outputs.map((destination, index) => ({
        id: `output-${index}`,
        name: destination,
        kind: 'output.write' as const,
        destination,
        source: { nodeId: 'callable' },
        encoding: 'text' as const,
      })),
    },
    response: { enabled: false, nodes: [] },
    failMode: 'closed',
    maxConcurrency: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function baseline(): BrowserAuthorizationBaseline {
  return {
    version: 1,
    id: 'baseline-left',
    deviceId: 'device-left',
    installationId: 'installation-left',
    isolationContextId: 'browser-profile:store-left',
    cookieStoreId: 'store-left',
    origin: 'https://example.test',
    grantId: 'grant-left',
    target: { tabId: 11, frameId: 0, documentId: 'document-left' },
    authContextReference: { kind: 'handle', id: 'auth-left' },
    networkRequestId: 'request-left',
    request: {
      method: 'POST',
      url: 'https://example.test/api/login',
      path: '/api/login',
      contentType: 'application/x-www-form-urlencoded',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      headerNames: ['Host', 'Content-Type', 'Cookie'],
      fields: [{
        location: 'body',
        path: 'body.encryptedData',
        valueType: 'string',
        byteLength: 32,
        valueFingerprint: `workspace-hmac-sha256:${'b'.repeat(64)}`,
        category: 'unknown',
      }],
    },
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function draft(): BrowserTransformReplayDraft {
  return {
    version: 1,
    profileId: 'profile-left',
    direction: 'request',
    origin: 'https://example.test',
    method: 'POST',
    url: 'https://example.test/api/login',
    headers: '{"Content-Type":"application/json"}',
    body: '{"username":"alice","orderId":"order-a"}',
    updatedAt: 3,
  };
}

describe('authorization logical plaintext binding', () => {
  beforeEach(() => {
    executeBrowserTransform.mockReset();
  });

  it('rejects a logical replay that changes the observed GraphQL operation', () => {
    const observed = baseline().request;
    observed.protocol = 'graphql';
    observed.operationFingerprint = `sha256:${'1'.repeat(64)}`;
    observed.operationNames = ['Order'];
    const logical = {
      ...observed,
      operationFingerprint: `sha256:${'2'.repeat(64)}`,
      operationNames: ['CancelOrder'],
    };

    expect(() => assertAuthorizationLogicalProtocol(observed, logical)).toThrow(
      'GraphQL operation 与线上基线不一致',
    );
  });

  it('allows a logical GraphQL envelope when the encrypted wire baseline has no protocol metadata', () => {
    const observed = baseline().request;
    const logical = {
      ...observed,
      protocol: 'graphql' as const,
      operationFingerprint: `sha256:${'1'.repeat(64)}`,
      operationNames: ['Order'],
    };

    expect(() => assertAuthorizationLogicalProtocol(observed, logical)).not.toThrow();
  });

  it('binds private plaintext field metadata only after the generated wire shape matches', async () => {
    executeBrowserTransform.mockResolvedValue({
      profileId: 'profile-left',
      direction: 'request',
      url: 'https://example.test/api/login',
      bodyBase64: base64('encryptedData=ciphertext'),
      setHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      removeHeaders: [],
      logicalInput: {},
      logicalOutput: {},
      nodeDurations: [],
      nodeTrace: [],
      fieldChanges: [],
      durationMs: 1,
    } satisfies BrowserTransformExecution);
    const raw = base64([
      'POST /api/login HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/x-www-form-urlencoded',
      'Cookie: session=identity-a',
      '',
      'encryptedData=observed-ciphertext',
    ].join('\r\n'));

    const binding = await buildAuthorizationLogicalRequestBinding({
      baseline: baseline(),
      rawRequestBase64: raw,
      profile: profile(),
      draft: draft(),
      comparisonKey: comparisonKey(),
    });

    expect(binding.request.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: 'body',
        path: 'body.orderId',
        valueType: 'string',
        category: 'resource',
      }),
    ]));
    expect(binding.outputDestinations).toEqual(['body.encryptedData', 'header.content-type']);
    expect(binding.bindingFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(binding)).not.toContain('order-a');
    expect(JSON.stringify(binding)).not.toContain('alice');
  });

  it('keeps a multi-output AES plus RSA envelope tied to one logical business object', async () => {
    executeBrowserTransform.mockResolvedValue({
      profileId: 'profile-left',
      direction: 'request',
      url: 'https://example.test/api/login',
      bodyBase64: base64([
        'encryptedData=aes-ciphertext',
        'encryptedKey=rsa-wrapped-key',
        'encryptedIv=rsa-wrapped-iv',
      ].join('&')),
      setHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      removeHeaders: [],
      logicalInput: {},
      logicalOutput: {},
      nodeDurations: [],
      nodeTrace: [],
      fieldChanges: [],
      durationMs: 1,
    } satisfies BrowserTransformExecution);
    const raw = base64([
      'POST /api/login HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/x-www-form-urlencoded',
      'Cookie: session=identity-a',
      '',
      [
        'encryptedData=observed-aes-ciphertext',
        'encryptedKey=observed-rsa-key',
        'encryptedIv=observed-rsa-iv',
      ].join('&'),
    ].join('\r\n'));

    const binding = await buildAuthorizationLogicalRequestBinding({
      baseline: baseline(),
      rawRequestBase64: raw,
      profile: profile([
        'body.encryptedData',
        'body.encryptedKey',
        'body.encryptedIv',
        'header.Content-Type',
      ]),
      draft: draft(),
      comparisonKey: comparisonKey(),
    });

    expect(binding.outputDestinations).toEqual([
      'body.encryptedData',
      'body.encryptedIv',
      'body.encryptedKey',
      'header.content-type',
    ]);
    expect(binding.request.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'body.orderId', category: 'resource' }),
      expect.objectContaining({ path: 'body.username' }),
    ]));
    expect(binding.validation.proofLevel).toBe('structure');
  });

  it('rejects a gateway whose generated serialization does not match the captured request', async () => {
    executeBrowserTransform.mockResolvedValue({
      profileId: 'profile-left',
      direction: 'request',
      url: 'https://example.test/api/login',
      bodyBase64: base64('{"encryptedData":"ciphertext"}'),
      setHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      removeHeaders: [],
      logicalInput: {},
      logicalOutput: {},
      nodeDurations: [],
      nodeTrace: [],
      fieldChanges: [],
      durationMs: 1,
    } satisfies BrowserTransformExecution);
    const raw = base64([
      'POST /api/login HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/x-www-form-urlencoded',
      '',
      'encryptedData=observed-ciphertext',
    ].join('\r\n'));

    await expect(buildAuthorizationLogicalRequestBinding({
      baseline: baseline(),
      rawRequestBase64: raw,
      profile: profile(),
      draft: draft(),
      comparisonKey: comparisonKey(),
    })).rejects.toThrow('结构不一致');
  });

  it('rejects compressed request bodies because their logical structure cannot be proven', async () => {
    executeBrowserTransform.mockResolvedValue({
      profileId: 'profile-left',
      direction: 'request',
      url: 'https://example.test/api/login',
      bodyBase64: base64('encryptedData=ciphertext'),
      setHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      removeHeaders: [],
      logicalInput: {},
      logicalOutput: {},
      nodeDurations: [],
      nodeTrace: [],
      fieldChanges: [],
      durationMs: 1,
    } satisfies BrowserTransformExecution);
    const raw = base64([
      'POST /api/login HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/x-www-form-urlencoded',
      'Content-Encoding: gzip',
      '',
      'encryptedData=observed-ciphertext',
    ].join('\r\n'));

    await expect(buildAuthorizationLogicalRequestBinding({
      baseline: baseline(),
      rawRequestBase64: raw,
      profile: profile(),
      draft: draft(),
      comparisonKey: comparisonKey(),
    })).rejects.toThrow('压缩或编码后的请求 Body');
  });

  it('rejects a conditionally changed output envelope during later matrix compilation', () => {
    const observed = {
      method: 'POST',
      url: 'https://example.test/api/login',
      headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      bodyBase64: base64('encryptedData=observed-ciphertext'),
    };
    const generated = {
      ...observed,
      bodyBase64: base64('encryptedData=generated-ciphertext&unexpected=side-channel'),
    };

    expect(() => assertAuthorizationLogicalPacketStructure(
      generated,
      observed,
    )).toThrow('Body 字段与类型结构');
  });

  it('replaces one explicit JSON plaintext field without touching its siblings', () => {
    const packet = {
      method: 'POST',
      url: 'https://example.test/api/orders',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: base64('{"orderId":"order-a","note":"keep"}'),
    };
    const replaced = replaceAuthorizationLogicalResource({
      packet,
      selector: { source: 'logical', location: 'body', path: 'body.orderId' },
      replacement: 'order-b',
    });

    expect(JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(replaced.bodyBase64), (character) => character.charCodeAt(0)),
    ))).toEqual({ orderId: 'order-b', note: 'keep' });
  });

  it('preserves the primitive type of a numeric logical resource', () => {
    const packet = {
      method: 'POST',
      url: 'https://example.test/graphql',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: base64('{"variables":{"orderId":42},"query":"query Order { order { id } }"}'),
    };
    const replaced = replaceAuthorizationLogicalResource({
      packet,
      selector: {
        source: 'logical',
        location: 'body',
        path: 'body.variables.orderId',
      },
      replacement: 84,
    });

    expect(JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(replaced.bodyBase64), (character) => character.charCodeAt(0)),
    )).variables.orderId).toBe(84);
    expect(() => replaceAuthorizationLogicalResource({
      packet,
      selector: {
        source: 'logical',
        location: 'body',
        path: 'body.variables.orderId',
      },
      replacement: '84',
    })).toThrow('不能改变字段类型');
  });

  it('refuses profiles that attempt to synthesize authentication headers', () => {
    expect(() => authorizationTransformOutputDestinations(
      profile(['header.Authorization']),
    )).toThrow('认证 Header');
  });
});
