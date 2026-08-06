import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeGrant } from '@/types/models';

const store = vi.hoisted(() => ({} as Record<string, unknown>));
const persistence = vi.hoisted(() => ({ sets: 0, fail: false }));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        async get(key: string) {
          return key in store ? { [key]: structuredClone(store[key]) } : {};
        },
        async set(items: Record<string, unknown>) {
          persistence.sets += 1;
          if (persistence.fail) throw new Error('fixture session quota exceeded');
          Object.assign(store, structuredClone(items));
        },
      },
    },
  },
}));

import {
  beginAgentAction,
  endAgentRuntimeForGrant,
  finishAgentAction,
  getAgentRuntime,
  startAgentRuntime,
} from './service';

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

describe('Agent Runtime grant ownership', () => {
  beforeEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(store)) delete store[key];
    persistence.sets = 0;
    persistence.fail = false;
  });

  it('cancels running actions when their owning grant expires', async () => {
    const active = grant('active');
    await startAgentRuntime(active);
    const action = await beginAgentAction(active, {
      requestId: 'request-1',
      method: 'browser.context',
      targetTabId: 1,
    });

    const runtime = await endAgentRuntimeForGrant('expired', active);

    expect(runtime.state).toBe('expired');
    expect(runtime.actions.find((item) => item.id === action.id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'expired',
    });
  });

  it('does not let cleanup for an old grant overwrite a newer runtime', async () => {
    const oldGrant = grant('old');
    const currentGrant = grant('current');
    await startAgentRuntime(oldGrant);
    await startAgentRuntime(currentGrant);

    const runtime = await endAgentRuntimeForGrant('revoked', oldGrant);

    expect(runtime).toMatchObject({
      state: 'running',
      grantId: currentGrant.id,
      taskId: currentGrant.taskId,
    });
    expect(await getAgentRuntime()).toMatchObject({
      state: 'running',
      grantId: currentGrant.id,
    });
  });

  it('batches begin and finish action mutations into one deferred session write', async () => {
    vi.useFakeTimers();
    const active = grant('batched');
    await startAgentRuntime(active);
    expect(persistence.sets).toBe(1);

    const action = await beginAgentAction(active, {
      requestId: 'request-batched', method: 'browser.context', targetTabId: 1,
    });
    await finishAgentAction(action.id, 'success');
    expect(persistence.sets).toBe(1);
    expect(await getAgentRuntime()).toMatchObject({ persistence: 'pending', pendingMutations: 2 });

    await vi.advanceTimersByTimeAsync(101);
    expect(persistence.sets).toBe(2);
    expect(await getAgentRuntime()).toMatchObject({ persistence: 'persisted', pendingMutations: 0 });
  });

  it('keeps action state in memory and exposes a session persistence failure', async () => {
    vi.useFakeTimers();
    const active = grant('degraded');
    await startAgentRuntime(active);
    persistence.fail = true;
    const action = await beginAgentAction(active, {
      requestId: 'request-degraded', method: 'browser.context', targetTabId: 1,
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(await getAgentRuntime()).toMatchObject({
      persistence: 'degraded', pendingMutations: 1, persistenceError: 'fixture session quota exceeded',
    });

    persistence.fail = false;
    await finishAgentAction(action.id, 'success');
    await vi.advanceTimersByTimeAsync(101);
    expect(await getAgentRuntime()).toMatchObject({ persistence: 'persisted', pendingMutations: 0 });
  });
});
