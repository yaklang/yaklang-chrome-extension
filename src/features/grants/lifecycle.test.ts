import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeGrant, HumanHandoff } from '@/types/models';

const fixture = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  alarms: new Map<string, { when?: number }>(),
  alarmListeners: [] as Array<(alarm: { name: string }) => void>,
  alarmClear: vi.fn(async (_name: string) => false),
  alarmCreate: vi.fn(async (_name: string, _options: { when?: number }) => undefined),
  stopNetwork: vi.fn(async (_grantId: string) => undefined),
  stopRecording: vi.fn(async (_grantId: string) => undefined),
  stopDeepCapture: vi.fn(async (_grantId: string) => undefined),
  appendAudit: vi.fn(async () => undefined),
  clearBadge: vi.fn(async () => undefined),
}));

function area(data: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
    },
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: area(fixture.local), session: area(fixture.session) },
    alarms: {
      clear: fixture.alarmClear,
      create: fixture.alarmCreate,
      onAlarm: { addListener: vi.fn((listener: (alarm: { name: string }) => void) => fixture.alarmListeners.push(listener)) },
    },
    action: { setBadgeText: fixture.clearBadge },
  },
}));

vi.mock('@/features/network-capture/service', () => ({
  stopNetworkCapturesForGrant: fixture.stopNetwork,
}));
vi.mock('@/features/browser-recording/service', () => ({
  stopBrowserRecordingsForGrant: fixture.stopRecording,
}));
vi.mock('@/features/deep-capture/service', () => ({
  stopDeepCapturesForGrant: fixture.stopDeepCapture,
}));
vi.mock('@/features/diagnostics/audit', () => ({
  appendAuditEvent: fixture.appendAudit,
}));

import { DEFAULT_STATE, getState, setState } from '@/platform/storage/state';
import {
  ACTIVE_GRANT_EXPIRY_ALARM,
  configureGrantLifecycleHooks,
  currentActiveGrant,
  registerGrantLifecycleListeners,
  replaceActiveGrant,
  restoreGrantLifecycle,
  revokeActiveGrant,
  updateActiveGrant,
} from './lifecycle';

const NOW = 4_102_444_800_000;

function grant(id: string, expiresAt = NOW + 60_000): BridgeGrant {
  return {
    id,
    taskId: `task-${id}`,
    createdAt: NOW - 1_000,
    expiresAt,
    scopes: ['browser.tabs.read'],
    targets: [{
      tabId: 1,
      frameId: 0,
      documentId: `document-${id}`,
      isolationContextId: 'browser-profile:store-1',
      cookieStoreId: 'store-1',
      origin: 'https://example.test',
      grantedUrl: 'https://example.test/',
      title: 'Example',
    }],
  };
}

function handoff(id: string): HumanHandoff {
  return {
    id,
    taskId: 'task-old',
    target: grant('handoff').targets[0],
    reason: 'mfa',
    message: 'Confirm',
    state: 'waiting_for_user',
    requestedAt: NOW - 2_000,
  };
}

