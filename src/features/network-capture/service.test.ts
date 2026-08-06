import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (details: Record<string, any>) => unknown;

const fixture = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  storageFailure: undefined as Error | undefined,
  storageGetGate: undefined as Promise<void> | undefined,
  frames: new Map<string, { url: string; documentId?: string }>(),
  tabs: new Map<number, { id: number; incognito: boolean; cookieStoreId?: string }>(),
  listeners: {} as Record<string, Listener>,
  storageSet: vi.fn(),
  sendMessage: vi.fn(async () => undefined),
}));

vi.mock('wxt/browser', () => {
  const event = (name: string) => ({
    addListener: vi.fn((listener: Listener) => {
      fixture.listeners[name] = listener;
    }),
  });
  fixture.storageSet.mockImplementation(async (items: Record<string, unknown>) => {
    if (fixture.storageFailure) throw fixture.storageFailure;
    for (const [key, value] of Object.entries(structuredClone(items))) fixture.storage.set(key, value);
  });
  return {
    browser: {
      storage: {
        session: {
          get: vi.fn(async (key: string) => {
            await fixture.storageGetGate;
            return { [key]: structuredClone(fixture.storage.get(key)) };
          }),
          set: fixture.storageSet,
        },
      },
      runtime: { sendMessage: fixture.sendMessage },
      webRequest: {
        onBeforeRequest: event('beforeRequest'),
        onBeforeSendHeaders: event('beforeSendHeaders'),
        onBeforeRedirect: event('beforeRedirect'),
        onCompleted: event('completed'),
        onErrorOccurred: event('errorOccurred'),
      },
      webNavigation: {
        getFrame: vi.fn(async ({ tabId, frameId }: { tabId: number; frameId: number }) => fixture.frames.get(`${tabId}:${frameId}`) || null),
        onCommitted: event('committed'),
      },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          const tab = fixture.tabs.get(tabId);
          if (!tab) throw new Error('tab unavailable');
          return tab;
        }),
        onRemoved: event('removed'),
      },
    },
  };
});

import {
  NETWORK_CAPTURE_GLOBAL_MAX_BYTES,
  NETWORK_CAPTURE_GLOBAL_MAX_ENTRIES,
  clearNetworkRequests,
  listNetworkRequests,
  networkCaptureStatus,
  rebindNetworkCapturesForGrant,
  startNetworkCapture,
  stopNetworkCapture,
} from './service';

const NOW = 4_102_444_800_000;
const trackedTabs = new Set<number>();

function setTarget(
  tabId: number,
  url = `https://site-${tabId}.example.test/page`,
  documentId = `document-${tabId}`,
  input: { incognito?: boolean; cookieStoreId?: string } = {},
): void {
  fixture.frames.set(`${tabId}:0`, { url, documentId });
  fixture.tabs.set(tabId, {
    id: tabId,
    incognito: input.incognito === true,
    cookieStoreId: input.cookieStoreId,
  });
}

async function start(
  tabId: number,
  options: Parameters<typeof startNetworkCapture>[1] = {},
  owner?: Parameters<typeof startNetworkCapture>[2],
) {
  trackedTabs.add(tabId);
  return startNetworkCapture({ tabId, frameId: 0, documentId: fixture.frames.get(`${tabId}:0`)?.documentId }, options, owner);
}

function beforeRequest(
  tabId: number,
  requestId: string,
  timeStamp: number,
  input: { url?: string; type?: string; body?: ArrayBuffer } = {},
): void {
  fixture.listeners.beforeRequest({
    tabId,
    frameId: 0,
    documentId: fixture.frames.get(`${tabId}:0`)?.documentId,
    requestId,
    url: input.url || `https://site-${tabId}.example.test/api/${requestId}`,
    method: 'POST',
    type: input.type || 'xmlhttprequest',
    timeStamp,
    initiator: `https://site-${tabId}.example.test`,
    requestBody: input.body ? { raw: [{ bytes: input.body }] } : undefined,
  });
}

async function committed(tabId: number, url: string, documentId?: string): Promise<void> {
  fixture.frames.set(`${tabId}:0`, { url, documentId });
  fixture.listeners.committed({ tabId, frameId: 0, url, documentId, timeStamp: Date.now() });
  await vi.advanceTimersByTimeAsync(0);
}

