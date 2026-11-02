import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeStatus, ExtensionState } from '@/types/models';
import { managedMITMRoutes, replaceManagedMITMRoutes, type ManagedMITMRoute } from './mitm-ingress-runtime';

const harness = vi.hoisted(() => ({
  state: {} as ExtensionState,
  status: {} as BridgeStatus,
  proxyStatus: {} as { activeProfileId?: string; followingStartup?: boolean },
  request: vi.fn(),
  commit: vi.fn(),
  credentials: vi.fn(() => false),
}));
vi.mock('wxt/browser', () => ({ browser: { storage: { session: { set: vi.fn(async () => undefined) } } } }));
vi.mock('@/platform/storage/state', () => ({ getState: vi.fn(async () => harness.state) }));
vi.mock('@/features/engine-bridge/service', () => ({ engineBridge: {
  getStatus: () => harness.status, requestEngine: harness.request,
} }));
vi.mock('./service', () => ({
  applyManagedMITMRoutes: harness.commit,
  getProxyStatus: vi.fn(async () => harness.proxyStatus),
  hasMITMProxyCredentials: harness.credentials,
}));

import { reconcileManagedMITMIngress } from './mitm-ingress';

const route = (): ManagedMITMRoute => ({ proxyHost: '127.0.0.1', proxyPort: 8083, host: '127.0.0.1', port: 18081,
  expiresAt: Date.now() + 90_000, instanceId: 'instance-A', engineIdentityId: 'engine' });

describe('Bridge MITM ingress reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    replaceManagedMITMRoutes([]);
    harness.state = {
      bridge: { managedInstance: { manager: 'ytray', instanceId: 'instance-A', badge: 'A' },
        pairedEngine: { engineIdentityId: 'engine' } },
      proxyProfiles: [{ id: 'yakit-mitm', name: 'Yakit MITM', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8083, bypass: [] }],
    } as unknown as ExtensionState;
    harness.status = { state: 'connected', message: '', connectionId: 'connection', capabilities: ['yakit.mitm.ingress'] };
    harness.proxyStatus = { activeProfileId: 'yakit-mitm' };
    harness.commit.mockImplementation(async (routes: ManagedMITMRoute[]) => replaceManagedMITMRoutes(routes));
    harness.request.mockResolvedValue({ available: true, host: '127.0.0.1', port: 18081, expiresAt: Date.now() + 90_000 });
    harness.credentials.mockReturnValue(false);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('acquires an ingress from the paired Bridge without sending a caller-selected identity', async () => {
    await reconcileManagedMITMIngress();
    expect(harness.request).toHaveBeenCalledWith('yakit.mitm.ingress', { proxyHost: '127.0.0.1', proxyPort: 8083 }, 5_000);
    expect(managedMITMRoutes()).toEqual([route()]);
  });

  it('supports the YTray launch proxy and leaves direct routing alone', async () => {
    harness.proxyStatus = { followingStartup: true };
    harness.state.startupProxy = 'http://127.0.0.1:8083';
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toHaveLength(1);
    harness.proxyStatus = { activeProfileId: 'direct' };
    harness.request.mockClear();
    await reconcileManagedMITMIngress();
    expect(harness.request).not.toHaveBeenCalled();
    expect(managedMITMRoutes()).toEqual([]);
  });

  it('keeps an unexpired route across a reconnect, then restores the base endpoint', async () => {
    replaceManagedMITMRoutes([route()]);
    harness.status = { state: 'connecting', message: '' };
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toHaveLength(1);
    vi.advanceTimersByTime(91_000);
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([]);
  });

  it('drops routes belonging to another engine or instance and supports older engines', async () => {
    replaceManagedMITMRoutes([{ ...route(), engineIdentityId: 'other-engine' }]);
    harness.status = { state: 'connecting', message: '' };
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([]);
    harness.status = { state: 'connected', message: '', capabilities: [] };
    await reconcileManagedMITMIngress();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('does not accept a remote or expired ingress and preserves existing proxy authentication', async () => {
    harness.request.mockResolvedValue({ available: true, host: 'example.com', port: 18081, expiresAt: Date.now() + 90_000 });
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([]);
    harness.request.mockResolvedValue({ available: true, host: '127.0.0.1', port: 18081, expiresAt: Date.now() - 1 });
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([]);
    harness.request.mockResolvedValue({ available: true, host: '127.0.0.1', port: 18081, expiresAt: Date.now() + 90_000, requiresProxyAuth: true });
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([]);
    harness.credentials.mockReturnValue(true);
    await reconcileManagedMITMIngress();
    expect(managedMITMRoutes()).toEqual([route()]);
  });

  it('leaves existing proxy profiles and authentication intact when an old engine lacks ingress support', async () => {
    harness.status = { state: 'connected', message: '', connectionId: 'old-engine' };
    harness.state.proxyProfiles[0] = { ...harness.state.proxyProfiles[0], authEnabled: true, authUsername: 'existing-user' };
    const original = structuredClone(harness.state);
    replaceManagedMITMRoutes([route()]);
    await reconcileManagedMITMIngress();
    expect(harness.request).not.toHaveBeenCalled();
    expect(managedMITMRoutes()).toEqual([]);
    expect(harness.state).toEqual(original);
  });

  it('clears runtime ingress on explicit browser-only mode while keeping the cached pairing', async () => {
    harness.state.bridge.launchTarget = { mode: 'none' };
    replaceManagedMITMRoutes([route()]);
    const pairing = structuredClone(harness.state.bridge.pairedEngine);
    await reconcileManagedMITMIngress();
    expect(harness.request).not.toHaveBeenCalled();
    expect(managedMITMRoutes()).toEqual([]);
    expect(harness.state.bridge.pairedEngine).toEqual(pairing);
  });

  it('ignores an old engine response after the connection changes', async () => {
    harness.request.mockImplementation(async () => {
      harness.status = { ...harness.status, connectionId: 'new-connection' };
      return { available: true, host: '127.0.0.1', port: 18081, expiresAt: Date.now() + 90_000 };
    });
    await reconcileManagedMITMIngress();
    expect(harness.commit).not.toHaveBeenCalled();
  });
});
