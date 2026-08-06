import { browser } from 'wxt/browser';
import type {
  BridgeGrant, BridgeGrantTarget, BridgeRuntimeSession, CapabilityScope, ExtensionState,
  ProxyConditionType, ProxyProfile,
} from '@/types/models';
import {
  ACTIVE_SESSION_STORAGE_KEY, BRIDGE_SETTINGS_STORAGE_KEY, FLOATING_UI_STORAGE_KEY,
  PROXY_SETTINGS_STORAGE_KEY, USER_AGENT_SETTINGS_STORAGE_KEY, BRIDGE_SESSION_STORAGE_KEY,
} from '@/protocol/storage';
import { normalizeStoredUserAgentState } from '@/shared/user-agent-state';

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

const PROXY_KINDS = new Set<ProxyProfile['kind']>(['direct', 'system', 'fixed_servers', 'pac_script']);
const PROXY_SCHEMES = new Set(['http', 'https', 'socks4', 'socks5']);
const PROXY_CONDITION_TYPES = new Set<ProxyConditionType>([
  'host_exact', 'host_suffix', 'host_wildcard', 'host_regex',
  'url_prefix', 'url_wildcard', 'url_regex', 'keyword',
]);

function normalizeGrantTarget(input: unknown): BridgeGrantTarget | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Partial<BridgeGrantTarget>;
  if (
    !Number.isSafeInteger(value.tabId) || value.tabId! < 1
    || !Number.isSafeInteger(value.frameId) || value.frameId! < 0
    || typeof value.isolationContextId !== 'string' || !value.isolationContextId
    || typeof value.origin !== 'string' || !/^https?:\/\//i.test(value.origin)
    || typeof value.grantedUrl !== 'string'
    || typeof value.title !== 'string'
    || (value.documentId !== undefined && typeof value.documentId !== 'string')
    || (value.cookieStoreId !== undefined && typeof value.cookieStoreId !== 'string')
  ) return undefined;
  return value as BridgeGrantTarget;
}

function normalizeActiveGrant(input: unknown): BridgeGrant | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Partial<BridgeGrant>;
  if (
    typeof value.id !== 'string' || !value.id
    || typeof value.taskId !== 'string' || !value.taskId
    || !Number.isFinite(value.createdAt)
    || !Number.isFinite(value.expiresAt)
    || value.expiresAt! <= value.createdAt!
    || !Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 64
    || !Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > 128
    || value.scopes.some((scope) => typeof scope !== 'string' || !scope)
  ) return undefined;
  const targets = value.targets.map(normalizeGrantTarget);
  if (targets.some((target) => !target)) return undefined;
  return {
    id: value.id,
    taskId: value.taskId,
    createdAt: value.createdAt!,
    expiresAt: value.expiresAt!,
    targets: targets as BridgeGrantTarget[],
    scopes: [...new Set(value.scopes)] as CapabilityScope[],
  };
}

