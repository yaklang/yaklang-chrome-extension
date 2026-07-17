import { browser, type Browser } from 'wxt/browser';
import type { ActiveTabInfo, BrowserTarget } from '@/types/models';
import { ExtensionError } from '@/shared/errors';

type DocumentProbeResult = Browser.scripting.InjectionResult & { documentId?: string };

function probeDocument() {
  return { url: location.href };
}

export function scriptingTarget(target: BrowserTarget): Browser.scripting.InjectionTarget {
  if (target.documentId && !import.meta.env.FIREFOX) {
    return { tabId: target.tabId, documentIds: [target.documentId] } as unknown as Browser.scripting.InjectionTarget;
  }
  return { tabId: target.tabId, frameIds: [target.frameId] };
}

export async function resolveDocumentTarget(input: BrowserTarget | number): Promise<BrowserTarget> {
  const requested: BrowserTarget = typeof input === 'number'
    ? { tabId: input, frameId: 0 }
    : { ...input, frameId: input.frameId ?? 0 };
  let probe: DocumentProbeResult | undefined;
  try {
    [probe] = await browser.scripting.executeScript({
      target: { tabId: requested.tabId, frameIds: [requested.frameId] },
      world: 'MAIN',
      func: probeDocument,
    }) as DocumentProbeResult[];
  } catch (error) {
    throw new ExtensionError('target_unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!probe) throw new ExtensionError('target_unavailable', '无法定位目标页面文档');
  if (requested.documentId && probe.documentId && requested.documentId !== probe.documentId) {
    throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新授权');
  }
  return { tabId: requested.tabId, frameId: probe.frameId, documentId: probe.documentId || requested.documentId };
}

async function findRecentHttpTab(): Promise<Browser.tabs.Tab | undefined> {
  const active = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (active?.url && /^https?:/i.test(active.url)) return active;
  const tabs = await browser.tabs.query({ currentWindow: true });
  return tabs.filter((tab) => tab.url && /^https?:/i.test(tab.url))
    .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
}

export async function getTab(tabId?: number): Promise<ActiveTabInfo> {
  const tab = tabId ? await browser.tabs.get(tabId) : await findRecentHttpTab();
  if (!tab?.id || !tab.url) throw new Error('无法读取当前标签页');
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '未命名页面',
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
  };
}

export const getActiveTab = () => getTab();

export async function activateTab(tabId?: number): Promise<void> {
  const tab = tabId ? await browser.tabs.get(tabId) : await browser.tabs.get((await getActiveTab()).id);
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tab.id, { active: true });
}
