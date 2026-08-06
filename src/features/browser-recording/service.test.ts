import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (details: Record<string, any>) => unknown;

interface RawSnapshot {
  version: 9;
  active: boolean;
  recordingId?: string;
  startedAt?: number;
  count: number;
  droppedCount: number;
  retainedCallCount: number;
  retainedCallBytes: number;
  retainedCallDroppedCount: number;
  options?: { captureValues: boolean; maxEntries: number; maxValueBytes: number };
  events: Array<Record<string, unknown>>;
  callables: unknown[];
}

const fixture = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  storageFailure: undefined as Error | undefined,
  pages: new Map<number, RawSnapshot>(),
  listeners: {} as Record<string, Listener>,
  storageSet: vi.fn(),
}));

function clone<T>(value: T): T {
  return structuredClone(value);
}

vi.mock('wxt/browser', () => {
  const event = (name: string) => ({
    addListener: vi.fn((listener: Listener) => { fixture.listeners[name] = listener; }),
  });
  fixture.storageSet.mockImplementation(async (items: Record<string, unknown>) => {
    if (fixture.storageFailure) throw fixture.storageFailure;
    for (const [key, value] of Object.entries(clone(items))) fixture.storage.set(key, value);
  });
  return {
    browser: {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: clone(fixture.storage.get(key)) })),
          set: fixture.storageSet,
        },
      },
      runtime: { sendMessage: vi.fn(async () => undefined) },
      scripting: {
        executeScript: vi.fn(async (details: Record<string, any>) => {
          if (details.files) return [{ frameId: 0 }];
          const tabId = details.target.tabId as number;
          const command = details.args?.[2] as string;
          const input = (details.args?.[3] || {}) as Record<string, unknown>;
          const current = fixture.pages.get(tabId) || rawSnapshot(tabId);
          if (command === 'start') {
            current.active = true;
            current.recordingId = typeof input.recordingId === 'string' ? input.recordingId : `recording-${tabId}`;
            current.startedAt = typeof input.startedAt === 'number' ? input.startedAt : Date.now() + tabId;
            current.options = {
              captureValues: input.captureValues === true,
              maxEntries: Number(input.maxEntries) || 500,
              maxValueBytes: Number(input.maxValueBytes) || 8_192,
            };
          } else if (command === 'stop') {
            current.active = false;
          } else if (command === 'clear') {
            Object.assign(current, rawSnapshot(tabId));
          }
          fixture.pages.set(tabId, current);
          return [{ frameId: 0, result: clone(current) }];
        }),
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 1,
          title: `Tab ${tabId}`,
          url: `https://site-${tabId}.example.test/page`,
          incognito: false,
          cookieStoreId: 'store-default',
        })),
        onRemoved: event('removed'),
        onCreated: event('created'),
      },
      cookies: {
        getAllCookieStores: vi.fn(async () => [{ id: 'store-default', tabIds: [...fixture.pages.keys()] }]),
      },
      webNavigation: {
        getFrame: vi.fn(async ({ tabId }: { tabId: number }) => ({
          url: `https://site-${tabId}.example.test/page`,
          documentId: `document-${tabId}`,
        })),
        onBeforeNavigate: event('beforeNavigate'),
        onCommitted: event('committed'),
        onDOMContentLoaded: event('domContentLoaded'),
        onCompleted: event('completed'),
        onHistoryStateUpdated: event('history'),
        onReferenceFragmentUpdated: event('fragment'),
        onErrorOccurred: event('navigationError'),
      },
    },
  };
});

function rawSnapshot(tabId: number, events: Array<Record<string, unknown>> = []): RawSnapshot {
  return {
    version: 9,
    active: false,
    recordingId: `recording-${tabId}`,
    startedAt: 1_000 + tabId,
    count: events.length,
    droppedCount: 0,
    retainedCallCount: 2,
    retainedCallBytes: 4_096,
    retainedCallDroppedCount: 0,
    options: { captureValues: true, maxEntries: 500, maxValueBytes: 8_192 },
    events,
    callables: [],
  };
}

function recordingEvent(index: number, input: { large?: boolean; preview?: boolean } = {}): Record<string, unknown> {
  const preview = input.preview ? `${index}:`.padEnd(8_192, '密') : undefined;
  return {
    id: `event-${index}`,
    sequence: index + 1,
    timestamp: 10_000 + index,
    recordingId: 'recording',
    traceId: `trace-${Math.floor(index / 4)}`,
    kind: 'fetch',
    operation: 'request',
    method: 'POST',
    url: input.large
      ? `https://example.test/${'route'.repeat(1_600)}-${index}`
      : `https://example.test/${index}`,
    stack: input.large ? 'frame\n'.repeat(680) : undefined,
    inputs: preview === undefined ? [] : [{
      path: '$body',
      fingerprint: `fingerprint-${index}`,
      encoding: 'text',
      byteLength: preview.length,
      preview,
    }],
    outputs: [],
    sensitiveCaptured: preview !== undefined,
    inputPreview: preview,
  };
}

