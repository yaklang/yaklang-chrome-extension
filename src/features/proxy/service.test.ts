import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtensionState, NormalizedProxyRule, ProxyConfiguration, ProxyRuleSource,
} from '@/types/models';

const harness = vi.hoisted(() => ({
  state: undefined as ExtensionState | undefined,
  sourceRules: new Map<string, NormalizedProxyRule[]>(),
  proxySet: vi.fn(async (_details: unknown) => undefined),
  proxyGet: vi.fn(async (_details: unknown) => ({
    value: { mode: 'direct' }, levelOfControl: 'controllable_by_this_extension',
  })),
  sessionGet: vi.fn(async () => ({})),
  sessionSet: vi.fn(async () => undefined),
  putCompiledArtifact: vi.fn(async () => undefined),
  putSourceRevision: vi.fn(async () => undefined),
  pruneSourceRevisions: vi.fn(async () => undefined),
  deleteSource: vi.fn(async () => undefined),
  authListener: undefined as unknown as (
    details: { isProxy: boolean; challenger?: { host: string; port: number } },
    callback?: (response: unknown) => void,
  ) => unknown,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    proxy: { settings: { get: harness.proxyGet, set: harness.proxySet } },
    storage: {
      session: { get: harness.sessionGet, set: harness.sessionSet },
      onChanged: { addListener: vi.fn() },
    },
    webRequest: {
      onAuthRequired: {
        addListener: vi.fn((listener) => { harness.authListener = listener; }),
      },
    },
    alarms: { create: vi.fn(async () => undefined), onAlarm: { addListener: vi.fn() } },
  },
}));

vi.mock('@/platform/storage/state', () => ({
  getState: vi.fn(async () => harness.state as ExtensionState),
  updateState: vi.fn(async (updater: (state: ExtensionState) => ExtensionState | Promise<ExtensionState>) => {
    harness.state = await updater(harness.state as ExtensionState);
    return harness.state;
  }),
}));

vi.mock('./repository', () => ({
  deleteSource: harness.deleteSource,
  getCompiledArtifact: vi.fn(async () => undefined),
  getSourceContent: vi.fn(async () => undefined),
  getSourceRulePage: vi.fn(async () => ({ sourceId: 'source', offset: 0, limit: 100, total: 0, rules: [] })),
  getSourceRules: vi.fn(async (sourceId: string) => harness.sourceRules.get(sourceId) || []),
  pruneSourceRevisions: harness.pruneSourceRevisions,
  putCompiledArtifact: harness.putCompiledArtifact,
  putSourceRevision: harness.putSourceRevision,
}));

import {
  applyProxyRules, importProxyConfiguration, refreshProxyRuleSource, removeProxyProfile,
  routeCurrentSite, saveProxyProfile, saveProxyRuleSource, setProxyAuthPassword, switchProxy,
} from './service';

function baseState(): ExtensionState {
  return {
    version: 7,
    proxyProfiles: [
      { id: 'direct', name: '直接连接', kind: 'direct', bypass: [], builtin: true },
      { id: 'system', name: '系统代理', kind: 'system', bypass: [], builtin: true },
      {
        id: 'yakit-mitm', name: 'Yakit MITM', kind: 'fixed_servers', scheme: 'http',
        host: '127.0.0.1', port: 8083, bypass: [], builtin: true,
      },
      {
        id: 'custom', name: 'Custom', kind: 'fixed_servers', scheme: 'http',
        host: '127.0.0.1', port: 2080, bypass: [],
      },
    ],
    proxyRules: [],
    proxyRuleSources: [],
    proxyRouting: { defaultProfileId: 'direct', failMode: 'closed' },
    proxyRuntime: { dirty: false, compiledBytes: 0, manualRuleCount: 0, sourceRuleCount: 0, warnings: [] },
    activeProxyId: 'direct',
    customUserAgentProfiles: [],
    userAgentAssignments: [],
    bridge: {
      transport: 'websocket', nativeHost: 'host', endpoint: 'ws://127.0.0.1:64333/extension',
      autoConnect: false, installationId: 'installation',
    },
    floatingPanel: {
      enabled: true, side: 'right', y: 0.5, displayMode: 'always', siteMode: 'all', siteOrigins: [],
      shortcutEnabled: true, autoCollapseFullscreen: true,
    },
  };
}

function source(overrides: Partial<ProxyRuleSource> = {}): ProxyRuleSource {
  return {
    id: 'source', name: 'Source', url: 'https://example.test/rules.txt', format: 'switchyomega',
    enabled: true, matchProfileId: 'yakit-mitm', bypassProfileId: 'direct', order: 0,
    updateIntervalMinutes: 720, status: 'ready', totalRuleCount: 0, supportedRuleCount: 0,
    ignoredRuleCount: 0, invalidRuleCount: 0, ...overrides,
  };
}

function configuration(sourceExport?: ProxyConfiguration['sources'][number]): ProxyConfiguration {
  return {
    version: 2,
    profiles: baseState().proxyProfiles,
    rules: [],
    sources: sourceExport ? [sourceExport] : [],
    routing: { defaultProfileId: 'direct', failMode: 'closed' },
  };
}

