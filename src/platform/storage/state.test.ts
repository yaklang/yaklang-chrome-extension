import { vi, describe, expect, it } from 'vitest';

const stores = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
}));

function area(data: Record<string, unknown>) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(items: Record<string, unknown>) { Object.assign(data, structuredClone(items)); },
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: area(stores.local), session: area(stores.session) },
  },
}));

import {
  ACTIVE_SESSION_STORAGE_KEY, BRIDGE_SETTINGS_STORAGE_KEY, FLOATING_UI_STORAGE_KEY,
  PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY,
} from '@/protocol/storage';
import { DEFAULT_STATE, getState, setState, updateState } from './state';

describe('split state storage', () => {
  it('writes durable domains to local and grant/handoff to session', async () => {
    const now = Date.now();
    await setState({
      ...structuredClone(DEFAULT_STATE),
      activeGrant: {
        id: 'grant-1', taskId: 'task-1', createdAt: now, expiresAt: now + 60_000,
        scopes: ['browser.tabs.read'],
        targets: [{ tabId: 1, frameId: 0, origin: 'https://example.test', grantedUrl: 'https://example.test/', title: 'Example' }],
      },
    });
    expect(Object.keys(stores.local)).toEqual(expect.arrayContaining([
      PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY, BRIDGE_SETTINGS_STORAGE_KEY, FLOATING_UI_STORAGE_KEY,
    ]));
    expect(stores.local).not.toHaveProperty('yakit-extension-state-v5');
    expect(stores.session).toHaveProperty(ACTIVE_SESSION_STORAGE_KEY);
    expect((await getState()).activeGrant?.taskId).toBe('task-1');
  });

  it('serializes concurrent cross-domain updates without losing either write', async () => {
    await setState(structuredClone(DEFAULT_STATE));
    await Promise.all([
      updateState((state) => ({ ...state, activeProxyId: 'yakit-mitm' })),
      updateState((state) => ({ ...state, floatingPanel: { ...state.floatingPanel, side: 'left' } })),
    ]);
    const state = await getState();
    expect(state.activeProxyId).toBe('yakit-mitm');
    expect(state.floatingPanel.side).toBe('left');
  });
});
