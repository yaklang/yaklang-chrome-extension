import { browser } from 'wxt/browser';
import { isStateStorageChange, PROXY_AUTH_STORAGE_KEY } from '@/protocol/storage';
import type {
  ExtensionState, ProxyConfiguration, ProxyProfile, ProxyRule, ProxyRulePage, ProxyRulePreview,
  ProxyRuleSource, ProxyRuleSourceExport, ProxyRuleSourceInput,
} from '@/types/models';
import { getState, updateState } from '@/platform/storage/state';
import {
  compileProxyRules, previewProxyRules, profileToPac, proxyCompilationRevision,
  sortedProxyRules,
  type CompiledProxyArtifact, type ProxyCompilationInput,
} from './compiler';
import { hashText } from './hash';
import { parseProxyRuleSource } from './parser';
import {
  deleteSource, getCompiledArtifact, getSourceContent, getSourceRulePage, getSourceRules,
  pruneSourceRevisions, putCompiledArtifact, putSourceRevision,
} from './repository';

const SOURCE_REFRESH_ALARM = 'proxy-rule-sources-refresh';
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURATION_CONTENT_BYTES = 25 * 1024 * 1024;
const RESERVED_PROXY_PROFILE_IDS = new Set(['auto', 'direct', 'system', 'yakit-mitm']);

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const sessionStorage = (browser.storage as unknown as { session?: StorageArea }).session;
const authPasswords = new Map<string, string>();
const sourceRefreshes = new Map<string, { identity: string; promise: Promise<ExtensionState> }>();
let proxyState: ExtensionState | undefined;

function isFirefox(): boolean {
  return Boolean(import.meta.env.FIREFOX);
}

function isRoutable(profile: ProxyProfile): boolean {
  return profile.kind === 'direct' || profile.kind === 'fixed_servers';
}

function canonicalProxyProfile(profile: ProxyProfile): ProxyProfile {
  const name = profile.name.trim();
  if (profile.id === 'auto') throw new Error('auto 是自动切换模式标识，不能作为代理出口 ID');
  if (profile.id === 'direct') {
    if (profile.kind !== 'direct') throw new Error('内置“直接连接”出口的类型不能修改');
    return { id: 'direct', name: '直接连接', kind: 'direct', bypass: [], builtin: true };
  }
  if (profile.id === 'system') {
    if (profile.kind !== 'system') throw new Error('内置“系统代理”出口的类型不能修改');
    return { id: 'system', name: '系统代理', kind: 'system', bypass: [], builtin: true };
  }
  if (profile.id === 'yakit-mitm') {
    if (profile.kind !== 'fixed_servers') throw new Error('内置“Yakit MITM”出口必须保持为固定代理');
    return { ...profile, name: name || 'Yakit MITM', builtin: true };
  }
  if (RESERVED_PROXY_PROFILE_IDS.has(profile.id)) throw new Error(`代理出口 ID 已被系统保留：${profile.id}`);
  return { ...profile, name, builtin: false };
}

function assertUniqueProfileName(profile: ProxyProfile, profiles: ProxyProfile[]): void {
  const normalizedName = profile.name.trim().toLocaleLowerCase();
  if (profiles.some((item) => item.id !== profile.id && item.name.trim().toLocaleLowerCase() === normalizedName)) {
    throw new Error(`代理出口名称不能重复：${profile.name}`);
  }
}

function assertUniqueIds(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}包含重复 ID`);
}

function chromeProxyValue(profile: ProxyProfile): object {
  if (profile.kind === 'direct') return { mode: 'direct' };
  if (profile.kind === 'system') return { mode: 'system' };
  if (profile.kind === 'pac_script') {
    return {
      mode: 'pac_script',
      pacScript: profile.pacScript
        ? { data: profile.pacScript, mandatory: true }
        : { url: profile.pacUrl, mandatory: true },
    };
  }
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: profile.scheme || 'http',
        host: profile.host || '127.0.0.1',
        port: profile.port || 8083,
      },
      bypassList: profile.bypass,
    },
  };
}

function firefoxProxyValue(profile: ProxyProfile): object {
  if (profile.kind === 'direct') return { proxyType: 'none' };
  if (profile.kind === 'system') return { proxyType: 'system' };
  if (profile.kind === 'pac_script') {
    return profile.pacUrl
      ? { proxyType: 'autoConfig', autoConfigUrl: profile.pacUrl }
      : { proxyType: 'autoConfig', autoConfigUrl: `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(profile.pacScript || '')}` };
  }
  if (profile.scheme === 'socks4' || profile.scheme === 'socks5') {
    return {
      proxyType: 'manual', socks: `${profile.host}:${profile.port}`, socksVersion: profile.scheme === 'socks4' ? 4 : 5,
      proxyDNS: true, passthrough: profile.bypass.join(', '),
    };
  }
  const address = `${profile.scheme || 'http'}://${profile.host}:${profile.port}`;
  return { proxyType: 'manual', http: address, ssl: address, httpProxyAll: true, passthrough: profile.bypass.join(', ') };
}

