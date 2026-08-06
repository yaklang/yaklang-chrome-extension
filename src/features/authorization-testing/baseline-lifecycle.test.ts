import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  getContext: vi.fn(),
  loadLogicalBinding: vi.fn(),
  listNetworkRequests: vi.fn(),
  exportNetworkRequest: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        async get(key: string) {
          return key in mocks.session
            ? { [key]: structuredClone(mocks.session[key]) }
            : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(mocks.session, structuredClone(values));
        },
      },
    },
  },
}));

vi.mock('./auth-context', () => ({
  getAuthContextHandle: (...args: unknown[]) => mocks.getContext(...args),
}));

vi.mock('./auth-attestation', () => ({
  getAuthContextAttestation: (...args: unknown[]) => mocks.getContext(...args),
}));

vi.mock('@/features/network-capture/service', () => ({
  exportNetworkRequest: (...args: unknown[]) => mocks.exportNetworkRequest(...args),
  listNetworkRequests: (...args: unknown[]) => mocks.listNetworkRequests(...args),
}));

vi.mock('@/features/browser-transform/service', () => ({
  executeBrowserTransform: vi.fn(),
  getBrowserTransformProfile: vi.fn(),
}));

vi.mock('@/features/browser-transform/replay-draft', () => ({
  browserTransformReplayDraftToPacket: vi.fn(),
  getBrowserTransformReplayDraft: vi.fn(),
}));

vi.mock('./logical-binding', () => ({
  assertAuthorizationLogicalPacketStructure: vi.fn(),
  authorizationPacketFingerprint: vi.fn(),
  buildAuthorizationLogicalRequestBinding: vi.fn(),
  decodeAndVerifyLogicalReplacement: vi.fn(),
  loadAuthorizationLogicalRequestBinding: (...args: unknown[]) => (
    mocks.loadLogicalBinding(...args)
  ),
  readAuthorizationLogicalResource: vi.fn(),
  replaceAuthorizationLogicalResource: vi.fn(),
}));

const storageKey = 'browser.authorization.baselines.v1';
const expiresAt = 4_102_444_800_000;
const fingerprint = `sha256:${'a'.repeat(64)}`;

function target(documentId = 'document-a') {
  return { tabId: 7, frameId: 0, documentId };
}

function context(documentId = 'document-a') {
  return {
    version: 1,
    id: 'context-a',
    slotId: 'left',
    deviceId: 'device-a',
    installationId: 'installation-a',
    isolationContextId: 'isolation-a',
    isolationProofId: 'proof-a',
    cookieStoreId: 'store-a',
    origin: 'https://example.test',
    grantId: 'grant-a',
    target: target(documentId),
    fingerprint,
    authentication: {
      status: 'authenticated',
      cookieCount: 1,
      storageEntryCount: 0,
      authCookieNames: ['session'],
      authStorageKeys: [],
    },
    createdAt: 1,
    expiresAt,
  };
}

function storedBaseline(withLogicalBinding = false) {
  const request = {
    method: 'GET',
    url: 'https://example.test/account',
    path: '/account',
    contentType: '',
    actionFingerprint: fingerprint,
    headerNames: ['cookie'],
    fields: [],
  };
  const snapshot = {
    version: 1,
    id: 'baseline-a',
    deviceId: 'device-a',
    installationId: 'installation-a',
    isolationContextId: 'isolation-a',
    cookieStoreId: 'store-a',
    origin: 'https://example.test',
    grantId: 'grant-a',
    target: target(),
    authContextReference: { kind: 'handle', id: 'context-a' },
    networkRequestId: 'request-a',
    request,
    createdAt: 1,
    expiresAt,
    ...(withLogicalBinding ? {
      logicalRequest: {
        version: 1,
        source: 'local-replay-draft',
        baselineId: 'baseline-a',
        profileId: 'profile-a',
        profileName: 'account gateway',
        isolationContextId: 'isolation-a',
        cookieStoreId: 'store-a',
        target: target(),
        origin: 'https://example.test',
        request,
        outputDestinations: ['body.encryptedData'],
        validation: {
          proofLevel: 'structure',
          summary: 'validated',
          warnings: [],
        },
        bindingFingerprint: fingerprint,
        profileUpdatedAt: 2,
        replayUpdatedAt: 2,
        createdAt: 2,
        expiresAt,
      },
    } : {}),
  };
  return {
    snapshot,
    rawRequestBase64: btoa('GET /account HTTP/1.1\r\nHost: example.test\r\n\r\n'),
    requestUrl: 'https://example.test/account',
    isHttps: true,
  };
}

