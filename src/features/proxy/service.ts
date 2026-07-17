import { browser } from 'wxt/browser';
import { isStateStorageChange, PROXY_AUTH_STORAGE_KEY, PROXY_STATS_STORAGE_KEY } from '@/protocol/storage';
import type {
  ExtensionState, ProxyProfile, ProxyRoutingSettings, ProxyRule, ProxyRulePreview, ProxyRuleStats,
} from '@/types/models';
import { getState, updateState } from '@/platform/storage/state';
import {
  compileProxyRules, previewProxyRules, proxyPatternMatches, sortedProxyRules,
} from './compiler';

export { compileProxyRules, previewProxyRules, proxyPatternMatches } from './compiler';

function isFirefox(): boolean {
  return Boolean(import.meta.env.FIREFOX);
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
      proxyType: 'manual',
      socks: `${profile.host}:${profile.port}`,
      socksVersion: profile.scheme === 'socks4' ? 4 : 5,
      proxyDNS: true,
      passthrough: profile.bypass.join(', '),
    };
  }
  const address = `${profile.scheme || 'http'}://${profile.host}:${profile.port}`;
  return { proxyType: 'manual', http: address, ssl: address, httpProxyAll: true, passthrough: profile.bypass.join(', ') };
}

export async function switchProxy(profileId: string): Promise<void> {
  const state = await getState();
  const profile = state.proxyProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error('代理配置不存在');
  if (!browser.proxy?.settings) throw new Error('当前浏览器不支持代理 API');

  const value = isFirefox() ? firefoxProxyValue(profile) : chromeProxyValue(profile);
  await browser.proxy.settings.set({ value: value as Browser.proxy.ProxyConfig, scope: 'regular' });
  await updateState((current) => ({ ...current, activeProxyId: profileId }));
}

export async function applyProxyRules(): Promise<void> {
  const state = await getState();
  const pacScript = compileProxyRules(state.proxyRules, state.proxyProfiles, state.proxyRouting);
  if (isFirefox()) {
    await browser.proxy.settings.set({
      value: { proxyType: 'autoConfig', autoConfigUrl: `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(pacScript)}` } as unknown as Browser.proxy.ProxyConfig,
      scope: 'regular',
    });
  } else {
    await browser.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: pacScript, mandatory: true } },
      scope: 'regular',
    });
  }
  await updateState((current) => ({ ...current, activeProxyId: 'rules' }));
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const sessionStorage = (browser.storage as unknown as { session?: StorageArea }).session;
const authPasswords = new Map<string, string>();
const ruleStats = new Map<string, ProxyRuleStats>();
let routingState: ExtensionState | undefined;
let statsTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

void getState().then((state) => { routingState = state; }).catch(() => undefined);
if (sessionStorage) {
  void sessionStorage.get(PROXY_AUTH_STORAGE_KEY).then((stored) => {
    const values = stored[PROXY_AUTH_STORAGE_KEY];
    if (values && typeof values === 'object') for (const [id, password] of Object.entries(values)) if (typeof password === 'string') authPasswords.set(id, password);
  }).catch(() => undefined);
  void sessionStorage.get(PROXY_STATS_STORAGE_KEY).then((stored) => {
    const values = stored[PROXY_STATS_STORAGE_KEY];
    if (Array.isArray(values)) for (const item of values) {
      const stat = item as ProxyRuleStats;
      if (typeof stat.ruleId === 'string' && Number.isFinite(stat.hits)) ruleStats.set(stat.ruleId, stat);
    }
  }).catch(() => undefined);
}

browser.storage.onChanged.addListener((changes) => {
  if (isStateStorageChange(changes)) void getState().then((state) => { routingState = state; }).catch(() => undefined);
});

function persistStats(): void {
  if (!sessionStorage || statsTimer) return;
  statsTimer = globalThis.setTimeout(() => {
    statsTimer = undefined;
    void sessionStorage.set({ [PROXY_STATS_STORAGE_KEY]: [...ruleStats.values()] }).catch(() => undefined);
  }, 1_000);
}

browser.webRequest.onBeforeRequest.addListener((details) => {
  const state = routingState;
  if (!state || state.activeProxyId !== 'rules') return;
  const rule = sortedProxyRules(state.proxyRules).find((item) => item.enabled && item.patterns.some((pattern) => proxyPatternMatches(pattern, details.url)));
  if (!rule) return;
  const current = ruleStats.get(rule.id) || { ruleId: rule.id, hits: 0 };
  ruleStats.set(rule.id, { ...current, hits: current.hits + 1, lastHitAt: Date.now(), lastUrl: details.url.slice(0, 2_048) });
  persistStats();
}, { urls: ['<all_urls>'] });

browser.webRequest.onAuthRequired.addListener((details, asyncCallback) => {
  const state = routingState;
  const profile = state?.proxyProfiles.find((item) => item.id === state.activeProxyId);
  const password = profile && authPasswords.get(profile.id);
  const response = details.isProxy && profile?.authEnabled && profile.authUsername && password
    ? { authCredentials: { username: profile.authUsername, password } }
    : {};
  if (asyncCallback) {
    asyncCallback(response);
    return undefined;
  }
  return response;
}, { urls: ['<all_urls>'] }, [isFirefox() ? 'blocking' : 'asyncBlocking']);

export async function setProxyAuthPassword(profileId: string, password: string): Promise<void> {
  if (password) authPasswords.set(profileId, password);
  else authPasswords.delete(profileId);
  if (sessionStorage) await sessionStorage.set({ [PROXY_AUTH_STORAGE_KEY]: Object.fromEntries(authPasswords) });
}

export function hasProxyAuthPassword(profileId: string): boolean {
  return authPasswords.has(profileId);
}

export function getProxyRuleStats(): ProxyRuleStats[] {
  return [...ruleStats.values()].sort((left, right) => right.hits - left.hits);
}

export async function clearProxyRuleStats(): Promise<void> {
  ruleStats.clear();
  if (sessionStorage) await sessionStorage.set({ [PROXY_STATS_STORAGE_KEY]: [] });
}