async function assertProxyControl(): Promise<void> {
  if (!browser.proxy?.settings) throw new Error('当前浏览器不支持代理 API');
  const current = await browser.proxy.settings.get({ incognito: false });
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    throw new Error('浏览器代理正由其他扩展控制，请先停用其他代理扩展后重试');
  }
  if (current.levelOfControl === 'not_controllable') {
    throw new Error('浏览器代理受系统策略或启动参数控制，当前扩展无法修改');
  }
}

async function setPacScript(pacScript: string): Promise<void> {
  await assertProxyControl();
  if (isFirefox()) {
    await browser.proxy.settings.set({
      value: { proxyType: 'autoConfig', autoConfigUrl: `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(pacScript)}` } as unknown as Browser.proxy.ProxyConfig,
      scope: 'regular',
    });
    return;
  }
  await browser.proxy.settings.set({
    value: { mode: 'pac_script', pacScript: { data: pacScript, mandatory: true } },
    scope: 'regular',
  });
}

async function setBrowserProxyProfile(profile: ProxyProfile): Promise<void> {
  await assertProxyControl();
  const value = isFirefox() ? firefoxProxyValue(profile) : chromeProxyValue(profile);
  await browser.proxy.settings.set({ value: value as Browser.proxy.ProxyConfig, scope: 'regular' });
}

async function compilationInput(state: ExtensionState, withRules = true): Promise<ProxyCompilationInput> {
  const sourceRules = new Map<string, Awaited<ReturnType<typeof getSourceRules>>>();
  if (withRules) {
    await Promise.all(state.proxyRuleSources.filter((source) => source.enabled && source.revision).map(async (source) => {
      sourceRules.set(source.id, await getSourceRules(source.id, source.revision));
    }));
  }
  return {
    manualRules: state.proxyRules,
    sources: state.proxyRuleSources,
    sourceRules,
    profiles: state.proxyProfiles,
    routing: state.proxyRouting,
  };
}

async function compiledArtifact(state: ExtensionState): Promise<CompiledProxyArtifact> {
  const shallowInput = await compilationInput(state, false);
  const revision = proxyCompilationRevision(shallowInput);
  const cached = await getCompiledArtifact(revision);
  if (cached) return cached;
  const artifact = compileProxyRules(await compilationInput(state, true));
  await putCompiledArtifact({ ...artifact, createdAt: Date.now() });
  return artifact;
}

async function applyState(state: ExtensionState): Promise<CompiledProxyArtifact> {
  const artifact = await compiledArtifact(state);
  await setPacScript(artifact.pacScript);
  return artifact;
}

function withAppliedRuntime(state: ExtensionState, artifact: CompiledProxyArtifact): ExtensionState {
  return {
    ...state,
    activeProxyId: 'auto',
    proxyRuntime: {
      dirty: false,
      compiledBytes: artifact.compiledBytes,
      manualRuleCount: artifact.manualRuleCount,
      sourceRuleCount: artifact.sourceRuleCount,
      appliedAt: Date.now(),
      revision: artifact.revision,
      warnings: artifact.warnings,
    },
  };
}

export function dirtyProxyState(state: ExtensionState): ExtensionState {
  return { ...state, proxyRuntime: { ...state.proxyRuntime, dirty: true, error: undefined } };
}

