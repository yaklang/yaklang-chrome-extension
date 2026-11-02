import { browser } from 'wxt/browser';
import type { ProxyProfile } from '@/types/models';
import { getState } from '@/platform/storage/state';
import { engineBridge } from '@/features/engine-bridge/service';
import { isStateStorageChange } from '@/protocol/storage';
import { applyManagedMITMRoutes, getProxyStatus, hasMITMProxyCredentials } from './service';
import {
  managedMITMRoutes, replaceManagedMITMRoutes, startupProxyProfile, type ManagedMITMRoute,
} from './mitm-ingress-runtime';

const STORAGE_KEY = 'session.mitm-ingress.v1';
const ALARM = 'mitm-ingress-renew';
const METHOD = 'yakit.mitm.ingress';
const RENEW_INTERVAL = 10_000;
let initialization: Promise<void> | undefined;
let reconciling = false;
let scheduled: ReturnType<typeof setTimeout> | undefined;

function schedule(): void {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = undefined;
    void reconcileManagedMITMIngress().catch((error) => console.error('MITM instance routing failed', error));
  }, 100);
}

export async function reconcileManagedMITMIngress(): Promise<void> {
  if (reconciling) { schedule(); return; }
  reconciling = true;
  try {
    const state = await getState();
    const instanceId = state.bridge.managedInstance?.instanceId;
    const engineIdentityId = state.bridge.pairedEngine?.engineIdentityId;
    const status = engineBridge.getStatus();
    const retained = managedMITMRoutes().filter((route) => route.instanceId === instanceId
      && route.engineIdentityId === engineIdentityId && route.expiresAt > Date.now());
    const commit = async (routes: ManagedMITMRoute[]) => {
      await applyManagedMITMRoutes(routes);
      await browser.storage.session?.set({ [STORAGE_KEY]: routes });
    };
    if (!instanceId || !engineIdentityId || state.bridge.launchTarget?.mode === 'none') { await commit([]); return; }
    // A short Bridge reconnect must not interrupt established proxy tunnels.
    if (status.state !== 'connected') { await commit(retained); return; }
    if (!status.capabilities?.includes(METHOD)) { await commit([]); return; }

    const proxyStatus = await getProxyStatus(state);
    const startup = proxyStatus.followingStartup ? startupProxyProfile(state.startupProxy) : undefined;
    const candidates = startup ? [startup]
      : proxyStatus.activeProfileId === 'auto' ? state.proxyProfiles
        : state.proxyProfiles.filter((profile) => profile.id === proxyStatus.activeProfileId);
    const unique = new Map<string, ProxyProfile>();
    for (const profile of candidates) {
      if (profile.kind !== 'fixed_servers' || !['http', 'https'].includes(profile.scheme || 'http')) continue;
      unique.set(`${profile.host || '127.0.0.1'}:${profile.port || 8083}`, profile);
    }
    const routes: ManagedMITMRoute[] = [];
    for (const profile of unique.values()) {
      const proxyHost = profile.host || '127.0.0.1';
      const proxyPort = profile.port || 8083;
      try {
        const result = await engineBridge.requestEngine<{
          available: boolean; host?: string; port?: number; expiresAt?: number; requiresProxyAuth?: boolean;
        }>(METHOD, { proxyHost, proxyPort }, 5_000);
        if (!result.available) continue;
        if (result.host !== '127.0.0.1' || !Number.isSafeInteger(result.port) || result.port! < 1 || result.port! > 65535
          || !Number.isSafeInteger(result.expiresAt) || result.expiresAt! <= Date.now()
          || result.expiresAt! > Date.now() + 180_000) throw new Error('Invalid browser MITM ingress');
        const credentials = state.proxyProfiles.find((item) => item.host === proxyHost && (item.port || 8083) === proxyPort
          && hasMITMProxyCredentials(item));
        // Never weaken an existing proxy password or break YTray's separate
        // launch authentication helper, whose challenger remains the base port.
        if (result.requiresProxyAuth && !credentials) continue;
        routes.push({ proxyHost, proxyPort, host: result.host, port: result.port!, expiresAt: result.expiresAt!,
          engineIdentityId, instanceId });
      } catch {
        const previous = retained.find((route) => route.proxyHost === proxyHost && route.proxyPort === proxyPort);
        if (previous) routes.push(previous);
      }
    }
    const latest = await getState();
    if (engineBridge.getStatus().connectionId !== status.connectionId
      || latest.bridge.pairedEngine?.engineIdentityId !== engineIdentityId
      || latest.bridge.managedInstance?.instanceId !== instanceId) { schedule(); return; }
    await commit(routes);
  } finally {
    reconciling = false;
  }
}

export function initializeManagedMITMIngress(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const [state, stored] = await Promise.all([getState(), browser.storage.session?.get(STORAGE_KEY)]);
    const values = stored?.[STORAGE_KEY];
    if (Array.isArray(values)) {
      replaceManagedMITMRoutes(values.filter((value): value is ManagedMITMRoute => value && typeof value === 'object'
        && value.host === '127.0.0.1' && typeof value.proxyHost === 'string'
        && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
        && Number.isSafeInteger(value.proxyPort) && value.proxyPort > 0 && value.proxyPort <= 65535
        && Number.isSafeInteger(value.expiresAt)
        && value.instanceId === state.bridge.managedInstance?.instanceId
        && value.engineIdentityId === state.bridge.pairedEngine?.engineIdentityId).slice(0, 64));
    }
    engineBridge.subscribeStatus(schedule);
    browser.storage.onChanged.addListener((changes) => {
      if (isStateStorageChange(changes)) schedule();
    });
    setInterval(schedule, RENEW_INTERVAL);
    await browser.alarms.create(ALARM, { periodInMinutes: 0.5 });
    browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) schedule(); });
    schedule();
  })();
  return initialization;
}
