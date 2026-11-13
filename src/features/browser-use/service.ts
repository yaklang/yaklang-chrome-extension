import { browser, type Browser } from 'wxt/browser';
import { actOnSharedPage, observeSharedPage, setSharedPageGrant } from '@/features/page-context/service';
import { getState } from '@/platform/storage/state';
import { ExtensionError, errorCode } from '@/shared/errors';
import { assertBrowserAccessPolicy, getEnterprisePolicy } from '@/platform/policy/managed';

declare const __YTRAY_BROWSER_PORT__: number;
const NATIVE_HOST = 'com.yaklang.ytray_browser_use' + (__YTRAY_BROWSER_PORT__ === 51374 ? '' : `.test_${__YTRAY_BROWSER_PORT__}`);
const ENROLLMENT_KEY = 'session.ytray-browser-use.v1';
const MANUAL_TABS_KEY = 'session.ytray-browser-use-manual-tabs.v1';
const RETRY_ALARM = 'ytray-browser-use-reconnect';
const instanceId = crypto.randomUUID();
type NativePort = ReturnType<typeof browser.runtime.connectNative>;

interface ManagedBrowser {
  instanceId: string;
  badge: string;
  ticket: string;
}

interface PageDocument {
  id: string;
  url: string;
  target: { tabId: number; frameId: number; documentId: string };
}

interface SharedPage {
  tabId: number;
  document: PageDocument;
  managed?: ManagedBrowser;
  pageId?: string;
  port?: NativePort;
  connected: boolean;
  navigating: boolean;
  documentEpoch: number;
}

const sharedPages = new Map<number, SharedPage>();
const manualOnlyTabs = new Set<number>();
const openingTabs = new Set<number>();
let managedBrowser: ManagedBrowser | undefined;
let instancePort: NativePort | undefined;
let instanceReady = false;
let instanceReconnectAfter = 0;
let nextConnection: ReturnType<typeof setTimeout> | undefined;
let reconnectAfter = 0;

function rememberManualTabs(): Promise<void> {
  return browser.storage.session?.set({ [MANUAL_TABS_KEY]: [...manualOnlyTabs] }) ?? Promise.resolve();
}

function shareChanged(tabId: number): void {
  void browser.runtime.sendMessage({ action: 'browser-use.share.changed', payload: { tabId } }).catch(() => undefined);
}

async function stopSharing(page: SharedPage): Promise<void> {
  const { tabId } = page;
  if (sharedPages.get(tabId) === page) {
    sharedPages.delete(tabId);
    shareChanged(tabId);
  }
  const port = page.port;
  page.port = undefined;
  page.connected = false;
  const clear = setSharedPageGrant(page.document.target, page.document, false).catch(() => undefined);
  try { port?.disconnect(); } catch { /* already disconnected */ }
  await clear;
}

export function browserUseShareStatus(tabId: number) {
  return {
    supported: !import.meta.env.FIREFOX,
    shared: sharedPages.get(tabId)?.connected === true,
    managed: managedBrowser !== undefined,
    paused: manualOnlyTabs.has(tabId),
  };
}

export async function revokeBrowserUseShare(tabId: number) {
  manualOnlyTabs.add(tabId);
  const page = sharedPages.get(tabId);
  if (page) await stopSharing(page);
  await rememberManualTabs();
  return browserUseShareStatus(tabId);
}

export async function shareBrowserUseTab(tabId: number, url: string) {
  if (import.meta.env.FIREFOX) throw new ExtensionError('unsupported_browser', 'YTray 浏览器控制目前支持 Chromium 浏览器');
  const tab = await browser.tabs.get(tabId);
  if (!tab.active || tab.url !== url) {
    throw new ExtensionError('stale_document', '请切到要共享的网页，等页面加载后再试');
  }
  manualOnlyTabs.delete(tabId);
  await rememberManualTabs();
  await shareTab(tab, tab.incognito ? undefined : managedBrowser);
  return browserUseShareStatus(tabId);
}