export async function switchProxy(profileId: string): Promise<ExtensionState> {
  return updateState(async (current) => {
    const profile = current.proxyProfiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('代理配置不存在');
    await setBrowserProxyProfile(profile);
    return { ...current, activeProxyId: profileId };
  });
}

export async function saveProxyProfile(profile: ProxyProfile): Promise<ExtensionState> {
  return updateState(async (current) => {
    const canonical = canonicalProxyProfile(profile);
    assertUniqueProfileName(canonical, current.proxyProfiles);
    const next = dirtyProxyState({
      ...current,
      proxyProfiles: [...current.proxyProfiles.filter((item) => item.id !== canonical.id), canonical],
    });
    if (current.activeProxyId === canonical.id) await setBrowserProxyProfile(canonical);
    return next;
  });
}

export async function removeProxyProfile(profileId: string): Promise<ExtensionState> {
  const saved = await updateState((current) => {
    const profile = current.proxyProfiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('代理配置不存在');
    if (RESERVED_PROXY_PROFILE_IDS.has(profileId) || profile.builtin) throw new Error('内置代理出口不能删除');
    if (current.activeProxyId === profileId) throw new Error('该出口正在使用，请先切换到其他出口');
    if (current.proxyRules.some((rule) => rule.proxyProfileId === profileId)
      || current.proxyRuleSources.some((source) => source.matchProfileId === profileId || source.bypassProfileId === profileId)
      || current.proxyRouting.defaultProfileId === profileId) {
      throw new Error('该出口仍被自动切换规则引用，请先修改相关规则');
    }
    return dirtyProxyState({
      ...current,
      proxyProfiles: current.proxyProfiles.filter((item) => item.id !== profileId),
    });
  });
  await setProxyAuthPassword(profileId, '');
  return saved;
}

export async function applyProxyRules(): Promise<ExtensionState> {
  let failure: unknown;
  const result = await updateState(async (current) => {
    try {
      return withAppliedRuntime(current, await applyState(current));
    } catch (error) {
      failure = error;
      return {
        ...current,
        proxyRuntime: { ...current.proxyRuntime, dirty: true, error: error instanceof Error ? error.message : String(error) },
      };
    }
  });
  if (failure) throw failure;
  return result;
}

export async function compileCurrentProxyRules(): Promise<CompiledProxyArtifact> {
  return compiledArtifact(await getState());
}

export async function previewCurrentProxyRules(url: string): Promise<ProxyRulePreview> {
  return previewProxyRules(url, await compilationInput(await getState(), true));
}

function resolvedSourceUrl(value: string): string {
  const url = new URL(value);
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const blobIndex = parts.indexOf('blob');
    if (blobIndex === 2 && parts.length > 4) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(blobIndex + 1).join('/')}`;
    }
  }
  return url.toString();
}

function assertSourceProfiles(input: Pick<ProxyRuleSourceInput, 'matchProfileId' | 'bypassProfileId'>, state: ExtensionState): void {
  for (const profileId of [input.matchProfileId, input.bypassProfileId]) {
    const profile = state.proxyProfiles.find((item) => item.id === profileId);
    if (!profile || !isRoutable(profile)) throw new Error('规则源出口必须是直接连接或固定代理');
  }
}

export async function saveProxyRuleSource(input: ProxyRuleSourceInput): Promise<ProxyRuleSource> {
  const normalizedUrl = new URL(input.url).toString();
  let savedSource: ProxyRuleSource | undefined;
  await updateState((current) => {
    assertSourceProfiles(input, current);
    const existing = input.id ? current.proxyRuleSources.find((source) => source.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('规则源不存在');
    const identityChanged = Boolean(existing && (existing.url !== normalizedUrl || existing.format !== input.format));
    savedSource = {
      id: existing?.id || crypto.randomUUID(),
      name: input.name.trim(),
      url: normalizedUrl,
      format: input.format,
      enabled: input.enabled,
      matchProfileId: input.matchProfileId,
      bypassProfileId: input.bypassProfileId,
      order: input.order ?? existing?.order ?? current.proxyRuleSources.length,
      updateIntervalMinutes: input.updateIntervalMinutes,
      status: identityChanged ? 'idle' : existing?.status || 'idle',
      totalRuleCount: identityChanged ? 0 : existing?.totalRuleCount || 0,
      supportedRuleCount: identityChanged ? 0 : existing?.supportedRuleCount || 0,
      ignoredRuleCount: identityChanged ? 0 : existing?.ignoredRuleCount || 0,
      invalidRuleCount: identityChanged ? 0 : existing?.invalidRuleCount || 0,
      ...(!identityChanged && existing ? {
        revision: existing.revision,
        contentHash: existing.contentHash,
        etag: existing.etag,
        lastModified: existing.lastModified,
        lastCheckedAt: existing.lastCheckedAt,
        lastUpdatedAt: existing.lastUpdatedAt,
        error: existing.error,
      } : {}),
    };
    return dirtyProxyState({
      ...current,
      proxyRuleSources: [...current.proxyRuleSources.filter((item) => item.id !== savedSource!.id), savedSource!],
    });
  });
  return savedSource!;
}

async function fetchSource(source: ProxyRuleSource): Promise<Response> {
  const headers = new Headers();
  if (source.etag) headers.set('If-None-Match', source.etag);
  if (source.lastModified) headers.set('If-Modified-Since', source.lastModified);
  const response = await fetch(resolvedSourceUrl(source.url), { headers, cache: 'no-cache' });
  if (response.status === 304) return response;
  if (!response.ok) throw new Error(`规则源返回 HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_SOURCE_BYTES) throw new Error('规则源超过 10 MB 安全上限');
  return response;
}

