import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeGrant } from '@/types/models';
import { AGENT_RUNTIME_STORAGE_KEY } from '@/protocol/storage';

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
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
  },
}));

function grant(id: string): BridgeGrant {
  return {
    id,
    taskId: `task-${id}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
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

function storedAction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-valid',
    requestId: 'request-valid',
    taskId: 'task-restored',
    grantId: 'restored',
    method: 'browser.context',
    state: 'running',
    startedAt: Date.now() - 100,
    ...overrides,
  };
}

describe('Agent Runtime restart recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(4_102_444_800_000);
    for (const key of Object.keys(fixture.session)) delete fixture.session[key];
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('filters corrupted persisted actions and cross-grant records on worker restart', async () => {
    fixture.session[AGENT_RUNTIME_STORAGE_KEY] = {
      state: 'running',
      taskId: 'task-restored',
      grantId: 'restored',
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      actions: [
        null,
        'not-an-action',
        storedAction({ id: '', requestId: '' }),
        storedAction({ id: 'wrong-grant', grantId: 'other' }),
        storedAction(),
      ],
    };
    const { getAgentRuntime } = await import('./service');

    const runtime = await getAgentRuntime();

    expect(runtime).toMatchObject({
      state: 'running',
      taskId: 'task-restored',
      grantId: 'restored',
      persistence: 'persisted',
    });
    expect(runtime.actions).toEqual([expect.objectContaining({ id: 'action-valid' })]);
  });

  it('fails closed to idle when a persisted active state has no owning grant', async () => {
    fixture.session[AGENT_RUNTIME_STORAGE_KEY] = {
      state: 'running',
      taskId: 'task-orphaned',
      updatedAt: Date.now(),
      actions: [storedAction()],
    };
    const { getAgentRuntime } = await import('./service');

    const runtime = await getAgentRuntime();
    expect(runtime).toMatchObject({ state: 'idle', actions: [] });
    expect(runtime).not.toHaveProperty('taskId');
    expect(runtime).not.toHaveProperty('grantId');
  });

  it('serializes concurrent begin and finish mutations without losing actions', async () => {
    const {
      beginAgentAction,
      finishAgentAction,
      getAgentRuntime,
      startAgentRuntime,
    } = await import('./service');
    const active = grant('concurrent');
    await startAgentRuntime(active);

    const actions = await Promise.all(Array.from({ length: 40 }, (_, index) => (
      beginAgentAction(active, {
        requestId: `request-${index}`,
        method: 'browser.context',
        targetTabId: 1,
      })
    )));
    expect((await getAgentRuntime()).actions).toHaveLength(40);

    await Promise.all(actions.map((action) => finishAgentAction(action.id, 'success')));
    const runtime = await getAgentRuntime();
    expect(runtime.actions).toHaveLength(40);
    expect(runtime.actions.every((action) => action.state === 'success')).toBe(true);
  });

  it('drops the previous grant actions and ignores their late completion after replacement', async () => {
    const {
      beginAgentAction,
      finishAgentAction,
      getAgentRuntime,
      startAgentRuntime,
    } = await import('./service');
    const previous = grant('previous');
    const replacement = grant('replacement');
    await startAgentRuntime(previous);
    const oldAction = await beginAgentAction(previous, {
      requestId: 'request-old',
      method: 'browser.context',
      targetTabId: 1,
    });

    const currentAction = await beginAgentAction(replacement, {
      requestId: 'request-current',
      method: 'browser.context',
      targetTabId: 1,
    });
    await finishAgentAction(oldAction.id, 'success');

    const runtime = await getAgentRuntime();
    expect(runtime).toMatchObject({
      state: 'running',
      grantId: replacement.id,
      taskId: replacement.taskId,
    });
    expect(runtime.actions).toEqual([
      expect.objectContaining({ id: currentAction.id, grantId: replacement.id, state: 'running' }),
    ]);
  });
});
