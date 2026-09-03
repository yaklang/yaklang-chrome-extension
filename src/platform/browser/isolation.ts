import { browser, type Browser } from 'wxt/browser';
import type {
  ActiveTabInfo,
  BrowserIsolationContext,
  BrowserIsolationInspection,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

export interface IsolationCookieStore {
  id: string;
  tabIds: number[];
}

export interface IsolationTabDescriptor {
  id: number;
  windowId: number;
  active?: boolean;
  title: string;
  url: string;
  incognito: boolean;
  cookieStoreId?: string;
  favIconUrl?: string;
  lastAccessed?: number;
}

export interface BrowserIsolationContainerDescriptor {
  cookieStoreId: string;
  name: string;
  color: string;
  icon?: string;
  managed: boolean;
}

export function uniqueTabIds(tabIds: readonly number[]): number[] {
  return [...new Set(
    tabIds.filter((tabId) => Number.isSafeInteger(tabId) && tabId > 0),
  )].sort((left, right) => left - right);
}

export async function listIsolationCookieStores(): Promise<IsolationCookieStore[]> {
  try {
    const stores = await browser.cookies.getAllCookieStores();
    return stores.map((store) => ({
      id: store.id,
      tabIds: uniqueTabIds(store.tabIds),
    }));
  } catch {
    return [];
  }
}

export function cookieStoreIdForDescriptor(
  tab: { id: number; cookieStoreId?: string },
  cookieStores: readonly IsolationCookieStore[],
): string | undefined {
  if (tab.cookieStoreId) return tab.cookieStoreId;
  return cookieStores.find((store) => store.tabIds.includes(tab.id))?.id;
}

export async function resolveTabCookieStoreId(tabId: number): Promise<string> {
  if (!Number.isSafeInteger(tabId) || tabId < 1) {
    throw new ExtensionError('isolation_unresolved', '目标标签页 ID 无效，不能解析 Cookie Store');
  }
  const tab = await browser.tabs.get(tabId);
  const firefoxTab = tab as Browser.tabs.Tab & { cookieStoreId?: string };
  const storeId = cookieStoreIdForDescriptor(
    { id: tabId, cookieStoreId: firefoxTab.cookieStoreId },
    await listIsolationCookieStores(),
  );
  if (!storeId) {
    throw new ExtensionError(
      'isolation_unresolved',
      '浏览器没有返回目标标签页的 Cookie Store，已拒绝读取或修改认证材料',
    );
  }
  return storeId;
}

function contextId(
  kind: BrowserIsolationContext['kind'],
  cookieStoreId: string | undefined,
  tabId: number,
): string {
  const stablePart = cookieStoreId || `tab-${tabId}`;
  return `${kind}:${encodeURIComponent(stablePart)}`.slice(0, 320);
}

function firefoxContainer(cookieStoreId: string | undefined): boolean {
  return Boolean(cookieStoreId && cookieStoreId.startsWith('firefox-container-'));
}

function isolatedSiteDataGuarantees(): BrowserIsolationContext['guarantees'] {
  return {
    cookies: 'isolated',
    localStorage: 'isolated',
    indexedDB: 'isolated',
    serviceWorker: 'isolated',
    httpAuth: 'unknown',
    clientCertificate: 'unknown',
  };
}

function unresolvedGuarantees(): BrowserIsolationContext['guarantees'] {
  return {
    cookies: 'unknown',
    localStorage: 'unknown',
    indexedDB: 'unknown',
    serviceWorker: 'unknown',
    httpAuth: 'unknown',
    clientCertificate: 'unknown',
  };
}

export function cookieStoreIdForTab(
  tab: Pick<IsolationTabDescriptor, 'id' | 'cookieStoreId'>,
  cookieStores: readonly IsolationCookieStore[],
): string | undefined {
  return cookieStoreIdForDescriptor(tab, cookieStores);
}

export function isolationContextForTab(
  tab: IsolationTabDescriptor,
  cookieStores: readonly IsolationCookieStore[],
  browserKind: BrowserIsolationInspection['browser'],
  containerDescriptors: readonly BrowserIsolationContainerDescriptor[] = [],
): BrowserIsolationContext {
  const storeId = cookieStoreIdForTab(tab, cookieStores);
  const store = storeId ? cookieStores.find((candidate) => candidate.id === storeId) : undefined;
  const isContainer = browserKind === 'firefox' && firefoxContainer(storeId);
  const container = isContainer
    ? containerDescriptors.find((candidate) => candidate.cookieStoreId === storeId)
    : undefined;
  const kind: BrowserIsolationContext['kind'] = isContainer
    ? 'firefox-container'
    : browserKind === 'chromium' && tab.incognito
      ? 'chrome-incognito-store'
      : 'browser-profile';
  if (!storeId) {
    return {
      contextId: contextId(kind, undefined, tab.id),
      kind,
      incognito: tab.incognito,
      level: 'none',
      guarantees: unresolvedGuarantees(),
      tabIds: [tab.id],
      reasons: ['浏览器没有返回目标 Tab 对应的 Cookie Store，不能证明认证上下文隔离'],
    };
  }
  const reasons = isContainer
    ? ['Firefox Container 提供独立 Cookie 与站点存储上下文']
    : tab.incognito
      ? ['无痕 Cookie Store 与普通浏览上下文分离']
      : ['浏览器 Profile 内的 Cookie Store 已被明确定位'];
  return {
    contextId: contextId(kind, storeId, tab.id),
    kind,
    cookieStoreId: storeId,
    incognito: tab.incognito,
    containerId: isContainer ? storeId : undefined,
    containerName: container?.name,
    containerColor: container?.color,
    managed: container?.managed,
    level: 'strong',
    guarantees: isolatedSiteDataGuarantees(),
    tabIds: uniqueTabIds(store?.tabIds || [tab.id]),
    reasons,
  };
}

export function activeTabInfo(
  tab: IsolationTabDescriptor,
  context: BrowserIsolationContext,
): ActiveTabInfo {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    title: tab.title || '未命名页面',
    url: tab.url,
    incognito: tab.incognito,
    cookieStoreId: context.cookieStoreId,
    isolationContextId: context.contextId,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
  };
}

export function browserTabDescriptor(tab: Browser.tabs.Tab): IsolationTabDescriptor | undefined {
  if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) return undefined;
  const firefoxTab = tab as Browser.tabs.Tab & { cookieStoreId?: string };
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title || '未命名页面',
    url: tab.url,
    incognito: tab.incognito,
    cookieStoreId: firefoxTab.cookieStoreId,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
  };
}

export async function resolveBrowserTabInfo(tab: Browser.tabs.Tab): Promise<ActiveTabInfo> {
  const descriptor = browserTabDescriptor(tab);
  if (!descriptor) {
    throw new ExtensionError('target_unavailable', '目标标签页不是可访问的 HTTP(S) 页面');
  }
  const context = isolationContextForTab(
    descriptor,
    await listIsolationCookieStores(),
    import.meta.env.FIREFOX ? 'firefox' : 'chromium',
  );
  return activeTabInfo(descriptor, context);
}