async function refreshSourceOperation(sourceId: string, applyActive: boolean): Promise<ExtensionState> {
  const before = await getState();
  const source = before.proxyRuleSources.find((item) => item.id === sourceId);
  if (!source) throw new Error('规则源不存在');
  await updateState((current) => ({
    ...current,
    proxyRuleSources: current.proxyRuleSources.map((item) => item.id === sourceId ? { ...item, status: 'updating', error: undefined } : item),
  }));
  try {
    const response = await fetchSource(source);
    if (response.status === 304) {
      return updateState(async (current) => {
        const liveSource = current.proxyRuleSources.find((item) => item.id === sourceId);
        if (!liveSource || liveSource.url !== source.url || liveSource.format !== source.format) {
          throw new Error('规则源在下载期间已被修改，本次结果已丢弃');
        }
        const staged = {
          ...current,
          proxyRuleSources: current.proxyRuleSources.map((item) => item.id === sourceId
            ? { ...item, status: item.revision ? 'ready' as const : 'idle' as const, lastCheckedAt: Date.now(), error: undefined }
            : item),
        };
        return applyActive && current.activeProxyId === 'auto' && current.proxyRuntime.dirty
          ? withAppliedRuntime(staged, await applyState(staged))
          : staged;
      });
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_BYTES) throw new Error('规则源超过 10 MB 安全上限');
    const parsed = parseProxyRuleSource(text, source.format, source.id);
    if (parsed.rules.length === 0) throw new Error('规则源没有可用的代理规则');
    const revision = `${hashText(parsed.decodedText)}-${parsed.rules.length}`;
    await putSourceRevision(source.id, revision, parsed.decodedText, parsed.rules);
    const saved = await updateState(async (current) => {
      const liveSource = current.proxyRuleSources.find((item) => item.id === sourceId);
      if (!liveSource || liveSource.url !== source.url || liveSource.format !== source.format) {
        throw new Error('规则源在下载期间已被修改，本次结果已丢弃');
      }
      const updatedSource: ProxyRuleSource = {
        ...liveSource,
        revision,
        contentHash: hashText(parsed.decodedText),
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified') || undefined,
        lastCheckedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        status: 'ready',
        totalRuleCount: parsed.diagnostics.total,
        supportedRuleCount: parsed.diagnostics.supported,
        ignoredRuleCount: parsed.diagnostics.ignored,
        invalidRuleCount: parsed.diagnostics.invalid,
        error: parsed.diagnostics.warnings.length > 0 ? parsed.diagnostics.warnings.join('\n') : undefined,
      };
      const staged = dirtyProxyState({
        ...current,
        proxyRuleSources: current.proxyRuleSources.map((item) => item.id === sourceId ? updatedSource : item),
      });
      return applyActive && current.activeProxyId === 'auto'
        ? withAppliedRuntime(staged, await applyState(staged))
        : staged;
    });
    void pruneSourceRevisions(source.id, revision).catch(() => undefined);
    return saved;
  } catch (error) {
    await updateState((current) => ({
      ...current,
      proxyRuleSources: current.proxyRuleSources.map((item) => item.id === sourceId
        && item.url === source.url && item.format === source.format ? {
          ...item,
          status: 'error',
          lastCheckedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        } : item),
    }));
    throw error;
  }
}