async function freshService() {
  vi.resetModules();
  return import('./service');
}

describe('browser recording storage, snapshot and retained-value budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(4_102_444_800_000);
    fixture.storage.clear();
    fixture.pages.clear();
    fixture.storageFailure = undefined;
    fixture.storageSet.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reports persistence failure and recovers on the next changed snapshot', async () => {
    fixture.pages.set(1, rawSnapshot(1));
    const service = await freshService();
    const snapshot = await service.startBrowserRecording({ tabId: 1, frameId: 0 });
    expect(snapshot.status.persistence).toBe('pending');

    fixture.storageFailure = new Error('session quota exceeded');
    await vi.advanceTimersByTimeAsync(501);
    expect(snapshot.status).toMatchObject({
      persistence: 'degraded',
      persistenceError: 'session quota exceeded',
    });

    fixture.storageFailure = undefined;
    fixture.pages.get(1)!.events.push(recordingEvent(1));
    fixture.pages.get(1)!.count = 1;
    await service.getBrowserRecording({ tabId: 1, frameId: 0 }, 500, true);
    await vi.advanceTimersByTimeAsync(501);
    expect((await service.browserRecordingStatus({ tabId: 1, frameId: 0 })).persistence).toBe('persisted');
  });

  it('makes corrupted restored sessions visible and repairs storage on the next write', async () => {
    fixture.storage.set('session.browser-recording-sessions.v4', {
      version: 4,
      sessions: { broken: { snapshot: null } },
    });
    fixture.pages.set(3, rawSnapshot(3));
    const service = await freshService();
    const snapshot = await service.startBrowserRecording({ tabId: 3, frameId: 0 });

    expect(snapshot.status).toMatchObject({
      persistence: 'degraded',
      persistenceError: '已忽略 1 个损坏的录制会话',
    });
    await vi.advanceTimersByTimeAsync(501);
    expect(snapshot.status.persistence).toBe('persisted');
  });

  it('bounds plaintext previews before discarding event metadata', async () => {
    const events = Array.from({ length: 120 }, (_, index) => recordingEvent(index, { preview: true }));
    fixture.pages.set(2, rawSnapshot(2, events));
    const service = await freshService();
    const snapshot = await service.startBrowserRecording({ tabId: 2, frameId: 0 }, { captureValues: true });

    expect(snapshot.events).toHaveLength(120);
    expect(snapshot.status.retainedPreviewBytes).toBeLessThanOrEqual(512 * 1024);
    expect(snapshot.status.previewDroppedCount).toBeGreaterThan(0);
    expect(snapshot.events.some((event) => event.inputs[0]?.fingerprint)).toBe(true);
    expect(snapshot.status.retainedCallBytes).toBe(4_096);
  });

  it('drops the globally oldest events to keep each snapshot and all sessions bounded', async () => {
    const service = await freshService();
    for (let tabId = 10; tabId < 15; tabId += 1) {
      fixture.pages.set(tabId, rawSnapshot(
        tabId,
        Array.from({ length: 190 }, (_, index) => recordingEvent(tabId * 1_000 + index, { large: true })),
      ));
      const snapshot = await service.startBrowserRecording({ tabId, frameId: 0 });
      expect(snapshot.status.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    }

    const snapshots = await Promise.all(Array.from({ length: 5 }, (_, index) => (
      service.getBrowserRecording({ tabId: 10 + index, frameId: 0 }, 500, false)
    )));
    expect(snapshots.at(-1)?.status.globalRetainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(snapshots.reduce((total, item) => total + (item.status.budgetDroppedCount || 0), 0)).toBeGreaterThan(0);
  });

  it('restores a bounded persisted session after a service-worker restart', async () => {
    fixture.pages.set(20, rawSnapshot(20, [recordingEvent(1)]));
    let service = await freshService();
    await service.startBrowserRecording({ tabId: 20, frameId: 0 });
    await vi.advanceTimersByTimeAsync(501);
    expect(fixture.storageSet).toHaveBeenCalled();

    service = await freshService();
    const restored = await service.getBrowserRecording({ tabId: 20, frameId: 0 }, 500, false);
    expect(restored.events).toHaveLength(1);
    expect(restored.status).toMatchObject({ persistence: 'pending', globalSessionCount: 1 });
    await vi.advanceTimersByTimeAsync(501);
    expect((await service.browserRecordingStatus({ tabId: 20, frameId: 0 }))).toMatchObject({
      persistence: 'persisted',
      globalSessionCount: 1,
    });
  });
});
