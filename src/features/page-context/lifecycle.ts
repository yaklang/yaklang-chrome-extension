import { browser } from 'wxt/browser';
import { PAGE_LIFECYCLE_STORAGE_KEY } from '@/protocol/storage';
import type { PageLifecycleEvent } from '@/types/models';

const MAX_EVENTS_PER_TAB = 100;
const MAX_PERSISTED_TABS = 16;
const eventsByTab = new Map<number, PageLifecycleEvent[]>();
const sessionStorage = (browser.storage as unknown as {
  session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
}).session;
let persistTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

function isLifecycleEvent(value: unknown): value is PageLifecycleEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PageLifecycleEvent>;
  return typeof event.id === 'string' && ['document', 'history', 'fragment'].includes(String(event.kind))
    && Number.isSafeInteger(event.tabId) && Number.isSafeInteger(event.frameId)
    && typeof event.url === 'string' && typeof event.timestamp === 'number';
}

async function restore(): Promise<void> {
  if (!sessionStorage) return;
  try {
    const stored = await sessionStorage.get(PAGE_LIFECYCLE_STORAGE_KEY);
    const values = stored[PAGE_LIFECYCLE_STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const entry of values.slice(-MAX_PERSISTED_TABS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'number' || !Array.isArray(entry[1])) continue;
      eventsByTab.set(entry[0], entry[1].filter(isLifecycleEvent).slice(-MAX_EVENTS_PER_TAB));
    }
  } catch {
    // Lifecycle tracking remains available in memory.
  }
}

const restored = restore();

function schedulePersist(): void {
  if (!sessionStorage || persistTimer) return;
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = undefined;
    void sessionStorage.set({ [PAGE_LIFECYCLE_STORAGE_KEY]: [...eventsByTab].slice(-MAX_PERSISTED_TABS) }).catch(() => undefined);
  }, 250);
}

async function record(
  kind: PageLifecycleEvent['kind'],
  details: { tabId: number; frameId: number; documentId?: string; url: string; timeStamp: number; transitionType?: string },
): Promise<void> {
  if (details.tabId < 0 || !/^(https?|about):/i.test(details.url)) return;
  await restored;
  const event: PageLifecycleEvent = {
    id: crypto.randomUUID(),
    kind,
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    url: details.url.slice(0, 8_192),
    timestamp: details.timeStamp,
    transitionType: details.transitionType,
  };
  eventsByTab.set(details.tabId, [...(eventsByTab.get(details.tabId) || []), event].slice(-MAX_EVENTS_PER_TAB));
  schedulePersist();
}

browser.webNavigation.onCommitted.addListener((details) => void record('document', details));
browser.webNavigation.onHistoryStateUpdated.addListener((details) => void record('history', details));
browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => void record('fragment', details));
browser.tabs.onRemoved.addListener((tabId) => {
  if (eventsByTab.delete(tabId)) schedulePersist();
});

export async function getPageLifecycle(tabId: number, frameId: number, documentId?: string): Promise<PageLifecycleEvent[]> {
  await restored;
  return (eventsByTab.get(tabId) || []).filter((event) => event.frameId === frameId
    && (!documentId || !event.documentId || event.documentId === documentId)).slice(-50);
}