function canShare(url: string | undefined): url is string {
  if (!url || url.length > 8_192 || !/^https?:\/\//i.test(url)) return false;
  const parsed = new URL(url);
  return !parsed.username && !parsed.password;
}

async function tabVisibility(document: PageDocument): Promise<string> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId: document.target.tabId, documentIds: [document.target.documentId] },
    world: 'ISOLATED',
    func: () => globalThis.document.visibilityState,
  });
  return result?.result ?? 'unknown';
}

async function shareTab(tab: Browser.tabs.Tab, managed?: ManagedBrowser, openId?: string): Promise<SharedPage> {
  const { id: tabId, url } = tab;
  if (!tabId || tab.pendingUrl || !canShare(url)) {
    throw new ExtensionError('stale_document', '请等目标网页加载后再试');
  }
  const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
  if (frame?.url !== url || !frame.documentId || frame.documentLifecycle && frame.documentLifecycle !== 'active') {
    throw new ExtensionError('stale_document', '请等目标网页加载后再试');
  }
  assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, { origin: new URL(url).origin });
  if (openingTabs.has(tabId) && !openId) throw new ExtensionError('share_connecting', '正在连接目标标签页');
  if (managed && (managed !== managedBrowser || manualOnlyTabs.has(tabId))) {
    throw new ExtensionError('page_not_shared', '标签页已停止共享');
  }
  const previous = sharedPages.get(tabId);
  if (previous) {
    if (previous.connected && !openId) return previous;
    throw new ExtensionError('share_connecting', '正在连接 YTray');
  }
  const document: PageDocument = { id: crypto.randomUUID(), url, target: { tabId, frameId: 0, documentId: frame.documentId } };
  const page: SharedPage = {
    tabId, document, managed, connected: false, navigating: false, documentEpoch: 0,
  };
  sharedPages.set(tabId, page);
  try {
    const identity = managed ?? (await getState()).bridge.managedInstance;
    if (sharedPages.get(tabId) !== page) throw new ExtensionError('page_not_shared', '标签页已停止共享');
    const port = browser.runtime.connectNative(NATIVE_HOST);
    page.port = port;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new ExtensionError('ytray_unavailable', '连接 YTray 超时，请检查浏览器控制 MCP 是否已开启')), 5_000);
      const complete = (error?: Error) => {
        clearTimeout(deadline);
        if (error) reject(error); else resolve();
      };
      port.onDisconnect.addListener(() => {
        const message = browser.runtime.lastError?.message;
        if (page.port === port && page.connected) {
          void stopSharing(page);
          if (page.managed) scheduleManagedTabs(2_000);
        }
        complete(new ExtensionError('ytray_unavailable', '无法连接 YTray，请先在 MCP 页开启浏览器控制' + (message ? `（${message}）` : '')));
      });
      port.onMessage.addListener((input: unknown) => {
        if (page.port !== port || !input || typeof input !== 'object') return;
        const message = input as Record<string, unknown>;
        if (message.type === 'rejected') {
          complete(new ExtensionError('browser_not_enrolled', '请从新版 YTray 重新启动此浏览器实例'));
        } else if (message.type === 'ready' && message.version === 1) {
          if (openId && typeof message.page_id !== 'string') {
            complete(new ExtensionError('protocol_mismatch', 'YTray 没有返回目标标签页 ID'));
            return;
          }
          page.pageId = typeof message.page_id === 'string' ? message.page_id : undefined;
          page.connected = true;
          shareChanged(tabId);
          complete();
        } else if (message.type === 'request' && page.connected && typeof message.id === 'string') {
          void answerRequest(page, port, message.id, message.method, message.params);
        }
      });
      try {
        port.postMessage({
          type: 'share',
          version: 1,
          host_port: __YTRAY_BROWSER_PORT__,
          instance_id: identity && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(identity.instanceId)
            ? identity.instanceId.toLowerCase() : instanceId,
          instance_label: identity?.badge || '',
          ...(managed ? { managed_ticket: managed.ticket } : {}),
          ...(openId ? { open_id: openId } : {}),
          url,
          title: (tab.title || '').slice(0, 1_000),
        });
      } catch (error) {
        complete(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return page;
  } catch (error) {
    if (managed && sharedPages.get(tabId) === page) reconnectAfter = Date.now() + 5_000;
    await stopSharing(page);
    throw error;
  }
}

