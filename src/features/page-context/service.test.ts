import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_DIGEST_STORAGE_KEY } from '@/protocol/storage';

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  executeScript: vi.fn(),
  listCookies: vi.fn(),
  getFrameInventory: vi.fn(),
  getPageLifecycle: vi.fn(),
  resolveCookieStore: vi.fn(),
  removedListener: undefined as ((tabId: number) => void) | undefined,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        async get(key: string) {
          return key in fixture.session
            ? { [key]: structuredClone(fixture.session[key]) }
            : {};
        },
        async set(items: Record<string, unknown>) {
          Object.assign(fixture.session, structuredClone(items));
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener(listener: (tabId: number) => void) {
          fixture.removedListener = listener;
        },
      },
    },
    scripting: {
      executeScript: fixture.executeScript,
    },
  },
}));

vi.mock('@/features/cookies/service', () => ({
  listCookies: fixture.listCookies,
}));
vi.mock('@/features/page-context/frames', () => ({
  getFrameInventory: fixture.getFrameInventory,
}));
vi.mock('@/features/page-context/lifecycle', () => ({
  getPageLifecycle: fixture.getPageLifecycle,
}));
vi.mock('@/features/page-context/execution-adapter', () => ({
  executePageOperation: vi.fn(),
}));
vi.mock('@/platform/browser/isolation', () => ({
  resolveTabCookieStoreId: fixture.resolveCookieStore,
}));
vi.mock('@/platform/browser/targets', () => ({
  getTab: vi.fn(async () => ({
    id: 7,
    windowId: 1,
    title: 'Account',
    url: 'https://app.example.test/account',
    active: true,
    incognito: false,
    isolationContextId: 'browser-profile:store-1',
  })),
  resolveDocumentTarget: vi.fn(async () => ({
    tabId: 7,
    frameId: 0,
    documentId: 'document-1',
  })),
  scriptingTarget: vi.fn((target) => ({
    tabId: target.tabId,
    documentIds: [target.documentId],
  })),
}));

function collectedDocument() {
  return {
    document: {
      title: 'Account',
      url: 'https://app.example.test/account',
      referrer: '',
      language: 'zh-CN',
      charset: 'UTF-8',
      readyState: 'complete',
      bodyText: 'Account Logout',
      bodyTextTruncated: false,
      headings: [],
      forms: [],
      interactive: [],
      meta: {},
      localStorage: {
        supported: true,
        entries: [{
          key: 'auth_token',
          value: 'redacted-fixture',
          byteLength: 16,
          authRelated: true,
          truncated: false,
        }],
        totalEntries: 1,
        approximateBytes: 16,
        truncated: false,
      },
      sessionStorage: {
        supported: true,
        entries: [],
        totalEntries: 0,
        approximateBytes: 0,
        truncated: false,
      },
      storageInventory: {
        indexedDB: { supported: true, databases: [], truncated: false },
        cacheStorage: { supported: true, names: [], truncated: false },
      },
      cryptoCandidates: [],
      scannedElementCount: 3,
      limitsReached: [],
    },
    authenticationSeed: {
      passwordFieldCount: 0,
      hasLoginControl: false,
      hasLogoutControl: true,
      hasAccountControl: true,
    },
  };
}

describe('Page Context browser API lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(4_102_444_800_000);
    for (const key of Object.keys(fixture.session)) delete fixture.session[key];
    fixture.removedListener = undefined;
    vi.clearAllMocks();
    fixture.executeScript.mockResolvedValue([{ frameId: 0, documentId: 'document-1', result: collectedDocument() }]);
    fixture.listCookies.mockResolvedValue([{
      name: 'session_id',
      value: 'secret',
      domain: 'app.example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      hostOnly: true,
      storeId: 'store-1',
    }]);
    fixture.getFrameInventory.mockResolvedValue([]);
    fixture.getPageLifecycle.mockResolvedValue([]);
    fixture.resolveCookieStore.mockResolvedValue('store-1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('collects one exact document and joins Cookie, frame and lifecycle APIs', async () => {
    const { capturePageContext } = await import('./service');

    const context = await capturePageContext({
      includeDom: true,
      includeStorage: true,
      includeCookies: true,
    }, { tabId: 7, frameId: 0, documentId: 'document-1' });

    expect(fixture.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7, documentIds: ['document-1'] },
      world: 'MAIN',
    }));
    expect(fixture.listCookies).toHaveBeenCalledWith(
      'https://app.example.test/account',
      'store-1',
    );
    expect(context).toMatchObject({
      target: { tabId: 7, frameId: 0, documentId: 'document-1' },
      included: { dom: true, storage: true, cookies: true },
      authentication: { status: 'authenticated' },
      diff: { kind: 'initial' },
    });
    expect(context.document.storageInventory?.indexedDB.supported).toBe(true);
  });

  it('turns scripting permission denial into an actionable capture error', async () => {
    fixture.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    const { capturePageContext } = await import('./service');

    await expect(capturePageContext({}, 7)).rejects.toMatchObject({
      code: 'context_capture_failed',
      message: expect.stringContaining('Cannot access contents'),
    });
  });

  it('rejects a non-structured injection result before reading dependent APIs', async () => {
    fixture.executeScript.mockResolvedValueOnce([{ frameId: 0, result: null }]);
    const { capturePageContext } = await import('./service');

    await expect(capturePageContext({}, 7)).rejects.toMatchObject({
      code: 'context_capture_failed',
      message: expect.stringContaining('没有返回结构化上下文'),
    });
    expect(fixture.listCookies).not.toHaveBeenCalled();
  });

  it('reports Cookie permission failure as part of the context capture boundary', async () => {
    fixture.listCookies.mockRejectedValueOnce(new Error('cookies permission denied'));
    const { capturePageContext } = await import('./service');

    await expect(capturePageContext({ includeCookies: true }, 7)).rejects.toMatchObject({
      code: 'context_capture_failed',
      message: expect.stringContaining('cookies permission denied'),
    });
  });

  it('restores a valid digest after corrupted entries and computes a restart diff', async () => {
    fixture.session[CONTEXT_DIGEST_STORAGE_KEY] = [
      {
        key: 'bad-key',
        captureId: 'corrupt',
        title: 'Corrupt',
        url: 'https://app.example.test/account',
        authentication: 'authenticated',
        nodes: [null],
        storageKeys: {},
        cookieNames: [],
      },
      {
        key: '7:0',
        captureId: 'capture-before-restart',
        documentId: 'document-1',
        title: 'Account',
        url: 'https://app.example.test/account',
        authentication: 'authenticated',
        included: 'true:true:true',
        nodes: [['old-node', {
          semanticKey: 'button|logout|0',
          tag: 'button',
          text: 'Logout',
          nodeId: 'n1',
          signature: 'true|false|false||',
        }]],
        formSignature: '',
        storageKeys: ['local:old_token'],
        cookieNames: ['old_session'],
      },
    ];
    const { capturePageContext } = await import('./service');

    const context = await capturePageContext({
      includeDom: true,
      includeStorage: true,
      includeCookies: true,
    }, 7);

    expect(context.diff).toMatchObject({
      kind: 'changed',
      fromCaptureId: 'capture-before-restart',
      removedNodes: [expect.objectContaining({ semanticKey: 'button|logout|0' })],
      addedStorageKeys: ['local:auth_token'],
      removedStorageKeys: ['local:old_token'],
      addedCookieNames: ['session_id'],
      removedCookieNames: ['old_session'],
    });
  });
});
