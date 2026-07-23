import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStore: Record<string, unknown> = {};
const detachListeners: Array<(source: { tabId?: number }, reason: string) => void> = [];

const debuggerApi = {
  attach: vi.fn(async () => undefined),
  detach: vi.fn(async (target: { tabId?: number }) => {
    for (const listener of detachListeners) listener(target, 'canceled_by_user');
  }),
  getTargets: vi.fn(async () => []),
  sendCommand: vi.fn(async () => ({})),
  onEvent: { addListener: vi.fn() },
  onDetach: { addListener: vi.fn((listener: (source: { tabId?: number }, reason: string) => void) => detachListeners.push(listener)) },
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
      onAlarm: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  },
}));

vi.mock('@/features/browser-recording/service', () => ({
  armBrowserRecordingDeepBreak: vi.fn(async () => undefined),
  disarmBrowserRecordingDeepBreak: vi.fn(async () => undefined),
}));

vi.stubGlobal('chrome', { debugger: debuggerApi });

import {
  deepCaptureStatus,
  initializeDeepCaptureService,
  resumeDeepCapture,
  startDeepCapture,
} from './service';

describe('deep capture debugger lifecycle', () => {
  beforeAll(() => initializeDeepCaptureService());

  beforeEach(() => {
    for (const key of Object.keys(sessionStore)) delete sessionStore[key];
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
});