async function openManagedTab(managed: ManagedBrowser, port: NativePort, id: string, input: unknown) {
  const url = (input as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || !canShare(url)) throw new ExtensionError('invalid_arguments', '请使用无凭据的 HTTP(S) 地址');
  const origin = new URL(url).origin;
  const policy = (await getEnterprisePolicy()).policy;
  assertBrowserAccessPolicy(policy, { origin });
  const requireConnection = () => {
    if (instancePort !== port || managedBrowser !== managed) throw new ExtensionError('instance_disconnected', '浏览器实例已断开');
  };
  requireConnection();
  // Reserve the exact tab before navigation so automatic enrollment cannot claim it first.
  const windows = (await browser.windows.getAll({ windowTypes: ['normal'] })).filter((window) => !window.incognito);
  const targetWindow = windows.find((window) => window.focused) ?? windows[0];
  requireConnection();
  const tab = targetWindow?.id !== undefined
    ? await browser.tabs.create({ windowId: targetWindow.id, url: 'about:blank', active: true })
    : (await browser.windows.create({ url: 'about:blank', type: 'normal', incognito: false }))?.tabs?.[0];
  if (!tab?.id || tab.incognito) throw new ExtensionError('target_unavailable', '无法在普通浏览器窗口中打开标签页');
  const tabId = tab.id;
  openingTabs.add(tabId);
  let navigationFailed = false;
  const onError = (event: { tabId: number; frameId: number }) => {
    if (event.tabId === tabId && event.frameId === 0) navigationFailed = true;
  };
  browser.webNavigation.onErrorOccurred.addListener(onError);
  try {
    requireConnection();
    await browser.tabs.update(tabId, { url });
    const deadline = performance.now() + 16_000;
    do {
      requireConnection();
      if (navigationFailed) throw new ExtensionError('navigation_failed', '目标标签页加载失败，请检查该浏览器实例的网络和页面');
      const current = await browser.tabs.get(tabId);
      if (!current.pendingUrl && canShare(current.url)) {
        const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
        if (frame?.url === current.url && frame.documentId && (!frame.documentLifecycle || frame.documentLifecycle === 'active')) {
          if (new URL(current.url).origin !== origin) {
            throw new ExtensionError('origin_changed', `目标标签页跳转到了 ${new URL(current.url).origin}。请在该页确认共享后再继续`);
          }
          requireConnection();
          const page = await shareTab(current, managed, id);
          requireConnection();
          if (!page.connected || !page.pageId) throw new ExtensionError('target_unavailable', '目标标签页已关闭或停止共享');
          return { page_id: page.pageId };
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    } while (performance.now() < deadline);
    throw new ExtensionError('navigation_timeout', '目标标签页未在规定时间内就绪，请检查该浏览器实例的页面');
  } catch (error) {
    // A failed explicit open must not accidentally enroll a redirected or unverified document.
    if (openingTabs.has(tabId)) pauseAutomaticAccess(tabId);
    throw error;
  } finally {
    openingTabs.delete(tabId);
    browser.webNavigation.onErrorOccurred.removeListener(onError);
  }
}

function connectManagedInstance(managed: ManagedBrowser): void {
  if (instancePort || instanceReconnectAfter > Date.now()) return;
  const port = browser.runtime.connectNative(NATIVE_HOST);
  instancePort = port;
  instanceReady = false;
  let rejected = false;
  const timeout = setTimeout(() => port.disconnect(), 5_000);
  const disconnect = () => {
    clearTimeout(timeout);
    if (instancePort !== port) return;
    instancePort = undefined;
    instanceReady = false;
    // Older YTray versions support only page connections. They can still use the old tools.
    instanceReconnectAfter = Date.now() + (rejected ? 30_000 : 2_000);
    scheduleManagedTabs(rejected ? 30_000 : 2_000);
  };
  port.onDisconnect.addListener(() => {
    void browser.runtime.lastError;
    disconnect();
  });
  port.onMessage.addListener((input: unknown) => {
    if (instancePort !== port || !input || typeof input !== 'object') return;
    const message = input as Record<string, unknown>;
    if (message.type === 'rejected') {
      rejected = true;
      disconnect();
      port.disconnect();
    } else if (message.type === 'ready' && message.version === 1) {
      clearTimeout(timeout);
      instanceReady = true;
    } else if (instanceReady && message.type === 'request' && message.method === 'open'
      && typeof message.id === 'string' && /^[0-9a-f]{32}$/.test(message.id)) {
      const { id } = message;
      void openManagedTab(managed, port, id, message.params).then(
        (result) => ({ type: 'response', id, result }),
        (error: unknown) => ({ type: 'response', id, error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) } }),
      ).then((reply) => {
        if (instancePort === port) port.postMessage(reply);
      }).catch(() => { disconnect(); port.disconnect(); });
    }
  });
  try {
    port.postMessage({ type: 'instance', version: 1, host_port: __YTRAY_BROWSER_PORT__, instance_id: managed.instanceId, managed_ticket: managed.ticket });
  } catch (error) {
    disconnect();
    port.disconnect();
    throw error;
  }
}