export async function refreshProxyRuleSource(sourceId: string, applyActive = true): Promise<ExtensionState> {
  const source = (await getState()).proxyRuleSources.find((item) => item.id === sourceId);
  if (!source) throw new Error('规则源不存在');
  const identity = `${source.url}\n${source.format}`;
  const existing = sourceRefreshes.get(sourceId);
  if (existing?.identity === identity) {
    const refreshed = await existing.promise;
    return applyActive && refreshed.activeProxyId === 'auto' && refreshed.proxyRuntime.dirty
      ? applyProxyRules()
      : refreshed;
  }
  if (existing) {
    await existing.promise.catch(() => undefined);
    return refreshProxyRuleSource(sourceId, applyActive);
  }
  const refresh = refreshSourceOperation(sourceId, applyActive).finally(() => {
    if (sourceRefreshes.get(sourceId)?.promise === refresh) sourceRefreshes.delete(sourceId);
  });
  sourceRefreshes.set(sourceId, { identity, promise: refresh });
  return refresh;
}

export async function removeProxyRuleSource(sourceId: string): Promise<ExtensionState> {
  const saved = await updateState(async (current) => {
    if (!current.proxyRuleSources.some((source) => source.id === sourceId)) return current;
    const staged = dirtyProxyState({
      ...current,
      proxyRuleSources: current.proxyRuleSources.filter((source) => source.id !== sourceId),
    });
    return current.activeProxyId === 'auto'
      ? withAppliedRuntime(staged, await applyState(staged))
      : staged;
  });
  void deleteSource(sourceId).catch(() => undefined);
  return saved;
}

export async function getProxyRuleSourcePage(
  sourceId: string,
  offset: number,
  limit: number,
  query?: string,
): Promise<ProxyRulePage> {
  const source = (await getState()).proxyRuleSources.find((item) => item.id === sourceId);
  if (!source) throw new Error('规则源不存在');
  return getSourceRulePage(source.id, source.revision, offset, limit, query);
}

export async function routeCurrentSite(url: string, proxyProfileId: string): Promise<ExtensionState> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  return updateState(async (state) => {
    const profile = state.proxyProfiles.find((item) => item.id === proxyProfileId);
    if (!profile || !isRoutable(profile)) throw new Error('当前出口不能用于自动切换规则');
    const now = Date.now();
    const existing = state.proxyRules.find((rule) => rule.condition.type === 'host_exact'
      && rule.condition.value.toLowerCase() === hostname);
    const rule: ProxyRule = {
      id: existing?.id || crypto.randomUUID(),
      name: `${hostname} 路由`,
      enabled: true,
      condition: { type: 'host_exact', value: hostname },
      proxyProfileId,
      order: existing?.order ?? -1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const staged = dirtyProxyState({
      ...state,
      proxyRules: [rule, ...state.proxyRules.filter((item) => item.id !== rule.id)].map((item, order) => ({ ...item, order })),
    });
    return withAppliedRuntime(staged, await applyState(staged));
  });
}

export async function clearCurrentSiteRoute(url: string): Promise<ExtensionState> {
  const hostname = new URL(url).hostname.toLowerCase();
  return updateState(async (state) => {
    const proxyRules = state.proxyRules
      .filter((rule) => !(rule.condition.type === 'host_exact' && rule.condition.value.toLowerCase() === hostname))
      .sort((left, right) => left.order - right.order)
      .map((rule, order) => ({ ...rule, order }));
    const staged = dirtyProxyState({ ...state, proxyRules });
    return withAppliedRuntime(staged, await applyState(staged));
  });
}