async function loadService() {
  return import('./baseline');
}

describe('authorization baseline lifecycle recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(mocks.session)) delete mocks.session[key];
    mocks.getContext.mockReset().mockResolvedValue(context());
    mocks.loadLogicalBinding.mockReset().mockResolvedValue({});
    mocks.listNetworkRequests.mockReset().mockResolvedValue([]);
    mocks.exportNetworkRequest.mockReset();
  });

  it('invalidates and removes a baseline after its page document changes', async () => {
    mocks.session[storageKey] = [storedBaseline()];
    mocks.getContext.mockResolvedValue(context('document-b'));
    const { getAuthorizationBaseline } = await loadService();

    await expect(
      getAuthorizationBaseline('baseline-a', 'grant-a'),
    ).rejects.toMatchObject({ code: 'authorization_baseline_stale' });
    expect(mocks.session[storageKey]).toEqual([]);
  });

  it('invalidates and removes a baseline after its isolation context disappears', async () => {
    mocks.session[storageKey] = [storedBaseline()];
    mocks.getContext.mockRejectedValue(new Error('context unavailable'));
    const { getAuthorizationBaseline } = await loadService();

    await expect(
      getAuthorizationBaseline('baseline-a', 'grant-a'),
    ).rejects.toMatchObject({ code: 'authorization_baseline_stale' });
    expect(mocks.session[storageKey]).toEqual([]);
  });

  it('drops only the logical binding when its callable or Profile proof changes', async () => {
    mocks.session[storageKey] = [storedBaseline(true)];
    mocks.loadLogicalBinding.mockRejectedValue(new Error('binding changed'));
    const { getAuthorizationBaseline } = await loadService();

    const baseline = await getAuthorizationBaseline('baseline-a', 'grant-a');

    expect(baseline.logicalRequest).toBeUndefined();
    const retained = mocks.session[storageKey] as Array<{
      snapshot: { logicalRequest?: unknown };
    }>;
    expect(retained).toHaveLength(1);
    expect(retained[0].snapshot.logicalRequest).toBeUndefined();
  });

  it('shows same-site WebSocket handshakes as an explicit fail-closed boundary', async () => {
    mocks.listNetworkRequests.mockResolvedValue([{
      id: 'socket-a',
      requestId: 'request-socket-a',
      tabId: 7,
      frameId: 0,
      documentId: 'document-a',
      url: 'wss://example.test/events?tenant=alpha',
      method: 'GET',
      resourceType: 'websocket',
      startedAt: 100,
      completedAt: 101,
      statusCode: 101,
      requestHeadersCaptured: true,
      requestBodyCaptured: true,
      redirects: [],
    }]);
    const { listAuthorizationBaselineCandidates } = await loadService();

    const candidates = await listAuthorizationBaselineCandidates({
      target: target(),
      grantId: 'grant-a',
      authContextKind: 'handle',
      authContextId: 'context-a',
      limit: 20,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'socket-a',
      resourceType: 'websocket',
      eligible: false,
    });
    expect(candidates[0].reasons[0]).toContain('不会进入 HTTP 授权矩阵');
  });

  it('rejects a WebSocket handshake even when called outside candidate selection', async () => {
    mocks.exportNetworkRequest.mockResolvedValue({
      id: 'socket-a',
      url: 'wss://example.test/events',
      isHttps: true,
      rawRequestBase64: btoa('GET /events HTTP/1.1\r\nHost: example.test\r\n\r\n'),
      limitations: [],
    });
    const { captureAuthorizationBaseline } = await loadService();

    await expect(captureAuthorizationBaseline({
      target: target(),
      grantId: 'grant-a',
      authContextKind: 'handle',
      authContextId: 'context-a',
      networkRequestId: 'socket-a',
      comparisonKey: 'A'.repeat(43),
    })).rejects.toMatchObject({ code: 'authorization_protocol_unsupported' });
  });
});
