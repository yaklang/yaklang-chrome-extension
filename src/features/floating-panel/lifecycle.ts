import { browser } from 'wxt/browser';

interface FloatingTabChangedMessage {
  action: 'floating.tab.changed';
  payload: { tabId: number; title?: string; url?: string };
}

let initialized = false;
const pendingTabs = new Map<number, ReturnType<typeof globalThis.setTimeout>>();

async function notifyTab(tabId: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) return;
    const message: FloatingTabChangedMessage = {
      action: 'floating.tab.changed',
      payload: {
        tabId,
        title: tab.title || undefined,
        url: tab.url,
      },
    };
    await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The content script may have been destroyed by a committed navigation.
    // The new document initializes from tab.active, so this is not an error.
  }
}

function scheduleTabNotification(tabId: number): void {
  const previous = pendingTabs.get(tabId);
  if (previous !== undefined) globalThis.clearTimeout(previous);
  pendingTabs.set(tabId, globalThis.setTimeout(() => {
    pendingTabs.delete(tabId);
    void notifyTab(tabId);
  }, 40));
}

export function initializeFloatingPanelLifecycle(): void {
  if (initialized) return;
  initialized = true;
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url !== undefined || change.title !== undefined || change.status === 'complete') {
      scheduleTabNotification(tabId);
    }
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) scheduleTabNotification(details.tabId);
  });
  browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId === 0) scheduleTabNotification(details.tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    const timer = pendingTabs.get(tabId);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    pendingTabs.delete(tabId);
  });
}
