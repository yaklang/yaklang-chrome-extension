import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore: Record<string, unknown> = {};
const detachListeners: Array<(source: { tabId?: number; sessionId?: string }, reason: string) => void> = [];
const eventListeners: Array<(source: { tabId?: number; sessionId?: string }, method: string, params?: Record<string, unknown>) => void> = [];
const alarmListeners: Array<(alarm: { name: string }) => void> = [];
const removedListeners: Array<(tabId: number) => void> = [];
const attachedTabs = new Set<number>();
const knownTabs = new Set<number>();
let failResume = false;
let failDetach = false;

const STORAGE_KEY = 'session.deep-capture.v1';

const debuggerApi = {
  attach: vi.fn(async (target: { tabId?: number }) => {
    if (target.tabId) {
      knownTabs.add(target.tabId);
      attachedTabs.add(target.tabId);
    }
  }),
  detach: vi.fn(async (target: { tabId?: number }) => {
    if (failDetach) throw new Error('fixture detach failed');
    if (target.tabId) attachedTabs.delete(target.tabId);
    for (const listener of detachListeners) listener(target, 'canceled_by_user');
  }),
  getTargets: vi.fn(async () => [...knownTabs].map((tabId) => ({
    attached: attachedTabs.has(tabId), tabId, id: `target-${tabId}`, type: 'page', url: 'https://example.test/',
  }))),
  sendCommand: vi.fn(async (_target: { tabId?: number; sessionId?: string }, method: string) => {
    if (method === 'Debugger.resume' && failResume) throw new Error('fixture resume failed');
    return {};
  }),
  onEvent: { addListener: vi.fn((listener: typeof eventListeners[number]) => eventListeners.push(listener)) },
  onDetach: { addListener: vi.fn((listener: (source: { tabId?: number; sessionId?: string }, reason: string) => void) => detachListeners.push(listener)) },
};

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(sessionStore, values)),
      },
    },
    runtime: { sendMessage: vi.fn(async () => undefined) },
    alarms: {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn((listener: typeof alarmListeners[number]) => alarmListeners.push(listener)) },
    },
    tabs: { onRemoved: { addListener: vi.fn((listener: typeof removedListeners[number]) => removedListeners.push(listener)) } },
  },
}));

vi.mock('@/features/browser-recording/service', () => ({
  armBrowserRecordingDeepBreak: vi.fn(async () => undefined),
  disarmBrowserRecordingDeepBreak: vi.fn(async () => undefined),
}));

vi.mock('@/platform/browser/targets', () => ({
  getTab: vi.fn(async (tabId: number) => ({
    id: tabId,
    windowId: 1,
    title: 'Fixture',
    url: 'https://example.test/',
    incognito: false,
    cookieStoreId: 'store-1',
    isolationContextId: 'browser-profile:store-1',
  })),
}));

vi.stubGlobal('chrome', { debugger: debuggerApi });

import {
  createCapturedPageCallable,
  deepCaptureStatus,
  initializeDeepCaptureService,
  reconcileDeepCaptureSessions,
  resumeDeepCapture,
  startDeepCapture,
} from './service';

function seedStatus(tabId: number, status: Record<string, unknown>): void {
  knownTabs.add(tabId);
  sessionStore[STORAGE_KEY] = {
    [tabId]: {
      target: { tabId, frameId: 0 },
      isolationContextId: 'browser-profile:store-1',
      cookieStoreId: 'store-1',
      attachedAt: Date.now(),
      owner: { kind: 'local' },
      ...status,
    },
  };
}

function pausedStatus(tabId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    state: 'paused',
    matcher: { kind: 'request', urlPattern: '/login' },
    pause: {
      reason: 'XHR',
      pausedAt: now,
      deadline: now + 30_000,
      collecting: false,
      frames: [{
        id: 'frame-1', index: 0, functionName: 'submitLogin', scriptId: 'script-1',
        url: 'https://example.test/app.js', lineNumber: 10, columnNumber: 2,
        scopes: [], thisPreview: 'Window', sourceKind: 'page', libraryFrame: false,
        functionInspection: { resolved: false, riskFlags: [] },
      }],
    },
    ...overrides,
  };
}

