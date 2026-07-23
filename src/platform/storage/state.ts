import { browser } from 'wxt/browser';
import type { BridgeRuntimeSession, ExtensionState } from '@/types/models';
import {
  ACTIVE_SESSION_STORAGE_KEY, BRIDGE_SETTINGS_STORAGE_KEY, FLOATING_UI_STORAGE_KEY,
  PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY, BRIDGE_SESSION_STORAGE_KEY,
} from '@/protocol/storage';

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

let mutationQueue: Promise<void> = Promise.resolve();
const sessionStorage = (browser.storage as unknown as { session?: StorageArea }).session;

export const DEFAULT_STATE: ExtensionState = {
  version: 7,
  proxyProfiles: [
    { id: 'direct', name: '直接连接', kind: 'direct', bypass: [], builtin: true },
    { id: 'system', name: '系统代理', kind: 'system', bypass: [], builtin: true },
    {
      id: 'yakit-mitm', name: 'Yakit MITM', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8083,
      bypass: ['localhost', '127.0.0.1', '<local>'], builtin: true,
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
    transport: 'websocket', nativeHost: 'com.yaklang.browser_agent', endpoint: 'ws://127.0.0.1:64333/extension',
    autoConnect: false, installationId: crypto.randomUUID(),
  },
  floatingPanel: {
    enabled: true, side: 'right', y: 0.46, displayMode: 'always', siteMode: 'all', siteOrigins: [],
    shortcutEnabled: true, autoCollapseFullscreen: true,
  },
};

function defaultProfiles() {
  return DEFAULT_STATE.proxyProfiles.map((profile) => ({ ...profile, bypass: [...profile.bypass] }));
}

function normalizeState(value: Partial<ExtensionState>): ExtensionState {
  const profileMap = new Map(defaultProfiles().map((profile) => [profile.id, profile]));
  for (const profile of value.proxyProfiles || []) profileMap.set(profile.id, { ...profile, bypass: profile.bypass || [] });
  const proxyProfiles = [...profileMap.values()];
  const routableIds = new Set(proxyProfiles.filter((profile) => ['direct', 'fixed_servers'].includes(profile.kind)).map((profile) => profile.id));
  const proxyRouting = { ...DEFAULT_STATE.proxyRouting, ...value.proxyRouting };
  if (!routableIds.has(proxyRouting.defaultProfileId)) proxyRouting.defaultProfileId = 'direct';
  const proxyRules = (value.proxyRules || []).filter((rule) => (
    rule && typeof rule.id === 'string' && typeof rule.name === 'string' && typeof rule.enabled === 'boolean'
    && rule.condition && typeof rule.condition.type === 'string' && typeof rule.condition.value === 'string'
    && routableIds.has(rule.proxyProfileId)
  )).map((rule, order) => ({
    ...rule,
    order: Number.isSafeInteger(rule.order) ? rule.order : order,
    createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now(),
    updatedAt: Number.isFinite(rule.updatedAt) ? rule.updatedAt : Date.now(),
  }));
  const proxyRuleSources = (value.proxyRuleSources || []).filter((source) => (
    source && typeof source.id === 'string' && typeof source.url === 'string'
    && routableIds.has(source.matchProfileId) && routableIds.has(source.bypassProfileId)
  )).map((source, order) => ({
    ...source,
    order: Number.isSafeInteger(source.order) ? source.order : order,
    status: source.status || (source.revision ? 'ready' : 'idle'),
    totalRuleCount: source.totalRuleCount || 0,
    supportedRuleCount: source.supportedRuleCount || 0,
    ignoredRuleCount: source.ignoredRuleCount || 0,
    invalidRuleCount: source.invalidRuleCount || 0,
  }));
  return {
    ...DEFAULT_STATE,
    ...value,
    version: 7,
    proxyProfiles,
    proxyRules,
    proxyRuleSources,
    proxyRouting,
    proxyRuntime: { ...DEFAULT_STATE.proxyRuntime, ...value.proxyRuntime, warnings: value.proxyRuntime?.warnings || [] },
    activeProxyId: value.activeProxyId === 'auto' || proxyProfiles.some((profile) => profile.id === value.activeProxyId)
      ? value.activeProxyId!
      : 'direct',
    customUserAgentProfiles: value.customUserAgentProfiles || [],
    userAgentAssignments: value.userAgentAssignments || [],
    bridge: { ...DEFAULT_STATE.bridge, ...value.bridge },
    floatingPanel: {
      ...DEFAULT_STATE.floatingPanel, ...value.floatingPanel,
      siteOrigins: [...new Set(value.floatingPanel?.siteOrigins || [])].slice(0, 500),
    },
    activeGrant: value.activeGrant?.expiresAt && value.activeGrant.expiresAt > Date.now() ? value.activeGrant : undefined,
  };
}

export async function getState(): Promise<ExtensionState> {
  const localKeys = [PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY, BRIDGE_SETTINGS_STORAGE_KEY, FLOATING_UI_STORAGE_KEY];
  const sessionPromise: Promise<Record<string, unknown>> = sessionStorage?.get(ACTIVE_SESSION_STORAGE_KEY) || Promise.resolve({});
  const [local, session] = await Promise.all([
    browser.storage.local.get(localKeys),
    sessionPromise,
  ]);
  const state = normalizeState({
    ...(local[PROXY_SETTINGS_STORAGE_KEY] as Partial<ExtensionState> | undefined),
    ...(local[USER_AGENT_SETTINGS_STORAGE_KEY] as Partial<ExtensionState> | undefined),
    ...(local[BRIDGE_SETTINGS_STORAGE_KEY] as Partial<ExtensionState> | undefined),
    ...(local[FLOATING_UI_STORAGE_KEY] as Partial<ExtensionState> | undefined),
    ...(session[ACTIVE_SESSION_STORAGE_KEY] as Partial<ExtensionState> | undefined),
  });
  const storedBridge = local[BRIDGE_SETTINGS_STORAGE_KEY] as { bridge?: Partial<ExtensionState['bridge']> } | undefined;
  if (!storedBridge?.bridge?.installationId) {
    await browser.storage.local.set({
      [BRIDGE_SETTINGS_STORAGE_KEY]: { ...storedBridge, bridge: state.bridge },
    });
  }
  return state;
}

export async function getBridgeRuntimeSession(): Promise<BridgeRuntimeSession | undefined> {
  if (!sessionStorage) return undefined;
  const stored = (await sessionStorage.get(BRIDGE_SESSION_STORAGE_KEY))[BRIDGE_SESSION_STORAGE_KEY];
  if (!stored || typeof stored !== 'object') return undefined;
  const value = stored as Partial<BridgeRuntimeSession>;
  if (!value.sessionId || !value.engineInstanceId || typeof value.updatedAt !== 'number') return undefined;
  return value as BridgeRuntimeSession;
}

export async function setBridgeRuntimeSession(value: BridgeRuntimeSession): Promise<void> {
  await sessionStorage?.set({ [BRIDGE_SESSION_STORAGE_KEY]: value });
}

export async function setState(input: ExtensionState): Promise<ExtensionState> {
  const state = normalizeState(input);
  await Promise.all([
    browser.storage.local.set({
      [PROXY_SETTINGS_STORAGE_KEY]: {
        proxyProfiles: state.proxyProfiles, proxyRules: state.proxyRules,
        proxyRuleSources: state.proxyRuleSources, proxyRouting: state.proxyRouting,
        proxyRuntime: state.proxyRuntime, activeProxyId: state.activeProxyId,
      },
      [USER_AGENT_SETTINGS_STORAGE_KEY]: {
        customUserAgentProfiles: state.customUserAgentProfiles,
        userAgentAssignments: state.userAgentAssignments,
      },
      [BRIDGE_SETTINGS_STORAGE_KEY]: { bridge: state.bridge },
      [FLOATING_UI_STORAGE_KEY]: { floatingPanel: state.floatingPanel },
    }),
    sessionStorage?.set({
      [ACTIVE_SESSION_STORAGE_KEY]: { activeGrant: state.activeGrant, handoff: state.handoff },
    }) || Promise.resolve(),
  ]);
  return state;
}

export async function updateState(
  updater: (current: ExtensionState) => ExtensionState | Promise<ExtensionState>,
): Promise<ExtensionState> {
  let resolveResult!: (state: ExtensionState) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<ExtensionState>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      resolveResult(await setState(await updater(await getState())));
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}