function normalizeState(value: Partial<ExtensionState>): ExtensionState {
  const profileMap = new Map(defaultProfiles().map((profile) => [profile.id, profile]));
  const storedProfiles = Array.isArray(value.proxyProfiles) ? value.proxyProfiles.slice(0, 500) : [];
  for (const profile of storedProfiles) {
    if (!profile || typeof profile.id !== 'string' || !profile.id || profile.id === 'auto'
      || typeof profile.name !== 'string' || !profile.name.trim() || !PROXY_KINDS.has(profile.kind)) continue;
    if (profile.id === 'direct' || profile.id === 'system') continue;
    if (profile.id === 'yakit-mitm' && profile.kind !== 'fixed_servers') continue;
    if (profile.kind === 'fixed_servers' && (
      typeof profile.host !== 'string' || !profile.host.trim()
      || !Number.isSafeInteger(profile.port) || profile.port! < 1 || profile.port! > 65_535
      || !profile.scheme || !PROXY_SCHEMES.has(profile.scheme)
    )) continue;
    if (profile.kind === 'pac_script' && !profile.pacUrl?.trim() && !profile.pacScript?.trim()) continue;
    profileMap.set(profile.id, {
      ...profile,
      name: profile.name.trim(),
      bypass: Array.isArray(profile.bypass) ? profile.bypass.filter((item) => typeof item === 'string').slice(0, 500) : [],
      builtin: profile.id === 'yakit-mitm',
    });
  }
  const proxyProfiles = [...profileMap.values()];
  const routableIds = new Set(proxyProfiles.filter((profile) => ['direct', 'fixed_servers'].includes(profile.kind)).map((profile) => profile.id));
  const proxyRouting = {
    ...DEFAULT_STATE.proxyRouting,
    ...(value.proxyRouting && typeof value.proxyRouting === 'object' ? value.proxyRouting : {}),
  };
  if (!routableIds.has(proxyRouting.defaultProfileId)) proxyRouting.defaultProfileId = 'direct';
  if (proxyRouting.failMode !== 'open' && proxyRouting.failMode !== 'closed') proxyRouting.failMode = 'closed';
  const storedRules = Array.isArray(value.proxyRules) ? value.proxyRules.slice(0, 5_000) : [];
  const proxyRules = storedRules.filter((rule) => (
    rule && typeof rule.id === 'string' && typeof rule.name === 'string' && typeof rule.enabled === 'boolean'
    && rule.condition && PROXY_CONDITION_TYPES.has(rule.condition.type) && typeof rule.condition.value === 'string'
    && rule.condition.value.trim().length > 0
    && routableIds.has(rule.proxyProfileId)
  )).map((rule, order) => ({
    ...rule,
    order: Number.isSafeInteger(rule.order) ? rule.order : order,
    createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now(),
    updatedAt: Number.isFinite(rule.updatedAt) ? rule.updatedAt : Date.now(),
  }));
  const storedSources = Array.isArray(value.proxyRuleSources) ? value.proxyRuleSources.slice(0, 200) : [];
  const proxyRuleSources = storedSources.filter((source) => (
    source && typeof source.id === 'string' && typeof source.name === 'string' && typeof source.url === 'string'
    && typeof source.enabled === 'boolean' && ['auto', 'autoproxy', 'switchyomega', 'hosts'].includes(source.format)
    && Number.isSafeInteger(source.updateIntervalMinutes)
    && source.updateIntervalMinutes >= 15 && source.updateIntervalMinutes <= 43_200
    && routableIds.has(source.matchProfileId) && routableIds.has(source.bypassProfileId)
  )).map((source, order) => ({
    ...source,
    order: Number.isSafeInteger(source.order) ? source.order : order,
    status: source.status || (source.revision ? 'ready' : 'idle'),
    totalRuleCount: Number.isSafeInteger(source.totalRuleCount) && source.totalRuleCount >= 0 ? source.totalRuleCount : 0,
    supportedRuleCount: Number.isSafeInteger(source.supportedRuleCount) && source.supportedRuleCount >= 0 ? source.supportedRuleCount : 0,
    ignoredRuleCount: Number.isSafeInteger(source.ignoredRuleCount) && source.ignoredRuleCount >= 0 ? source.ignoredRuleCount : 0,
    invalidRuleCount: Number.isSafeInteger(source.invalidRuleCount) && source.invalidRuleCount >= 0 ? source.invalidRuleCount : 0,
  }));
  const userAgentState = normalizeStoredUserAgentState(
    value.customUserAgentProfiles,
    value.userAgentAssignments,
  );
  return {
    ...DEFAULT_STATE,
    ...value,
    version: 7,
    proxyProfiles,
    proxyRules,
    proxyRuleSources,
    proxyRouting,
    proxyRuntime: {
      ...DEFAULT_STATE.proxyRuntime,
      ...(value.proxyRuntime && typeof value.proxyRuntime === 'object' ? value.proxyRuntime : {}),
      warnings: Array.isArray(value.proxyRuntime?.warnings) ? value.proxyRuntime.warnings.slice(0, 100) : [],
    },
    activeProxyId: value.activeProxyId === 'auto' || proxyProfiles.some((profile) => profile.id === value.activeProxyId)
      ? value.activeProxyId!
      : 'direct',
    customUserAgentProfiles: userAgentState.customUserAgentProfiles,
    userAgentAssignments: userAgentState.userAgentAssignments,
    bridge: { ...DEFAULT_STATE.bridge, ...value.bridge },
    floatingPanel: {
      ...DEFAULT_STATE.floatingPanel, ...value.floatingPanel,
      siteOrigins: [...new Set(value.floatingPanel?.siteOrigins || [])].slice(0, 500),
    },
    // Expired grants remain visible to the lifecycle manager so it can release
    // grant-owned debugger, recorder and network resources after a worker restart.
    activeGrant: normalizeActiveGrant(value.activeGrant),
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
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const value = stored as Partial<BridgeRuntimeSession>;
  if (typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.engineInstanceId !== 'string' || !value.engineInstanceId
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
    || (value.engineIdentityId !== undefined && typeof value.engineIdentityId !== 'string')
    || (value.taskId !== undefined && typeof value.taskId !== 'string')
    || (value.grantId !== undefined && typeof value.grantId !== 'string')) return undefined;
  return {
    sessionId: value.sessionId.slice(0, 500),
    engineInstanceId: value.engineInstanceId.slice(0, 500),
    engineIdentityId: value.engineIdentityId?.slice(0, 500),
    taskId: value.taskId?.slice(0, 240),
    grantId: value.grantId?.slice(0, 240),
    updatedAt: value.updatedAt,
  };
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
