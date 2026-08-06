import { browser, type Browser } from 'wxt/browser';
import { ExtensionError } from '@/shared/errors';
import type { BrowserFirefoxManagedContainer } from '@/types/models';

const STORAGE_KEY = 'browser.authorization.managed-firefox-containers.v1';
const MAX_MANAGED_CONTAINERS = 16;
const COLORS = ['blue', 'turquoise', 'green', 'orange', 'purple', 'pink'] as const;

interface FirefoxContextualIdentity {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

interface FirefoxContextualIdentitiesAPI {
  create(details: {
    name: string;
    color: string;
    icon: string;
  }): Promise<FirefoxContextualIdentity>;
  query(details: Record<string, never>): Promise<FirefoxContextualIdentity[]>;
  remove(cookieStoreId: string): Promise<FirefoxContextualIdentity>;
}

interface ManagedFirefoxContainer {
  version: 1;
  cookieStoreId: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface FirefoxContainerDescriptor extends FirefoxContextualIdentity {
  managed: boolean;
}

function contextualIdentities(): FirefoxContextualIdentitiesAPI | undefined {
  if (!import.meta.env.FIREFOX) return undefined;
  return (browser as unknown as {
    contextualIdentities?: FirefoxContextualIdentitiesAPI;
  }).contextualIdentities;
}

function validManagedContainer(value: unknown): value is ManagedFirefoxContainer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const container = value as Partial<ManagedFirefoxContainer>;
  return container.version === 1
    && typeof container.cookieStoreId === 'string'
    && /^firefox-container-[0-9]+$/.test(container.cookieStoreId)
    && typeof container.name === 'string'
    && container.name.length > 0
    && container.name.length <= 50
    && typeof container.color === 'string'
    && container.color.length <= 32
    && typeof container.createdAt === 'number'
    && Number.isFinite(container.createdAt);
}

async function readManagedContainers(): Promise<ManagedFirefoxContainer[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter(validManagedContainer).slice(-MAX_MANAGED_CONTAINERS);
}

async function writeManagedContainers(
  containers: ManagedFirefoxContainer[],
): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEY]: containers.slice(-MAX_MANAGED_CONTAINERS),
  });
}

export function firefoxContainerManagementAvailable(): boolean {
  return Boolean(contextualIdentities());
}

export async function listFirefoxContainerDescriptors(): Promise<FirefoxContainerDescriptor[]> {
  const api = contextualIdentities();
  if (!api) return [];
  const [containers, managed] = await Promise.all([
    api.query({}),
    readManagedContainers(),
  ]);
  const managedIDs = new Set(managed.map((container) => container.cookieStoreId));
  return containers.slice(0, 128).map((container) => ({
    ...container,
    managed: managedIDs.has(container.cookieStoreId),
  }));
}

export async function listManagedFirefoxContainerIdentities(): Promise<BrowserFirefoxManagedContainer[]> {
  const api = contextualIdentities();
  if (!api) return [];
  const [containers, managed, tabs] = await Promise.all([
    api.query({}),
    readManagedContainers(),
    browser.tabs.query({}),
  ]);
  const currentContainers = new Map(
    containers.map((container) => [container.cookieStoreId, container]),
  );
  const retained = managed.filter((container) => currentContainers.has(container.cookieStoreId));
  if (retained.length !== managed.length) await writeManagedContainers(retained);
  const tabCounts = new Map<string, number>();
  for (const tab of tabs) {
    const cookieStoreId = (tab as Browser.tabs.Tab & { cookieStoreId?: string }).cookieStoreId;
    if (!cookieStoreId) continue;
    tabCounts.set(cookieStoreId, (tabCounts.get(cookieStoreId) || 0) + 1);
  }
  return retained
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((entry) => {
      const container = currentContainers.get(entry.cookieStoreId)!;
      return {
        cookieStoreId: entry.cookieStoreId,
        name: container.name,
        color: container.color,
        createdAt: entry.createdAt,
        tabCount: tabCounts.get(entry.cookieStoreId) || 0,
      };
    });
}

export async function createFirefoxContainerIdentity(input: {
  url: string;
  name?: string;
}): Promise<{
  tab: Browser.tabs.Tab;
  container: FirefoxContainerDescriptor & { managed: true };
}> {
  const api = contextualIdentities();
  if (!api) {
    throw new ExtensionError(
      'channel_unavailable',
      '当前浏览器没有开放 Firefox Container 管理能力',
    );
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ExtensionError('isolation_invalid', 'Container 身份页面 URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ExtensionError('isolation_invalid', 'Container 身份页面只能使用 HTTP(S) URL');
  }
  const managed = await readManagedContainers();
  if (managed.length >= MAX_MANAGED_CONTAINERS) {
    throw new ExtensionError(
      'isolation_limit',
      `最多保留 ${MAX_MANAGED_CONTAINERS} 个由 Yakit 创建的临时 Container，请先清理不用的身份`,
    );
  }
  const name = (input.name || `Yakit 测试身份 ${managed.length + 1}`)
    .trim()
    .slice(0, 50);
  if (!name) throw new ExtensionError('isolation_invalid', 'Container 身份名称不能为空');
  const color = COLORS[managed.length % COLORS.length];
  const container = await api.create({
    name,
    color,
    icon: 'fingerprint',
  });
  const entry: ManagedFirefoxContainer = {
    version: 1,
    cookieStoreId: container.cookieStoreId,
    name: container.name,
    color: container.color,
    createdAt: Date.now(),
  };
  await writeManagedContainers([...managed, entry]);
  try {
    const tab = await (browser.tabs.create as unknown as (details: {
      url: string;
      active: boolean;
      cookieStoreId: string;
    }) => Promise<Browser.tabs.Tab>)({
      url: url.href,
      active: true,
      cookieStoreId: container.cookieStoreId,
    });
    return {
      tab,
      container: {
        ...container,
        managed: true,
      },
    };
  } catch (error) {
    await api.remove(container.cookieStoreId).catch(() => undefined);
    await writeManagedContainers(
      managed.filter((candidate) => candidate.cookieStoreId !== container.cookieStoreId),
    );
    throw error;
  }
}

export async function removeFirefoxContainerIdentity(
  cookieStoreId: string,
): Promise<{ cookieStoreId: string; removedTabs: number }> {
  const api = contextualIdentities();
  if (!api) {
    throw new ExtensionError(
      'channel_unavailable',
      '当前浏览器没有开放 Firefox Container 管理能力',
    );
  }
  const managed = await readManagedContainers();
  if (!managed.some((container) => container.cookieStoreId === cookieStoreId)) {
    throw new ExtensionError(
      'target_denied',
      '只能清理由 Yakit 创建的临时 Firefox Container',
    );
  }
  const tabs = await browser.tabs.query({});
  const tabIDs = tabs.flatMap((tab) => {
    const storeID = (tab as Browser.tabs.Tab & { cookieStoreId?: string }).cookieStoreId;
    return storeID === cookieStoreId && tab.id ? [tab.id] : [];
  });
  if (tabIDs.length) await browser.tabs.remove(tabIDs);
  await api.remove(cookieStoreId);
  await writeManagedContainers(
    managed.filter((container) => container.cookieStoreId !== cookieStoreId),
  );
  return { cookieStoreId, removedTabs: tabIDs.length };
}