describe('grant lifecycle manager', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const key of Object.keys(fixture.local)) delete fixture.local[key];
    for (const key of Object.keys(fixture.session)) delete fixture.session[key];
    fixture.alarms.clear();
    vi.clearAllMocks();
    fixture.alarmClear.mockImplementation(async (name) => fixture.alarms.delete(name));
    fixture.alarmCreate.mockImplementation(async (name, options) => {
      fixture.alarms.set(name, options);
    });
    configureGrantLifecycleHooks({});
    await setState(structuredClone(DEFAULT_STATE));
  });

  afterEach(() => vi.useRealTimers());

  it('consumes an expired stored grant and releases all grant-owned resources', async () => {
    const expired = grant('expired-restore', NOW - 1);
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: expired });

    const state = await restoreGrantLifecycle();

    expect(state.activeGrant).toBeUndefined();
    expect((await getState()).activeGrant).toBeUndefined();
    expect(fixture.stopNetwork).toHaveBeenCalledWith(expired.id);
    expect(fixture.stopRecording).toHaveBeenCalledWith(expired.id);
    expect(fixture.stopDeepCapture).toHaveBeenCalledWith(expired.id);
    expect(fixture.alarms.has(ACTIVE_GRANT_EXPIRY_ALARM)).toBe(false);
  });

  it('serializes concurrent replacements and cleans the actual previous grant from each commit', async () => {
    const old = grant('replace-old');
    const first = grant('replace-first', NOW + 120_000);
    const second = grant('replace-second', NOW + 180_000);
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: old });

    await Promise.all([replaceActiveGrant(first), replaceActiveGrant(second)]);

    expect((await getState()).activeGrant?.id).toBe(second.id);
    expect(fixture.stopNetwork.mock.calls.map(([id]) => id)).toEqual([old.id, first.id]);
    expect(fixture.stopRecording.mock.calls.map(([id]) => id)).toEqual([old.id, first.id]);
    expect(fixture.stopDeepCapture.mock.calls.map(([id]) => id)).toEqual([old.id, first.id]);
    expect(fixture.alarms.get(ACTIVE_GRANT_EXPIRY_ALARM)).toEqual({ when: second.expiresAt });
  });

  it('makes repeated revocation idempotent', async () => {
    const active = grant('revoke-once');
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: active });

    const first = await revokeActiveGrant();
    const second = await revokeActiveGrant();

    expect(first.previousGrant?.id).toBe(active.id);
    expect(second.previousGrant).toBeUndefined();
    expect(fixture.stopNetwork).toHaveBeenCalledTimes(1);
    expect(fixture.stopRecording).toHaveBeenCalledTimes(1);
    expect(fixture.stopDeepCapture).toHaveBeenCalledTimes(1);
  });

  it('cancels a waiting handoff and publishes the resolved state on replacement', async () => {
    const waiting = handoff('handoff-waiting');
    const previous = grant('handoff-old');
    previous.taskId = waiting.taskId;
    const emitHandoffChanged = vi.fn();
    await setState({
      ...structuredClone(DEFAULT_STATE),
      activeGrant: previous,
      handoff: waiting,
    });
    configureGrantLifecycleHooks({ emitHandoffChanged });

    const { state } = await replaceActiveGrant(grant('handoff-new'));

    expect(state.handoff).toMatchObject({ id: waiting.id, state: 'cancelled', resolvedAt: NOW });
    expect(fixture.clearBadge).toHaveBeenCalledWith({ text: '', tabId: waiting.target.tabId });
    expect(emitHandoffChanged).toHaveBeenCalledWith(state.handoff);
  });

  it('does not cancel a paired-instance handoff when an authorization-test grant ends', async () => {
    const waiting = handoff('paired-handoff');
    waiting.taskId = 'paired-browser-instance';
    await setState({
      ...structuredClone(DEFAULT_STATE),
      activeGrant: grant('authorization-test'),
      handoff: waiting,
    });

    const { state } = await revokeActiveGrant();

    expect(state.handoff).toEqual(waiting);
    expect(fixture.clearBadge).not.toHaveBeenCalled();
  });

  it('rejects an update that reaches the queue after expiry and performs cleanup first', async () => {
    const expired = grant('expired-update', NOW - 1);
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: expired });

    await expect(updateActiveGrant(expired.id, (item) => item)).rejects.toMatchObject({ code: 'grant_expired' });
    expect((await getState()).activeGrant).toBeUndefined();
    expect(fixture.stopDeepCapture).toHaveBeenCalledWith(expired.id);
  });

  it('returns a live grant without rewriting its expiry alarm on every capability lookup', async () => {
    const active = grant('lookup-live');
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: active });
    await restoreGrantLifecycle();
    fixture.alarms.clear();

    expect((await currentActiveGrant())?.id).toBe(active.id);
    expect(fixture.alarms.size).toBe(0);
  });

  it('expires the active grant when the exact lifecycle alarm fires', async () => {
    const active = grant('alarm-expiry', NOW + 30_000);
    registerGrantLifecycleListeners();
    await replaceActiveGrant(active);
    vi.setSystemTime(active.expiresAt + 1);

    fixture.alarmListeners.at(-1)?.({ name: ACTIVE_GRANT_EXPIRY_ALARM });
    await currentActiveGrant();

    expect((await getState()).activeGrant).toBeUndefined();
    expect(fixture.stopNetwork).toHaveBeenCalledWith(active.id);
  });

  it('reschedules an early alarm without revoking a still-live grant', async () => {
    const active = grant('alarm-early', NOW + 30_000);
    registerGrantLifecycleListeners();
    await replaceActiveGrant(active);
    fixture.alarms.clear();

    fixture.alarmListeners.at(-1)?.({ name: ACTIVE_GRANT_EXPIRY_ALARM });
    await currentActiveGrant();

    expect((await getState()).activeGrant?.id).toBe(active.id);
    expect(fixture.alarms.get(ACTIVE_GRANT_EXPIRY_ALARM)).toEqual({ when: active.expiresAt });
    expect(fixture.stopNetwork).not.toHaveBeenCalledWith(active.id);
  });

  it('does not commit a replacement when its expiry alarm cannot be scheduled', async () => {
    const old = grant('alarm-old');
    const next = grant('alarm-next', NOW + 120_000);
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: old });
    fixture.alarms.set(ACTIVE_GRANT_EXPIRY_ALARM, { when: old.expiresAt });
    fixture.alarmCreate.mockRejectedValueOnce(new Error('alarms unavailable'));

    await expect(replaceActiveGrant(next)).rejects.toThrow('alarms unavailable');

    expect((await getState()).activeGrant?.id).toBe(old.id);
    expect(fixture.alarms.get(ACTIVE_GRANT_EXPIRY_ALARM)).toEqual({ when: old.expiresAt });
    expect(fixture.stopNetwork).not.toHaveBeenCalled();
  });

  it('does not couple an authorization-test grant to Agent runtime state', async () => {
    const active = grant('authorization-only');

    await expect(replaceActiveGrant(active)).resolves.toMatchObject({
      state: { activeGrant: { id: active.id } },
    });
  });

  it('clears authorization state even when one resource cleanup reports a failure', async () => {
    const active = grant('partial-cleanup');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await setState({ ...structuredClone(DEFAULT_STATE), activeGrant: active });
    fixture.stopDeepCapture.mockRejectedValueOnce(new Error('debugger detach failed'));

    await revokeActiveGrant();

    expect((await getState()).activeGrant).toBeUndefined();
    expect(fixture.stopNetwork).toHaveBeenCalledWith(active.id);
    expect(fixture.stopRecording).toHaveBeenCalledWith(active.id);
    expect(fixture.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'grant.cleanup',
      outcome: 'error',
      errorCode: 'grant_cleanup_failed',
    }));
    consoleError.mockRestore();
  });
});