function requireCurrentPage(page: SharedPage, document: PageDocument): void {
  if (sharedPages.get(page.tabId) !== page) throw new ExtensionError('page_not_shared', '标签页已停止共享');
  if (page.navigating || page.document !== document) {
    throw new ExtensionError('stale_document', '网页正在跳转或已经更新，请重新观察');
  }
}

async function answerRequest(page: SharedPage, port: NativePort, id: string, method: unknown, input: unknown): Promise<void> {
  let response: object;
  try {
    const document = page.document;
    requireCurrentPage(page, document);
    const params = input as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ExtensionError('invalid_arguments', '工具参数必须为对象');
    let result;
    const frame = await browser.webNavigation.getFrame({ tabId: page.tabId, frameId: 0 });
    if (frame?.documentId !== document.target.documentId || frame.url !== document.url) {
      throw new ExtensionError('stale_document', '网页已更新，请重新观察');
    }
    assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, { origin: new URL(document.url).origin });
    requireCurrentPage(page, document);
    if (method === 'focus' || method === 'presentation') {
      if (method === 'focus') {
        const tab = await browser.tabs.get(page.tabId);
        const window = await browser.windows.get(tab.windowId);
        requireCurrentPage(page, document);
        await browser.tabs.update(page.tabId, { active: true });
        requireCurrentPage(page, document);
        if (window.state === 'minimized') await browser.windows.update(tab.windowId, { state: 'normal' });
        await browser.windows.update(tab.windowId, { focused: true });
      }
      // Poll from the extension worker. Chromium throttles timers inside an occluded page.
      let visibility = await tabVisibility(document);
      const deadline = performance.now() + (method === 'focus' ? 350 : 1_600);
      while (visibility !== 'visible' && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        requireCurrentPage(page, document);
        visibility = await tabVisibility(document);
      }
      requireCurrentPage(page, document);
      result = { status: 'activated', visibility };
    } else if (method === 'observe' && typeof params.capture_id === 'string') {
      if (!await setSharedPageGrant(document.target, document, true)) {
        throw new ExtensionError('stale_document', '网页已更新，请重新观察');
      }
      requireCurrentPage(page, document);
      try {
        result = await observeSharedPage(document.target, document, params.capture_id);
      } finally {
        if (sharedPages.get(page.tabId) !== page || page.navigating || page.document !== document) {
          await setSharedPageGrant(document.target, document, false).catch(() => undefined);
        }
      }
      requireCurrentPage(page, document);
    } else if (method === 'scroll' && typeof params.delta_y === 'number' && Number.isInteger(params.delta_y)
      && Math.abs(params.delta_y) <= 5_000 && params.delta_y !== 0) {
      if (!await setSharedPageGrant(document.target, document, true)) {
        throw new ExtensionError('stale_document', '网页已更新，请重新观察');
      }
      requireCurrentPage(page, document);
      result = await actOnSharedPage(document.target, document, { operation: 'scrollPage', deltaY: params.delta_y });
    } else if ((method === 'click' || method === 'type' || method === 'scroll')
      && typeof params.capture_id === 'string' && typeof params.node_id === 'string'
      && (method !== 'type' || (typeof params.text === 'string' && params.text.length <= 8_000))) {
      result = await actOnSharedPage(document.target, document, {
        captureId: params.capture_id,
        nodeId: params.node_id,
        operation: method === 'type' ? 'setValue' : method,
        value: method === 'type' ? params.text as string : undefined,
      });
    } else {
      throw new ExtensionError('invalid_arguments', '页面操作或参数无效');
    }
    response = { type: 'response', id, result };
  } catch (error) {
    const code = errorCode(error);
    response = { type: 'response', id, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
  if (page.port === port) {
    try { port.postMessage(response); }
    catch { void stopSharing(page); }
  }
}

function scheduleManagedTabs(delay = 0): void {
  if (!managedBrowser) return;
  if (nextConnection !== undefined) {
    if (delay > 0) return;
    clearTimeout(nextConnection);
  }
  nextConnection = setTimeout(() => {
    nextConnection = undefined;
    void connectManagedTabs().catch((error) => {
      if (errorCode(error) !== 'browser_not_enrolled') scheduleManagedTabs(5_000);
    });
  }, Math.max(delay, reconnectAfter - Date.now()));
}

async function connectManagedTabs(): Promise<void> {
  const managed = managedBrowser;
  if (!managed || !await browser.permissions.contains({ permissions: ['nativeMessaging'] })) return;
  connectManagedInstance(managed);
  const tabs = await browser.tabs.query({ active: true });
  if (managed !== managedBrowser) return;
  for (const tab of tabs) {
    if (!tab.id || tab.incognito || !canShare(tab.url) || manualOnlyTabs.has(tab.id) || openingTabs.has(tab.id) || sharedPages.has(tab.id)) continue;
    try { await shareTab(tab, managed); }
    catch (error) {
      if (!['stale_document', 'policy_denied', 'share_connecting', 'page_not_shared'].includes(errorCode(error))) throw error;
    }
    if (managed !== managedBrowser) return;
  }
}

export async function bindManagedBrowserUse(instanceId: string, badge: string, ticket?: string): Promise<void> {
  if (import.meta.env.FIREFOX || !browser.storage.session) return;
  const previous = managedBrowser;
  const id = instanceId.toLowerCase();
  managedBrowser = ticket
    ? previous?.instanceId === id && previous.ticket === ticket && previous.badge === badge
      ? previous : { instanceId: id, badge, ticket }
    : undefined;
  if (previous && previous !== managedBrowser) {
    const port = instancePort;
    instancePort = undefined;
    instanceReady = false;
    port?.disconnect();
    await Promise.all([...sharedPages.values()].filter((page) => page.managed).map(stopSharing));
  }
  if (managedBrowser) {
    reconnectAfter = 0;
    instanceReconnectAfter = 0;
    await browser.storage.session.set({ [ENROLLMENT_KEY]: managedBrowser });
    await browser.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
    scheduleManagedTabs();
  } else {
    await browser.storage.session.remove(ENROLLMENT_KEY);
    await browser.alarms.clear(RETRY_ALARM);
  }
}

function pauseAutomaticAccess(tabId: number): void {
  manualOnlyTabs.add(tabId);
  void rememberManualTabs().catch(() => undefined);
  const page = sharedPages.get(tabId);
  if (page) void stopSharing(page);
}

function navigationStarted(page: SharedPage): void {
  page.navigating = true;
  page.documentEpoch += 1;
  const document = page.document;
  void setSharedPageGrant(document.target, document, false).catch(() => undefined);
}

function navigationCommitted(page: SharedPage, url: string, documentId: string | undefined): void {
  if (!page.managed) {
    if (url !== page.document.url || documentId !== page.document.target.documentId) void stopSharing(page);
    return;
  }
  if (!documentId || !canShare(url) || new URL(url).origin !== new URL(page.document.url).origin) {
    pauseAutomaticAccess(page.tabId);
    return;
  }
  if (!page.navigating && page.document.url === url && page.document.target.documentId === documentId) return;
  navigationStarted(page);
  page.document = {
    id: crypto.randomUUID(), url, target: { tabId: page.tabId, frameId: 0, documentId },
  };
  const epoch = page.documentEpoch;
  // Publish invalidation before accepting another operation on the new document.
  try {
    page.port?.postMessage({ type: 'page_changed', url, title: '' });
  } catch {
    void stopSharing(page);
    scheduleManagedTabs(2_000);
    return;
  }
  page.navigating = false;
  void browser.tabs.get(page.tabId).then((tab) => {
    if (sharedPages.get(page.tabId) === page && page.documentEpoch === epoch && tab.url === url && tab.title) {
      page.port?.postMessage({ type: 'page_metadata', url, title: tab.title.slice(0, 1_000) });
    }
  }).catch(() => undefined);
  shareChanged(page.tabId);
}

export function initializeBrowserUse(): void {
  if (import.meta.env.FIREFOX) return;
  const stop = (tabId: number) => {
    const page = sharedPages.get(tabId);
    if (page) void stopSharing(page);
  };
  browser.tabs.onRemoved.addListener((tabId) => {
    openingTabs.delete(tabId);
    if (manualOnlyTabs.delete(tabId)) void rememberManualTabs().catch(() => undefined);
    stop(tabId);
  });
  browser.tabs.onReplaced.addListener((newTabId, oldTabId) => {
    if (manualOnlyTabs.delete(oldTabId) || sharedPages.has(oldTabId) || openingTabs.delete(oldTabId)) pauseAutomaticAccess(newTabId);
    stop(oldTabId);
  });
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id && tab.openerTabId && sharedPages.has(tab.openerTabId)) pauseAutomaticAccess(tab.id);
  });
  browser.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
    if (sharedPages.has(sourceTabId)) pauseAutomaticAccess(tabId);
  });
  browser.tabs.onActivated.addListener(() => scheduleManagedTabs());
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    const page = sharedPages.get(tabId);
    if (!page && (change.url !== undefined || change.status === 'complete')) scheduleManagedTabs();
    if (page && !page.managed && change.url !== undefined && change.url !== page.document.url) stop(tabId);
    if (page?.managed && !page.navigating && tab.url === page.document.url && change.title !== undefined) {
      try {
        page.port?.postMessage({ type: 'page_metadata', url: page.document.url, title: change.title.slice(0, 1_000) });
      } catch { /* disconnect listener clears the connection */ }
    }
  });
  browser.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
    const page = sharedPages.get(tabId);
    if (!page || frameId !== 0) return;
    if (page.managed) navigationStarted(page); else void stopSharing(page);
  });
  const committed = ({ tabId, frameId, url, documentId }: { tabId: number; frameId: number; url: string; documentId?: string }) => {
    if (frameId !== 0) return;
    const page = sharedPages.get(tabId);
    if (page) navigationCommitted(page, url, documentId);
    else scheduleManagedTabs();
  };
  browser.webNavigation.onCommitted.addListener(committed);
  browser.webNavigation.onHistoryStateUpdated.addListener(committed);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(committed);
  browser.webNavigation.onErrorOccurred.addListener(({ tabId, frameId }) => {
    const page = sharedPages.get(tabId);
    if (!page?.managed || !page.navigating || frameId !== 0) return;
    void browser.webNavigation.getFrame({ tabId, frameId }).then((frame) => {
      if (frame && sharedPages.get(tabId) === page && page.navigating) {
        navigationCommitted(page, frame.url, frame.documentId);
      }
    }).catch(() => undefined);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) scheduleManagedTabs();
  });
  void browser.storage.session?.get([ENROLLMENT_KEY, MANUAL_TABS_KEY]).then((stored) => {
    const enrollment = stored[ENROLLMENT_KEY] as ManagedBrowser | undefined;
    if (enrollment && !managedBrowser) {
      for (const tabId of stored[MANUAL_TABS_KEY] as number[] ?? []) manualOnlyTabs.add(tabId);
      managedBrowser = enrollment;
      scheduleManagedTabs();
    }
  }).catch(() => undefined);
}
