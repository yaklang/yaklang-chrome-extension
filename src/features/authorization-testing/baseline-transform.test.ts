import { describe, expect, it } from 'vitest';
import type {
  BrowserAuthorizationBaseline,
  BrowserTransformPipelineNode,
  BrowserTransformProfile,
} from '@/types/models';
import { authorizationDynamicTransformDestinations } from './baseline-transform';

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
      method: 'GET',
      url: 'https://example.test/api/orders/:resource',
      path: '/api/orders/:resource',
      contentType: '',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      headerNames: ['Host', 'Cookie'],
      fields: [
        {
          location: 'path',
          path: 'path.segment[2]',
          valueType: 'string',
          byteLength: 2,
          valueFingerprint: `workspace-hmac-sha256:${'a'.repeat(64)}`,
          category: 'resource',
        },
        {
          location: 'query',
          path: 'query.nonce',
          valueType: 'string',
          byteLength: 8,
          valueFingerprint: `workspace-hmac-sha256:${'b'.repeat(64)}`,
          category: 'nonce',
        },
        {
          location: 'header',
          path: 'header.x-signature',
          valueType: 'string',
          byteLength: 64,
          valueFingerprint: `workspace-hmac-sha256:${'c'.repeat(64)}`,
          category: 'signature',
        },
      ],
    },
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function profile(outputs: string[]): BrowserTransformProfile {
  const nodes: BrowserTransformPipelineNode[] = [
    {
      id: 'literal',
      name: '动态值',
      kind: 'builtin',
      operation: 'value.literal',
      inputs: [],
      options: { value: 'fresh' },
    },
    ...outputs.map((destination, index): BrowserTransformPipelineNode => ({
      id: `output-${index}`,
      name: destination,
      kind: 'output.write',
      destination,
      source: { nodeId: 'literal' },
      encoding: 'text',
    })),
  ];
  return {
    id: 'profile-left',
    name: '身份 A 动态签名',
    enabled: true,
    target: { tabId: 11, frameId: 0, documentId: 'document-left' },
    isolationContextId: 'browser-profile:store-left',
    cookieStoreId: 'store-left',
    origin: 'https://example.test',
    match: { methods: ['GET'], urlPattern: '*/api/orders/*' },
    request: { enabled: true, nodes },
    response: { enabled: false, nodes: [] },
    failMode: 'closed',
    maxConcurrency: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('authorization identity-bound transform contracts', () => {
  it('requires the profile to cover every dynamic Header and Query field', () => {
    expect(authorizationDynamicTransformDestinations(
      baseline(),
      profile(['query.nonce', 'header.X-Signature']),
    )).toEqual(['header.x-signature', 'query.nonce']);

    expect(() => authorizationDynamicTransformDestinations(
      baseline(),
      profile(['query.nonce']),
    )).toThrow('尚未覆盖动态字段');
  });

  it('keeps encrypted Body envelopes fail-closed until a logical plaintext binding exists', () => {
    expect(() => authorizationDynamicTransformDestinations(
      baseline(),
      profile(['query.nonce', 'header.X-Signature', 'body.encryptedData']),
    )).toThrow('Body 加密 envelope');
  });
});