describe('network capture lifecycle, budget and persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fixture.storage.clear();
    fixture.storageFailure = undefined;
    fixture.storageGetGate = undefined;
    fixture.frames.clear();
    fixture.tabs.clear();
    fixture.sendMessage.mockClear();
    fixture.storageSet.mockClear();
  });

  afterEach(async () => {
    for (const tabId of trackedTabs) {
      await stopNetworkCapture({ tabId, frameId: 0 }).catch(() => undefined);
    }
    trackedTabs.clear();
    await vi.advanceTimersByTimeAsync(251);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('moves a grant-owned capture to the refreshed document without restarting it', async () => {
    setTarget(41, 'https://grant.example.test/profile', 'document-old');
    const before = await start(
      41,
      { captureHeaders: true, captureBody: true },
      { kind: 'grant', grantId: 'grant-1', expiresAt: NOW + 60_000 },
    );

    await rebindNetworkCapturesForGrant('grant-1', [
      { tabId: 41, frameId: 0, documentId: 'document-new' },
    ]);

    const after = await networkCaptureStatus({ tabId: 41, frameId: 0, documentId: 'document-new' });
    expect(after).toMatchObject({ active: true, startedAt: before.startedAt });
    expect(after.target.documentId).toBe('document-new');
    expect((await networkCaptureStatus({ tabId: 41, frameId: 0, documentId: 'document-old' })).active).toBe(false);
  });

  it('does not let a grant refresh mutate or delete an unrelated local capture', async () => {
    setTarget(42, 'https://local.example.test/start', 'document-local');
    await start(42);

    await rebindNetworkCapturesForGrant('grant-1', [
      { tabId: 99, frameId: 0, documentId: 'unrelated-document' },
    ]);

    expect((await networkCaptureStatus({ tabId: 42, frameId: 0, documentId: 'document-local' })).active).toBe(true);
  });

  it('continues a local capture across a same-origin document and fails closed across origins', async () => {
    setTarget(43, 'https://navigation.example.test/start', 'document-start');
    const before = await start(43);
    await committed(43, 'https://navigation.example.test/next', 'document-next');

    const continued = await networkCaptureStatus({ tabId: 43, frameId: 0, documentId: 'document-next' });
    expect(continued).toMatchObject({ active: true, startedAt: before.startedAt });

    await committed(43, 'https://different.example.test/landing', 'document-cross-origin');
    expect((await networkCaptureStatus({ tabId: 43, frameId: 0, documentId: 'document-cross-origin' })).active).toBe(false);
  });

  it('does not retain a cross-origin navigation request before the commit boundary is processed', async () => {
    setTarget(44, 'https://source.example.test/start', 'document-source');
    await start(44);

    beforeRequest(44, 'navigation-1', NOW + 1, {
      type: 'main_frame',
      url: 'https://destination.example.test/landing',
    });

    expect(await listNetworkRequests({ tabId: 44, frameId: 0, documentId: 'document-source' })).toEqual([]);
  });

  it('retains a same-document WebSocket handshake as protocol evidence', async () => {
    setTarget(47, 'https://site-47.example.test/app', 'document-socket');
    await start(47, { captureHeaders: true, captureBody: true });

    beforeRequest(47, 'socket-1', NOW + 1, {
      type: 'websocket',
      url: 'wss://site-47.example.test/events',
    });

    const records = await listNetworkRequests({
      tabId: 47,
      frameId: 0,
      documentId: 'document-socket',
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      requestId: 'socket-1',
      resourceType: 'websocket',
      url: 'wss://site-47.example.test/events',
    });
  });

  it('detects a missed cross-origin commit when a document-less client asks for status after restart', async () => {
    setTarget(46, 'https://before-restart.example.test/start', 'document-before');
    await start(46);
    fixture.frames.set('46:0', {
      url: 'https://after-restart.example.test/landing',
      documentId: 'document-after',
    });

    expect((await networkCaptureStatus({ tabId: 46, frameId: 0 })).active).toBe(false);
  });

  it('serializes only the record changed by a hot-path request phase', async () => {
    setTarget(45);
    await start(45, { captureHeaders: true, maxEntries: 200 });
    for (let index = 0; index < 100; index += 1) beforeRequest(45, `request-${index}`, NOW + index);
    const stringify = vi.spyOn(JSON, 'stringify');

    fixture.listeners.beforeSendHeaders({
      tabId: 45,
      frameId: 0,
      documentId: 'document-45',
      requestId: 'request-99',
      url: 'https://site-45.example.test/api/request-99',
      method: 'POST',
      type: 'xmlhttprequest',
      timeStamp: NOW + 101,
      requestHeaders: [{ name: 'X-Test', value: 'value' }],
    });

    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
  });

  it('enforces a deterministic global record budget across sessions', async () => {
    for (let tabId = 50; tabId < 56; tabId += 1) {
      setTarget(tabId);
      await start(tabId, { maxEntries: 200 });
      for (let index = 0; index < 200; index += 1) {
        beforeRequest(tabId, `request-${tabId}-${index}`, NOW + (tabId - 50) * 200 + index);
      }
    }

    const statuses = await Promise.all([...Array(6)].map((_, index) => networkCaptureStatus({ tabId: 50 + index, frameId: 0 })));
    expect(statuses.reduce((total, status) => total + status.count, 0)).toBe(NETWORK_CAPTURE_GLOBAL_MAX_ENTRIES);
    expect(statuses.reduce((total, status) => total + status.droppedCount, 0)).toBe(200);
    expect(statuses[0].count).toBe(0);
    expect(statuses.at(-1)?.globalCount).toBe(NETWORK_CAPTURE_GLOBAL_MAX_ENTRIES);
  });

  it('enforces the aggregate byte budget without exceeding each session limit', async () => {
    const body = new Uint8Array(64 * 1024).fill(97).buffer;
    for (const tabId of [60, 61]) {
      setTarget(tabId);
      await start(tabId, { captureBody: true, maxBodyBytes: 64 * 1024, maxEntries: 200 });
    }
    for (let index = 0; index < 140; index += 1) {
      const tabId = index % 2 === 0 ? 60 : 61;
      beforeRequest(tabId, `large-${index}`, NOW + index, { body });
    }

    const left = await networkCaptureStatus({ tabId: 60, frameId: 0 });
    const right = await networkCaptureStatus({ tabId: 61, frameId: 0 });
    expect(right.globalRetainedBytes).toBeLessThanOrEqual(NETWORK_CAPTURE_GLOBAL_MAX_BYTES);
    expect((left.droppedCount + right.droppedCount)).toBeGreaterThan(0);
  });

  it('reports a storage failure as degraded and recovers on the next mutation', async () => {
    setTarget(70);
    await start(70);
    fixture.storageFailure = new Error('session quota exceeded');

    await vi.advanceTimersByTimeAsync(251);

    expect(await networkCaptureStatus({ tabId: 70, frameId: 0 })).toMatchObject({
      active: true,
      persistence: 'degraded',
      persistenceError: 'session quota exceeded',
    });

    fixture.storageFailure = undefined;
    beforeRequest(70, 'retry-request', NOW + 1);
    await vi.advanceTimersByTimeAsync(251);

    expect(await networkCaptureStatus({ tabId: 70, frameId: 0 })).toMatchObject({
      active: true,
      persistence: 'persisted',
    });
  });

  it('restores the bounded session after a simulated service-worker restart', async () => {
    setTarget(80);
    await start(80, { captureHeaders: true });
    beforeRequest(80, 'restored-request', NOW + 1);
    await vi.advanceTimersByTimeAsync(251);
    expect(fixture.storageSet).toHaveBeenCalled();

    let releaseStorage: (() => void) | undefined;
    fixture.storageGetGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    vi.resetModules();
    const fresh = await import('./service');
    beforeRequest(80, 'queued-during-restore', NOW + 2);
    releaseStorage?.();
    await vi.advanceTimersByTimeAsync(0);
    const restored = await fresh.networkCaptureStatus({ tabId: 80, frameId: 0, documentId: 'document-80' });

    expect(restored).toMatchObject({ active: true, count: 2, persistence: 'pending' });
    expect((await fresh.listNetworkRequests(restored.target)).map((record) => record.requestId)).toEqual([
      'queued-during-restore',
      'restored-request',
    ]);
    await fresh.clearNetworkRequests(restored.target);
    await fresh.stopNetworkCapture(restored.target);
  });
});