describe('proxy service', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    harness.state = baseState();
    harness.sourceRules.clear();
    vi.clearAllMocks();
    harness.proxySet.mockResolvedValue(undefined);
    harness.proxyGet.mockResolvedValue({
      value: { mode: 'direct' }, levelOfControl: 'controllable_by_this_extension',
    });
  });

  it('applies automatic routing and commits the exact PAC revision', async () => {
    const rules: NormalizedProxyRule[] = Array.from({ length: 2_000 }, (_, ordinal) => ({
      sourceId: 'source', ordinal, condition: { type: 'host_wildcard', value: `*.d${ordinal}.example` },
      exception: false, raw: `*.d${ordinal}.example`,
    }));
    harness.sourceRules.set('source', rules);
    harness.state = {
      ...baseState(),
      proxyRuleSources: [source({ revision: 'source-revision', supportedRuleCount: rules.length })],
      proxyRuntime: { ...baseState().proxyRuntime, dirty: true },
    };

    const applied = await applyProxyRules();
    expect(applied.activeProxyId).toBe('auto');
    expect(applied.proxyRuntime).toMatchObject({ dirty: false, sourceRuleCount: 2_000 });
    expect(applied.proxyRuntime.revision).toBeTruthy();
    expect(harness.proxySet).toHaveBeenCalledOnce();
    const browserValue = harness.proxySet.mock.calls[0][0] as { value: { mode: string; pacScript: { data: string } } };
    expect(browserValue.value.mode).toBe('pac_script');
    expect(browserValue.value.pacScript.data).toContain('JSON.parse');
  });

  it('keeps the previous mode and records a recoverable error when browser application fails', async () => {
    harness.proxySet.mockRejectedValueOnce(new Error('proxy setting is controlled by another extension'));
    harness.state = { ...baseState(), proxyRuntime: { ...baseState().proxyRuntime, dirty: true } };

    await expect(applyProxyRules()).rejects.toThrow('controlled by another extension');
    expect(harness.state?.activeProxyId).toBe('direct');
    expect(harness.state?.proxyRuntime).toMatchObject({
      dirty: true,
      error: 'proxy setting is controlled by another extension',
    });
  });

  it('reports another proxy extension as the controller before changing browser settings', async () => {
    harness.proxyGet.mockResolvedValueOnce({
      value: { mode: 'pac_script' }, levelOfControl: 'controlled_by_other_extensions',
    });
    harness.state = { ...baseState(), proxyRuntime: { ...baseState().proxyRuntime, dirty: true } };

    await expect(applyProxyRules()).rejects.toThrow('其他扩展控制');
    expect(harness.proxySet).not.toHaveBeenCalled();
    expect(harness.state?.proxyRuntime.error).toContain('其他扩展控制');
  });

  it('serializes direct profile switches through the state mutation and browser setting operation', async () => {
    const switched = await switchProxy('custom');
    expect(switched.activeProxyId).toBe('custom');
    expect(harness.proxySet).toHaveBeenCalledWith(expect.objectContaining({
      value: expect.objectContaining({ mode: 'fixed_servers' }),
      scope: 'regular',
    }));
  });

  it('provides matching proxy credentials from session memory only for proxy challenges', async () => {
    harness.state = {
      ...baseState(),
      proxyProfiles: baseState().proxyProfiles.map((profile) => profile.id === 'custom'
        ? { ...profile, authEnabled: true, authUsername: 'tester' }
        : profile),
    };
    await setProxyAuthPassword('custom', 'session-secret');
    const response = await new Promise<unknown>((resolve) => {
      harness.authListener({
        isProxy: true,
        challenger: { host: '127.0.0.1', port: 2080 },
      }, resolve);
    });
    expect(response).toEqual({
      authCredentials: { username: 'tester', password: 'session-secret' },
    });
    const originResponse = await new Promise<unknown>((resolve) => {
      harness.authListener({
        isProxy: false,
        challenger: { host: '127.0.0.1', port: 2080 },
      }, resolve);
    });
    expect(originResponse).toEqual({});
    await setProxyAuthPassword('custom', '');
  });

  it('protects reserved profile identities and referenced custom profiles', async () => {
    await expect(saveProxyProfile({
      id: 'direct', name: 'Hijacked', kind: 'fixed_servers', scheme: 'http',
      host: '127.0.0.1', port: 9000, bypass: [],
    })).rejects.toThrow('类型不能修改');
    harness.state = {
      ...baseState(),
      proxyRules: [{
        id: 'rule', name: 'Rule', enabled: true, condition: { type: 'host_exact', value: 'example.test' },
        proxyProfileId: 'custom', order: 0, createdAt: 1, updatedAt: 1,
      }],
    };
    await expect(removeProxyProfile('custom')).rejects.toThrow('仍被自动切换规则引用');
  });

  it('rebuilds imported source metadata from content instead of trusting exported revision fields', async () => {
    const imported = await importProxyConfiguration(configuration({
      source: source({ revision: 'forged-revision', supportedRuleCount: 999_999 }),
      content: '[SwitchyOmega Conditions]\n*.example.test\n',
    }));

    expect(imported.activeProxyId).toBe('direct');
    expect(imported.proxyRuleSources[0]).toMatchObject({ status: 'ready', supportedRuleCount: 1 });
    expect(imported.proxyRuleSources[0].revision).not.toBe('forged-revision');
    expect(harness.putSourceRevision).toHaveBeenCalledWith(
      'source', imported.proxyRuleSources[0].revision, expect.any(String), expect.any(Array),
    );
  });

  it('makes a source without embedded content explicitly idle instead of retaining a dangling revision', async () => {
    const imported = await importProxyConfiguration(configuration({
      source: source({ revision: 'missing-revision', supportedRuleCount: 50_000 }),
    }));
    expect(imported.proxyRuleSources[0]).toMatchObject({
      status: 'idle', supportedRuleCount: 0, totalRuleCount: 0,
    });
    expect(imported.proxyRuleSources[0].revision).toBeUndefined();
  });

  it('rejects a non-routable system or external PAC profile as an automatic default', async () => {
    const imported = configuration();
    imported.routing.defaultProfileId = 'system';
    await expect(importProxyConfiguration(imported)).rejects.toThrow('默认出口必须是直接连接或固定代理');
  });

  it('reapplies dirty active routing after a subscription returns HTTP 304', async () => {
    const rules: NormalizedProxyRule[] = [{
      sourceId: 'source', ordinal: 0, condition: { type: 'host_suffix', value: 'example.test' },
      exception: false, raw: '*.example.test',
    }];
    harness.sourceRules.set('source', rules);
    harness.state = {
      ...baseState(),
      activeProxyId: 'auto',
      proxyRuleSources: [source({ revision: 'revision', supportedRuleCount: 1, etag: 'etag' })],
      proxyRuntime: { ...baseState().proxyRuntime, dirty: true },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })));

    const refreshed = await refreshProxyRuleSource('source');
    expect(refreshed.proxyRuntime.dirty).toBe(false);
    expect(refreshed.activeProxyId).toBe('auto');
    expect(harness.proxySet).toHaveBeenCalledOnce();
  });

  it('honors an explicit apply request that joins an in-flight background source refresh', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.fn(() => pendingFetch);
    vi.stubGlobal('fetch', fetchMock);
    harness.state = {
      ...baseState(),
      activeProxyId: 'auto',
      proxyRuleSources: [source({ revision: 'revision', supportedRuleCount: 1, etag: 'etag' })],
      proxyRuntime: { ...baseState().proxyRuntime, dirty: true },
    };
    harness.sourceRules.set('source', [{
      sourceId: 'source', ordinal: 0, condition: { type: 'host_suffix', value: 'example.test' },
      exception: false, raw: '*.example.test',
    }]);

    const backgroundRefresh = refreshProxyRuleSource('source', false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const explicitRefresh = refreshProxyRuleSource('source', true);
    resolveFetch(new Response(null, { status: 304 }));

    await backgroundRefresh;
    const refreshed = await explicitRefresh;
    expect(refreshed.activeProxyId).toBe('auto');
    expect(refreshed.proxyRuntime.dirty).toBe(false);
    expect(harness.proxySet).toHaveBeenCalledOnce();
  });

  it('creates and immediately applies a current-site route', async () => {
    const routed = await routeCurrentSite('https://api.example.test/path', 'custom');
    expect(routed.activeProxyId).toBe('auto');
    expect(routed.proxyRules[0]).toMatchObject({
      condition: { type: 'host_exact', value: 'api.example.test' },
      proxyProfileId: 'custom', order: 0,
    });
    expect(routed.proxyRuntime.dirty).toBe(false);
    expect(harness.proxySet).toHaveBeenCalledOnce();
  });

  it('preserves settings edited while a subscription download is in flight', async () => {
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.fn(() => pendingFetch);
    vi.stubGlobal('fetch', fetchMock);
    harness.state = {
      ...baseState(),
      proxyRuleSources: [source({ revision: 'old-revision' })],
    };

    const refreshing = refreshProxyRuleSource('source');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await saveProxyRuleSource({
      id: 'source', name: 'Edited while downloading', url: 'https://example.test/rules.txt',
      format: 'switchyomega', enabled: false, matchProfileId: 'direct', bypassProfileId: 'yakit-mitm',
      order: 0, updateIntervalMinutes: 60,
    });
    resolveFetch(new Response('[SwitchyOmega Conditions]\n*.example.test\n', {
      status: 200,
      headers: { etag: 'new-etag' },
    }));
    const refreshed = await refreshing;
    expect(refreshed.proxyRuleSources[0]).toMatchObject({
      name: 'Edited while downloading', enabled: false, matchProfileId: 'direct',
      bypassProfileId: 'yakit-mitm', updateIntervalMinutes: 60, etag: 'new-etag', status: 'ready',
    });
  });
});