export async function exportProxyConfiguration(): Promise<ProxyConfiguration> {
  const state = await getState();
  const sources: ProxyRuleSourceExport[] = [];
  let contentBytes = 0;
  for (const source of state.proxyRuleSources) {
    const content = await getSourceContent(source.id, source.revision);
    contentBytes += content ? new TextEncoder().encode(content).byteLength : 0;
    if (contentBytes > MAX_CONFIGURATION_CONTENT_BYTES) {
      throw new Error('规则源内容合计超过 25 MB，请减少订阅后再导出完整配置');
    }
    sources.push({ source, content });
  }
  return { version: 2, profiles: state.proxyProfiles, rules: state.proxyRules, sources, routing: state.proxyRouting };
}

export async function importProxyConfiguration(configuration: ProxyConfiguration): Promise<ExtensionState> {
  const contentBytes = configuration.sources.reduce(
    (total, item) => total + (item.content ? new TextEncoder().encode(item.content).byteLength : 0), 0,
  );
  if (contentBytes > MAX_CONFIGURATION_CONTENT_BYTES) throw new Error('导入配置中的规则源内容合计不能超过 25 MB');
  assertUniqueIds(configuration.profiles.map((profile) => profile.id), '代理出口');
  assertUniqueIds(configuration.rules.map((rule) => rule.id), '手动规则');
  assertUniqueIds(configuration.sources.map(({ source }) => source.id), '规则订阅');
  const profiles = configuration.profiles.map(canonicalProxyProfile);
  const profileNames = profiles.map((profile) => profile.name.trim().toLocaleLowerCase());
  if (new Set(profileNames).size !== profileNames.length) throw new Error('代理配置包含重名出口');
  for (const [profileId, kind] of [['direct', 'direct'], ['system', 'system'], ['yakit-mitm', 'fixed_servers']] as const) {
    if (!profiles.some((profile) => profile.id === profileId && profile.kind === kind)) {
      throw new Error(`代理配置缺少内置出口：${profileId}`);
    }
  }
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const routableIds = new Set(profiles.filter(isRoutable).map((profile) => profile.id));
  if (!profileIds.has(configuration.routing.defaultProfileId)) throw new Error('代理配置的默认出口不存在');
  if (!routableIds.has(configuration.routing.defaultProfileId)) throw new Error('代理配置的默认出口必须是直接连接或固定代理');
  if (configuration.rules.some((rule) => !routableIds.has(rule.proxyProfileId))) throw new Error('手动规则引用了不可用的出口');
  if (configuration.sources.some(({ source }) => !routableIds.has(source.matchProfileId) || !routableIds.has(source.bypassProfileId))) {
    throw new Error('规则源引用了不可用的出口');
  }

  const revisionWrites: Array<{
    sourceId: string;
    revision: string;
    content: string;
    rules: ReturnType<typeof parseProxyRuleSource>['rules'];
  }> = [];
  const proxyRuleSources = configuration.sources.map(({ source, content }) => {
    if (!content) {
      return {
        ...source,
        revision: undefined,
        contentHash: undefined,
        etag: undefined,
        lastModified: undefined,
        lastCheckedAt: undefined,
        lastUpdatedAt: undefined,
        status: 'idle' as const,
        totalRuleCount: 0,
        supportedRuleCount: 0,
        ignoredRuleCount: 0,
        invalidRuleCount: 0,
        error: undefined,
      };
    }
    const parsed = parseProxyRuleSource(content, source.format, source.id);
    if (parsed.rules.length === 0) throw new Error(`规则源“${source.name}”的导入内容没有可用规则`);
    const contentHash = hashText(parsed.decodedText);
    const revision = `${contentHash}-${parsed.rules.length}`;
    revisionWrites.push({ sourceId: source.id, revision, content: parsed.decodedText, rules: parsed.rules });
    return {
      ...source,
      revision,
      contentHash,
      etag: undefined,
      lastModified: undefined,
      status: 'ready' as const,
      totalRuleCount: parsed.diagnostics.total,
      supportedRuleCount: parsed.diagnostics.supported,
      ignoredRuleCount: parsed.diagnostics.ignored,
      invalidRuleCount: parsed.diagnostics.invalid,
      error: parsed.diagnostics.warnings.length > 0 ? parsed.diagnostics.warnings.join('\n') : undefined,
    };
  });
  await Promise.all(revisionWrites.map((item) => putSourceRevision(
    item.sourceId, item.revision, item.content, item.rules,
  )));

  const direct = profiles.find((profile) => profile.id === 'direct')!;
  let removedSourceIds: string[] = [];
  const saved = await updateState(async (current) => {
    const importedSourceIds = new Set(proxyRuleSources.map((source) => source.id));
    removedSourceIds = current.proxyRuleSources
      .filter((source) => !importedSourceIds.has(source.id))
      .map((source) => source.id);
    await setBrowserProxyProfile(direct);
    return dirtyProxyState({
      ...current,
      proxyProfiles: profiles,
      proxyRules: sortedProxyRules(configuration.rules).map((rule, order) => ({ ...rule, order })),
      proxyRuleSources: [...proxyRuleSources]
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((source, order) => ({ ...source, order })),
      proxyRouting: configuration.routing,
      activeProxyId: 'direct',
    });
  });
  for (const sourceId of removedSourceIds) void deleteSource(sourceId).catch(() => undefined);
  for (const source of proxyRuleSources) {
    if (source.revision) void pruneSourceRevisions(source.id, source.revision).catch(() => undefined);
    else void deleteSource(source.id).catch(() => undefined);
  }
  return saved;
}