describe('deep capture debugger lifecycle', () => {
  beforeAll(() => initializeDeepCaptureService());

  beforeEach(() => {
    for (const key of Object.keys(sessionStore)) delete sessionStore[key];
    attachedTabs.clear();
    knownTabs.clear();
    failResume = false;
    failDetach = false;
    vi.clearAllMocks();
  });

  it('detaches after a one-shot capture without treating its own detach event as an error', async () => {
    const target = { tabId: 17, frameId: 0 };

    await startDeepCapture(target, { kind: 'request', urlPattern: '/login' });
    const resumed = await resumeDeepCapture(target, 'callable-created');
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).state).toBe('captured'));

    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 17 });
    expect(resumed).toMatchObject({ state: 'captured', error: undefined });
    expect(await deepCaptureStatus(target)).toMatchObject({ state: 'captured', error: undefined });
  });

  it('treats the browser debug banner cancel action as a normal detach', async () => {
    const target = { tabId: 18, frameId: 0 };
    await startDeepCapture(target, { kind: 'request', urlPattern: '/account' });

    for (const listener of detachListeners) listener({ tabId: target.tabId }, 'canceled_by_user');
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).state).toBe('detached'));

    expect(await deepCaptureStatus(target)).toMatchObject({ state: 'detached', error: undefined });
  });

  it('refuses to attach a debugger for an already expired grant owner', async () => {
    const target = { tabId: 19, frameId: 0 };

    await expect(startDeepCapture(
      target,
      { kind: 'request', urlPattern: '/expired' },
      { kind: 'grant', grantId: 'expired-grant', expiresAt: Date.now() - 1 },
    )).rejects.toMatchObject({ code: 'grant_expired' });

    expect(debuggerApi.attach).not.toHaveBeenCalled();
  });

  it('restores a paused page when callable capture validation fails', async () => {
    const target = { tabId: 20, frameId: 0 };
    seedStatus(target.tabId, pausedStatus(target.tabId, {
      pause: {
        reason: 'instrumentation', pausedAt: Date.now(), deadline: Date.now() + 30_000, collecting: false,
        frames: [{
          id: 'hook-frame', index: 0, functionName: 'recordedFetch', scriptId: 'hook-script',
          url: 'chrome-extension://fixture/page-recorder-main-world.js', lineNumber: 1, columnNumber: 1,
          scopes: [], thisPreview: 'Window', sourceKind: 'extension-hook', libraryFrame: true,
          functionInspection: { resolved: false, riskFlags: [] },
        }],
      },
    }));
    attachedTabs.add(target.tabId);

    await expect(createCapturedPageCallable(
      target,
      'hook-frame',
      { strategy: 'selected-frame' },
    )).rejects.toMatchObject({ code: 'callable_capture_failed' });

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: target.tabId }, 'Debugger.resume', undefined);
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: target.tabId });
    expect(await deepCaptureStatus(target)).toMatchObject({
      state: 'captured',
      recovery: { page: 'running', debugger: 'detached', trigger: 'callable-capture-failed' },
    });
  });

  it('reports a still-attached debugger without claiming the page remains paused when resume succeeds', async () => {
    const target = { tabId: 21, frameId: 0 };
    seedStatus(target.tabId, pausedStatus(target.tabId));
    attachedTabs.add(target.tabId);
    failDetach = true;

    const result = await resumeDeepCapture(target);

    expect(result).toMatchObject({
      state: 'captured',
      recovery: { page: 'running', debugger: 'still-attached' },
    });
    expect(result.error).toContain('页面已经恢复，但调试会话未能自动结束');
  });

  it('fails closed when both page resume and debugger detach fail', async () => {
    const target = { tabId: 22, frameId: 0 };
    seedStatus(target.tabId, pausedStatus(target.tabId));
    attachedTabs.add(target.tabId);
    failResume = true;
    failDetach = true;

    const result = await resumeDeepCapture(target);

    expect(result).toMatchObject({
      state: 'error',
      recovery: { page: 'possibly-paused', debugger: 'still-attached' },
    });
    expect(result.pause).toBeDefined();
    expect(result.error).toContain('页面可能仍处于暂停状态');
  });

  it('restores an expired grant-owned paused session before rejecting further use', async () => {
    const target = { tabId: 23, frameId: 0 };
    seedStatus(target.tabId, pausedStatus(target.tabId, {
      owner: { kind: 'grant', grantId: 'expired-grant', expiresAt: Date.now() - 1 },
    }));
    attachedTabs.add(target.tabId);

    const result = await deepCaptureStatus(target);

    expect(result).toMatchObject({ state: 'detached', recovery: { page: 'running', debugger: 'detached' } });
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: target.tabId }, 'Debugger.resume', undefined);
  });

  it('re-arms a future watchdog after service-worker restoration', async () => {
    const target = { tabId: 24, frameId: 0 };
    const deadline = Date.now() + 20_000;
    seedStatus(target.tabId, pausedStatus(target.tabId, {
      pause: { ...(pausedStatus(target.tabId).pause as object), deadline },
    }));
    attachedTabs.add(target.tabId);

    await reconcileDeepCaptureSessions();

    const browserModule = await import('wxt/browser');
    expect(browserModule.browser.alarms.create).toHaveBeenCalledWith(`deep-capture-watchdog:${target.tabId}`, { when: deadline });
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('restores an overdue paused page after service-worker restoration', async () => {
    const target = { tabId: 25, frameId: 0 };
    seedStatus(target.tabId, pausedStatus(target.tabId, {
      pause: { ...(pausedStatus(target.tabId).pause as object), deadline: Date.now() - 1 },
    }));
    attachedTabs.add(target.tabId);

    await reconcileDeepCaptureSessions();

    expect(await deepCaptureStatus(target)).toMatchObject({
      state: 'captured',
      recovery: { page: 'running', debugger: 'detached', trigger: 'service-worker-restart' },
    });
  });

  it('cleans an armed session when its tab closes', async () => {
    const target = { tabId: 26, frameId: 0 };
    await startDeepCapture(target, { kind: 'request', urlPattern: '/account' });

    for (const listener of removedListeners) listener(target.tabId);
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).state).toBe('detached'));

    const browserModule = await import('wxt/browser');
    expect(browserModule.browser.alarms.clear).toHaveBeenCalledWith(`deep-capture-watchdog:${target.tabId}`);
  });

  it('marks a DevTools takeover as an error while confirming that the page is running', async () => {
    const target = { tabId: 27, frameId: 0 };
    await startDeepCapture(target, { kind: 'request', urlPattern: '/account' });
    attachedTabs.delete(target.tabId);

    for (const listener of detachListeners) listener({ tabId: target.tabId }, 'replaced_with_devtools');
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).state).toBe('error'));

    expect(await deepCaptureStatus(target)).toMatchObject({
      state: 'error',
      recovery: { page: 'running', debugger: 'detached', trigger: 'debugger-takeover' },
    });
  });

  it('records source-map metadata while declaring the worker evidence boundary', async () => {
    const target = { tabId: 28, frameId: 0 };
    await startDeepCapture(target, { kind: 'request', urlPattern: '/login' });
    for (const listener of eventListeners) {
      listener({ tabId: target.tabId }, 'Debugger.scriptParsed', {
        scriptId: 'script-with-map',
        url: 'https://example.test/assets/app.min.js',
        sourceMapURL: 'https://example.test/assets/app.min.js.map',
      });
      listener({ tabId: target.tabId }, 'Debugger.paused', {
        reason: 'XHR',
        callFrames: [{
          callFrameId: 'mapped-frame', functionName: 'submitLogin', url: '',
          location: { scriptId: 'script-with-map', lineNumber: 3, columnNumber: 4 },
          scopeChain: [], this: { type: 'object', description: 'Window' },
        }],
      });
    }

    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).state).toBe('paused'));
    const result = await deepCaptureStatus(target);
    expect(result.pause?.frames[0]).toMatchObject({
      url: 'https://example.test/assets/app.min.js',
      sourceMapUrl: 'https://example.test/assets/app.min.js.map',
    });
    expect(result.boundary).toEqual({
      target: 'main-document', sourceMaps: 'metadata-only', workers: 'evidence-only', wasm: 'scope-evidence-only',
    });
    await resumeDeepCapture(target);
  });

  it('observes same-origin service-worker targets without routing their pauses into the page capture', async () => {
    const target = { tabId: 29, frameId: 0 };
    await startDeepCapture(target, { kind: 'request', urlPattern: '/login' });

    for (const listener of eventListeners) listener({ tabId: target.tabId }, 'Target.attachedToTarget', {
      sessionId: 'worker-session-1',
      waitingForDebugger: false,
      targetInfo: {
        targetId: 'service-worker-1',
        type: 'service_worker',
        url: 'https://example.test/service-worker.js?credential=redacted#runtime',
      },
    });
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).workerTargets).toHaveLength(1));

    for (const listener of eventListeners) listener(
      { tabId: target.tabId, sessionId: 'worker-session-1' },
      'Debugger.scriptParsed',
      { scriptId: 'worker-script-1', url: 'https://example.test/service-worker.js' },
    );
    for (const listener of eventListeners) listener(
      { tabId: target.tabId, sessionId: 'worker-session-1' },
      'Debugger.paused',
      { reason: 'instrumentation', callFrames: [] },
    );

    await vi.waitFor(async () => expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: target.tabId, sessionId: 'worker-session-1' },
      'Debugger.resume',
      undefined,
    ));
    const observed = await deepCaptureStatus(target);
    expect(observed).toMatchObject({
      state: 'armed',
      boundary: { workers: 'evidence-only' },
      workerTargets: [{
        targetId: 'service-worker-1',
        type: 'service_worker',
        url: 'https://example.test/service-worker.js',
        state: 'attached',
        scriptCount: 1,
      }],
    });
    expect(observed.workerTargets?.[0]).not.toHaveProperty('sessionId');
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: target.tabId, sessionId: 'worker-session-1' },
      'Debugger.setSkipAllPauses',
      { skip: true },
    );

    for (const listener of eventListeners) listener({ tabId: target.tabId }, 'Target.detachedFromTarget', {
      sessionId: 'worker-session-1',
      targetId: 'service-worker-1',
    });
    await vi.waitFor(async () => expect((await deepCaptureStatus(target)).workerTargets?.[0]?.state).toBe('detached'));
    await resumeDeepCapture(target);
  });
});
