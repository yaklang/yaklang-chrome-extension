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
  BRIDGE_SESSION_STORAGE_KEY, PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY,
} from '@/protocol/storage';
import {
  DEFAULT_STATE, getBridgeRuntimeSession, getState, setState, updateState,
} from './state';

describe('split state storage', () => {
  it('writes durable domains to local and grant/handoff to session', async () => {
    const now = Date.now();
    await setState({
      ...structuredClone(DEFAULT_STATE),
      activeGrant: {
        id: 'grant-1', taskId: 'task-1', createdAt: now, expiresAt: now + 60_000,
        scopes: ['browser.tabs.read'],
        targets: [{
          tabId: 1,
          frameId: 0,
          isolationContextId: 'browser-profile:store-1',
          cookieStoreId: 'store-1',
          origin: 'https://example.test',
          grantedUrl: 'https://example.test/',
          title: 'Example',
        }],
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

  it('keeps only validated manager-owned browser instance identity', async () => {
    await setState({
      ...structuredClone(DEFAULT_STATE),
      bridge: {
        ...structuredClone(DEFAULT_STATE.bridge),
        managedInstance: { manager: 'ytray', instanceId: 'instance-1', badge: 'C' },
      },
    });
    expect((await getState()).bridge.managedInstance).toEqual({
      manager: 'ytray', instanceId: 'instance-1', badge: 'C',
    });

    stores.local[BRIDGE_SETTINGS_STORAGE_KEY] = {
      bridge: { ...structuredClone(DEFAULT_STATE.bridge), managedInstance: { manager: 'web', instanceId: '../bad', badge: '3' } },
    };
    expect((await getState()).bridge.managedInstance).toBeUndefined();
  });

  it('drops a session grant that is not bound to an isolation context', async () => {
    const now = Date.now();
    stores.session[ACTIVE_SESSION_STORAGE_KEY] = {
      activeGrant: {
        id: 'legacy-grant',
        taskId: 'legacy-task',
        createdAt: now,
        expiresAt: now + 60_000,
        scopes: ['browser.tabs.read'],
        targets: [{
          tabId: 1,
          frameId: 0,
          origin: 'https://example.test',
          grantedUrl: 'https://example.test/',
          title: 'Example',
        }],
      },
    };

    expect((await getState()).activeGrant).toBeUndefined();
  });

  it('preserves an expired but structurally valid grant for lifecycle cleanup', async () => {
    const now = Date.now();
    stores.session[ACTIVE_SESSION_STORAGE_KEY] = {
      activeGrant: {
        id: 'expired-grant',
        taskId: 'expired-task',
        createdAt: now - 120_000,
        expiresAt: now - 60_000,
        scopes: ['browser.tabs.read'],
        targets: [{
          tabId: 7,
          frameId: 0,
          documentId: 'document-7',
          isolationContextId: 'browser-profile:store-7',
          cookieStoreId: 'store-7',
          origin: 'https://expired.example',
          grantedUrl: 'https://expired.example/',
          title: 'Expired',
        }],
      },
    };

    expect((await getState()).activeGrant).toMatchObject({
      id: 'expired-grant',
      expiresAt: now - 60_000,
    });
  });

  it('repairs reserved proxy profiles and malformed proxy collections from durable storage', async () => {
    stores.local[PROXY_SETTINGS_STORAGE_KEY] = {
      proxyProfiles: [
        { id: 'direct', name: 'Hijacked', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 9000, bypass: [] },
        { id: 'auto', name: 'Sentinel collision', kind: 'direct', bypass: [] },
        { id: 'custom', name: 'Custom', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8080, bypass: [], builtin: true },
      ],
      proxyRules: null,
      proxyRuleSources: { invalid: true },
      proxyRouting: { defaultProfileId: 'missing', failMode: 'invalid' },
      activeProxyId: 'auto',
    };

    const state = await getState();
    expect(state.proxyProfiles.find((profile) => profile.id === 'direct')).toMatchObject({
      name: '直接连接', kind: 'direct', builtin: true,
    });
    expect(state.proxyProfiles.some((profile) => profile.id === 'auto')).toBe(false);
    expect(state.proxyProfiles.find((profile) => profile.id === 'custom')?.builtin).toBe(false);
    expect(state.proxyRules).toEqual([]);
    expect(state.proxyRuleSources).toEqual([]);
    expect(state.proxyRouting).toEqual({ defaultProfileId: 'direct', failMode: 'closed' });
  });

  it('repairs malformed User-Agent profiles, duplicate hosts and orphan assignments', async () => {
    stores.local[USER_AGENT_SETTINGS_STORAGE_KEY] = {
      customUserAgentProfiles: [
        { id: 'custom-valid', name: '  Valid  ', userAgent: '  Fixture-UA/1.0  ', category: 'desktop', builtin: true },
        { id: 'chrome-windows', name: 'Builtin collision', userAgent: 'Collision/1.0', category: 'custom', builtin: false },
        { id: 'custom-invalid', name: 'Invalid', userAgent: 'Bad\r\nHeader: value', category: 'custom', builtin: false },
      ],
      userAgentAssignments: [
        { id: 'old', hostname: 'APP.EXAMPLE.TEST', profileId: 'custom-valid', createdAt: 1, updatedAt: 2 },
        { id: 'latest', hostname: 'app.example.test', profileId: 'safari-iphone', createdAt: 1, updatedAt: 3 },
        { id: 'orphan', hostname: 'orphan.example.test', profileId: 'missing', createdAt: 1, updatedAt: 2 },
      ],
    };

    const state = await getState();
    expect(state.customUserAgentProfiles).toEqual([{
      id: 'custom-valid',
      name: 'Valid',
      userAgent: 'Fixture-UA/1.0',
      category: 'custom',
      builtin: false,
    }]);
    expect(state.userAgentAssignments).toEqual([{
      id: 'latest',
      hostname: 'app.example.test',
      profileId: 'safari-iphone',
      createdAt: 1,
      updatedAt: 3,
    }]);
  });

  it('drops a corrupted resumable Bridge session after a Service Worker restart', async () => {
    stores.session[BRIDGE_SESSION_STORAGE_KEY] = {
      sessionId: 42,
      engineInstanceId: 'engine-1',
      taskId: { invalid: true },
      updatedAt: Number.NaN,
    };

    await expect(getBridgeRuntimeSession()).resolves.toBeUndefined();
  });

  it('restores only bounded typed fields from a resumable Bridge session', async () => {
    stores.session[BRIDGE_SESSION_STORAGE_KEY] = {
      sessionId: 's'.repeat(700),
      engineInstanceId: 'engine-1',
      engineIdentityId: 'identity-1',
      taskId: 'task-1',
      grantId: 'grant-1',
      updatedAt: Date.now(),
      ignoredLegacyField: true,
    };

    await expect(getBridgeRuntimeSession()).resolves.toMatchObject({
      sessionId: 's'.repeat(500),
      engineInstanceId: 'engine-1',
      engineIdentityId: 'identity-1',
      taskId: 'task-1',
      grantId: 'grant-1',
    });
  });
});