export async function setProxyAuthPassword(profileId: string, password: string): Promise<void> {
  if (password) authPasswords.set(profileId, password);
  else authPasswords.delete(profileId);
  if (sessionStorage) await sessionStorage.set({ [PROXY_AUTH_STORAGE_KEY]: Object.fromEntries(authPasswords) });
}

export function hasProxyAuthPassword(profileId: string): boolean {
  return authPasswords.has(profileId);
}

if (sessionStorage) {
  void sessionStorage.get(PROXY_AUTH_STORAGE_KEY).then((stored) => {
    const values = stored[PROXY_AUTH_STORAGE_KEY];
    if (values && typeof values === 'object') {
      for (const [id, password] of Object.entries(values)) if (typeof password === 'string') authPasswords.set(id, password);
    }
  }).catch(() => undefined);
}

void getState().then((state) => { proxyState = state; }).catch(() => undefined);
browser.storage.onChanged.addListener((changes) => {
  if (isStateStorageChange(changes)) void getState().then((state) => { proxyState = state; }).catch(() => undefined);
});

browser.webRequest.onAuthRequired.addListener((details, asyncCallback) => {
  const resolveCredentials = (state?: ExtensionState) => {
    const challenger = details.challenger;
    const profile = state?.proxyProfiles.find((item) => item.kind === 'fixed_servers'
      && item.host === challenger?.host && item.port === challenger?.port);
    const password = profile && authPasswords.get(profile.id);
    return details.isProxy && profile?.authEnabled && profile.authUsername && password
      ? { authCredentials: { username: profile.authUsername, password } }
      : {};
  };
  if (!proxyState && asyncCallback) {
    void getState().then((state) => {
      proxyState = state;
      asyncCallback(resolveCredentials(state));
    }).catch(() => asyncCallback({}));
    return undefined;
  }
  const response = resolveCredentials(proxyState);
  if (asyncCallback) {
    asyncCallback(response);
    return undefined;
  }
  return response;
}, { urls: ['<all_urls>'] }, [isFirefox() ? 'blocking' : 'asyncBlocking']);

async function refreshDueSources(): Promise<void> {
  const state = await getState();
  const now = Date.now();
  const due = state.proxyRuleSources.filter((source) => source.enabled
    && (!source.lastCheckedAt || now - source.lastCheckedAt >= source.updateIntervalMinutes * 60_000));
  let changed = false;
  for (const source of due) {
    try {
      const refreshed = await refreshProxyRuleSource(source.id, false);
      const nextSource = refreshed.proxyRuleSources.find((item) => item.id === source.id);
      if (nextSource?.revision !== source.revision) changed = true;
    } catch {
      // The source retains its last good revision and exposes the update error in state.
    }
  }
  if (changed && (await getState()).activeProxyId === 'auto') await applyProxyRules();
}

if (browser.alarms) {
  void browser.alarms.create(SOURCE_REFRESH_ALARM, { periodInMinutes: 30 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SOURCE_REFRESH_ALARM) void refreshDueSources();
  });
}

export { profileToPac } from './compiler';
