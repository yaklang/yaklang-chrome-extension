import { browser } from 'wxt/browser';
import { installPageWorldBridge } from '@/features/page-context/content-bridge';
import { installPageRecorderBridge } from '@/features/browser-recording/content-bridge';
import { isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, BridgeStatus, ExtensionState } from '@/types/models';
import {
  createLazyUnloadController,
  floatingPanelVisible,
  isFloatingPanelShortcut,
  mergeFloatingTabUpdate,
  resolvePanelPlacement,
  shouldCollapseForFullscreen,
} from '@/features/floating-panel/host-controller';
import { createOpaqueId } from '@/shared/id';

const PANEL_IDLE_UNLOAD_MS = 60_000;

const shellCss = `
  :host { all: initial; position: fixed !important; inset: 0 !important; z-index: 2147483646 !important; pointer-events: none !important; }
  .floating-panel { position: fixed; width: 46px; height: 46px; transform: translateY(-50%); pointer-events: auto; transition: width .16s ease; }
  .floating-panel--left { left: 0; }
  .floating-panel--right { right: 0; }
  .floating-panel.is-expanded { width: min(326px, calc(100vw - 8px)); }
  .floating-panel__header { position: absolute; top: 0; z-index: 2; width: 46px; height: 46px; display: flex; align-items: center; overflow: hidden; border: 1px solid #d7dce1; background: #fff; color: #1d232b; box-sizing: border-box; touch-action: none; user-select: none; transition: width .16s ease; }
  .floating-panel--left .floating-panel__header { left: 0; }
  .floating-panel--right .floating-panel__header { right: 0; }
  .floating-panel.is-expanded .floating-panel__header { width: 100%; border-radius: 8px 8px 0 0; box-shadow: 0 7px 20px rgba(20,24,28,.14); }
  .floating-panel--right.is-expanded .floating-panel__header { flex-direction: row-reverse; }
  .floating-panel__brand { position: relative; width: 44px; height: 44px; flex: 0 0 44px; padding: 0; display: grid; place-items: center; border: 0; background: transparent; cursor: pointer; box-shadow: 0 8px 20px rgba(20,24,28,.18); transition: background-color .16s ease, box-shadow .16s ease; }
  .floating-panel__brand:hover { background: #f1f3f5; }
  :host([data-theme='dark']) .floating-panel__header { border-color: #343a40; background: #1d232b; color: #f1f3f5; }
  :host([data-theme='dark']) .floating-panel__brand { background: #1d232b; }
  :host([data-theme='dark']) .floating-panel__brand:hover { background: #262d36; }
  .floating-panel--left:not(.is-expanded) .floating-panel__header { border-left: 0; border-radius: 0 23px 23px 0; }
  .floating-panel--right:not(.is-expanded) .floating-panel__header { border-right: 0; border-radius: 23px 0 0 23px; }
  .floating-panel--left:not(.is-expanded) .floating-panel__brand { border-radius: 0 23px 23px 0; }
  .floating-panel--right:not(.is-expanded) .floating-panel__brand { border-radius: 23px 0 0 23px; }
  .floating-panel.is-expanded .floating-panel__brand { box-shadow: none; }
  .floating-panel__brand:focus-visible { outline: 2px solid #ee7815; outline-offset: -3px; }
  .floating-panel__brand img { width: 42px; height: 42px; display: block; object-fit: contain; pointer-events: none; }
  .floating-panel__signal { position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border: 1px solid #fff; border-radius: 50%; background: #90979e; }
  :host([data-theme='dark']) .floating-panel__signal { border-color: #1d232b; }
  .floating-panel__signal.connected { background: #45b77d; }
  .floating-panel__signal.connecting, .floating-panel__signal.negotiating { background: #e3a632; }
  .floating-panel__signal.error { background: #dc5e5e; }
  .floating-panel__title { min-width: 0; flex: 1; padding: 0 9px; display: none; }
  .floating-panel.is-expanded .floating-panel__title { display: grid; gap: 1px; }
  .floating-panel__title strong, .floating-panel__title span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: system-ui, sans-serif; }
  .floating-panel__title strong { font-size: 12px; line-height: 16px; font-weight: 650; }
  .floating-panel__title span { color: #697078; font-size: 10px; line-height: 14px; }
  :host([data-theme='dark']) .floating-panel__title span { color: #a7afb8; }
  .floating-panel__grip { width: 20px; flex: 0 0 20px; display: none; color: #90979e; font: 14px/1 system-ui, sans-serif; letter-spacing: -2px; }
  .floating-panel.is-expanded .floating-panel__grip { display: block; }
  iframe { width: 100%; height: 320px; margin-top: 46px; display: block; border: 0; border-radius: 0 0 8px 8px; box-shadow: 0 10px 28px rgba(22,28,33,.18); }
  .floating-panel:not(.is-expanded) iframe { visibility: hidden; pointer-events: none; }
`;

async function send<T>(action: string, payload?: unknown): Promise<T> {
  const response = await browser.runtime.sendMessage({ action, payload }) as { ok?: boolean; data?: T; error?: string };
  if (!response?.ok) throw new Error(response?.error || action);
  return response.data as T;
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',

  async main(ctx) {
    if (import.meta.env.FIREFOX) {
      await installPageRecorderBridge(ctx).catch((error) => {
        console.warn('[Yakit Browser Agent] Firefox page recorder bridge is unavailable.', error);
      });
    }
    if ((import.meta.env.FIREFOX && import.meta.env.MODE !== 'store')
      || (!import.meta.env.FIREFOX && import.meta.env.MODE !== 'production' && import.meta.env.MODE !== 'store')) {
      await installPageWorldBridge(ctx).catch((error) => {
        console.warn('[Yakit Browser Agent] MAIN-world bridge is unavailable; continuing without page Eval/Invoke.', error);
      });
    }

    const host = document.createElement('yakit-browser-agent');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = shellCss;
    const panel = document.createElement('div');
    panel.className = 'floating-panel floating-panel--right';
    const header = document.createElement('div');
    header.className = 'floating-panel__header';
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'floating-panel__brand';
    launcher.setAttribute('aria-label', '展开 Yakit Browser Agent');
    const logo = document.createElement('img');
    logo.src = browser.runtime.getURL('/yak.svg');
    logo.alt = 'Yak';
    logo.draggable = false;
    const signal = document.createElement('span');
    signal.className = 'floating-panel__signal disconnected';
    launcher.append(logo, signal);
    const headerTitle = document.createElement('span');
    headerTitle.className = 'floating-panel__title';
    const headerPageTitle = document.createElement('strong');
    const headerPageUrl = document.createElement('span');
    headerTitle.append(headerPageTitle, headerPageUrl);
    const grip = document.createElement('span');
    grip.className = 'floating-panel__grip';
    grip.textContent = '⠿';
    grip.setAttribute('aria-hidden', 'true');
    header.append(launcher, headerTitle, grip);
    panel.append(header);
    shadow.append(style, panel);
    document.documentElement.append(host);

    // Launcher theme follows the extension appearance setting (settings.appearance.v1), falling back to the OS scheme.
    const themeKey = 'settings.appearance.v1';
    const applyTheme = (theme?: string) => {
      host.dataset.theme = theme === 'light' || theme === 'dark'
        ? theme
        : (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    };
    void browser.storage.local.get(themeKey).then((stored) => {
      applyTheme((stored[themeKey] as { theme?: string } | undefined)?.theme);
    });

    let state: ExtensionState | undefined;
    let currentTab: ActiveTabInfo | undefined;
    let frame: HTMLIFrameElement | undefined;
    let expanded = false;
    let drag: { pointerId: number; startX: number; startY: number; moved: boolean } | undefined;
    const frameChannel = createOpaqueId('floating-channel');

    const setBridgeStatus = (status: BridgeStatus) => {
      signal.className = `floating-panel__signal ${status.state}`;
    };
    const updateHeaderPage = () => {
      headerPageTitle.textContent = currentTab?.title || document.title || '当前页面';
      headerPageTitle.title = headerPageTitle.textContent;
      headerPageUrl.textContent = currentTab?.url || location.href;
      headerPageUrl.title = headerPageUrl.textContent;
    };
    const postTabToFrame = () => {
      if (!frame?.contentWindow || !currentTab) return;
      frame.contentWindow.postMessage({
        channel: 'yakit-floating-host', token: frameChannel, type: 'tab.changed',
        tab: { tabId: currentTab.id, title: currentTab.title, url: currentTab.url },
      }, '*');
    };
    const applyTabUpdate = (update: { tabId: number; title?: string; url?: string }) => {
      const next = mergeFloatingTabUpdate(currentTab, update);
      if (next === currentTab) return;
      currentTab = next;
      updateHeaderPage();
      postTabToFrame();
      if (state) applyState(state);
    };
    const adjustForEdgeConflict = () => {
      if (host.style.display === 'none') return;
      const x = state?.floatingPanel.side === 'left' ? 8 : innerWidth - 8;
      const desiredY = (state?.floatingPanel.y || 0.46) * innerHeight;
      const previous = host.style.visibility;
      host.style.visibility = 'hidden';
      const behind = document.elementFromPoint(x, desiredY);
      host.style.visibility = previous;
      if (!behind) return;
      const position = getComputedStyle(behind).position;
      const bounds = behind.getBoundingClientRect();
      if (!['fixed', 'sticky'].includes(position) || bounds.width < 32 || bounds.height < 32) return;
      const offset = desiredY < innerHeight / 2 ? bounds.bottom + 30 : bounds.top - 30;
      panel.style.top = `${Math.min(Math.max(offset / innerHeight, 0.08), 0.92) * 100}%`;
    };
    const applyState = (next: ExtensionState) => {
      const previousHandoffId = state?.handoff?.state === 'waiting_for_user' ? state.handoff.id : undefined;
      state = next;
      const visible = floatingPanelVisible(next, currentTab, location.origin);
      host.style.display = visible ? '' : 'none';
      panel.classList.toggle('floating-panel--left', next.floatingPanel.side === 'left');
      panel.classList.toggle('floating-panel--right', next.floatingPanel.side === 'right');
      panel.style.top = `${next.floatingPanel.y * 100}%`;
      if (!visible) collapse();
      const nextHandoff = next.handoff?.state === 'waiting_for_user' && next.handoff.target.tabId === currentTab?.id
        ? next.handoff
        : undefined;
      if (nextHandoff && nextHandoff.id !== previousHandoffId) expand();
      requestAnimationFrame(adjustForEdgeConflict);
    };
    const ensureFrame = () => {
      if (frame) return;
      frame = document.createElement('iframe');
      frame.title = 'Yakit Browser Agent';
      frame.src = `${browser.runtime.getURL('/floating.html')}?tabId=${currentTab?.id || ''}&channel=${encodeURIComponent(frameChannel)}`;
      frame.addEventListener('load', postTabToFrame, { once: true });
      panel.prepend(frame);
    };
    const unloadFrame = () => {
      frame?.remove();
      frame = undefined;
    };
    const lazyUnload = createLazyUnloadController(PANEL_IDLE_UNLOAD_MS, unloadFrame);
    function collapse() {
      expanded = false;
      panel.classList.remove('is-expanded');
      launcher.setAttribute('aria-label', '展开 Yakit Browser Agent');
      lazyUnload.schedule();
    }
    const expand = () => {
      lazyUnload.cancel();
      ensureFrame();
      expanded = true;
      panel.classList.add('is-expanded');
      launcher.setAttribute('aria-label', '收起 Yakit Browser Agent');
    };

    const [initialState, initialTab, initialBridge] = await Promise.all([
      send<ExtensionState>('state.get'),
      send<ActiveTabInfo>('tab.active').catch(() => undefined),
      send<BridgeStatus>('bridge.status'),
    ]);
    currentTab = initialTab;
    updateHeaderPage();
    applyState(initialState);
    setBridgeStatus(initialBridge);

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      const { side, y } = resolvePanelPlacement(event.clientX, event.clientY, innerWidth, innerHeight);
      panel.classList.toggle('floating-panel--left', side === 'left');
      panel.classList.toggle('floating-panel--right', side === 'right');
      panel.style.top = `${y * 100}%`;
    });
    header.addEventListener('pointerup', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = undefined;
      if (moved) {
        const { side, y } = resolvePanelPlacement(event.clientX, event.clientY, innerWidth, innerHeight);
        void send<ExtensionState>('panel.update', { side, y }).then(applyState).catch(() => undefined);
      } else if (expanded) collapse(); else expand();
    });
    header.addEventListener('pointercancel', () => { drag = undefined; });

    const onStorageChange = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) void send<ExtensionState>('state.get').then(applyState).catch(() => undefined);
      if (themeKey in changes) applyTheme((changes[themeKey] as { newValue?: { theme?: string } } | undefined)?.newValue?.theme);
    };
    const onRuntimeMessage = (message: unknown) => {
      const input = message as { action?: string; payload?: unknown };
      if (input?.action === 'bridge.status.changed' && input.payload) setBridgeStatus(input.payload as BridgeStatus);
      if (input?.action === 'floating.tab.changed' && input.payload) {
        applyTabUpdate(input.payload as { tabId: number; title?: string; url?: string });
      }
    };
    const onFrameMessage = (event: MessageEvent) => {
      const data = event.data as { channel?: string; token?: string; type?: string; height?: number };
      if (event.source !== frame?.contentWindow || data?.channel !== 'yakit-floating-host' || data.token !== frameChannel) return;
      if (data.type === 'collapse') collapse();
      if (data.type === 'resize' && typeof data.height === 'number' && frame) {
        const availableHeight = Math.max(160, Math.min(480, innerHeight - 62));
        frame.style.height = `${Math.min(Math.max(Math.ceil(data.height), 160), availableHeight)}px`;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!state) return;
      const target = event.target as HTMLElement | null;
      const editable = Boolean(target?.isContentEditable || target?.closest('input, textarea, select, [contenteditable="true"]'));
      if (!isFloatingPanelShortcut(state.floatingPanel, event, editable)) return;
      if (host.style.display === 'none') return;
      event.preventDefault();
      if (expanded) collapse(); else expand();
    };
    const onFullscreenChange = () => {
      if (state && shouldCollapseForFullscreen(state.floatingPanel, Boolean(document.fullscreenElement))) collapse();
    };
    const onResize = () => requestAnimationFrame(adjustForEdgeConflict);
    const syncDocumentMetadata = () => {
      if (!currentTab) return;
      applyTabUpdate({ tabId: currentTab.id, title: document.title, url: location.href });
    };
    let titleObserver: MutationObserver | undefined;
    const installTitleObserver = () => {
      if (titleObserver || !document.head) return;
      titleObserver = new MutationObserver(syncDocumentMetadata);
      titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true });
      syncDocumentMetadata();
    };
    if (document.head) installTitleObserver();
    else document.addEventListener('DOMContentLoaded', installTitleObserver, { once: true });
    browser.storage.onChanged.addListener(onStorageChange);
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    globalThis.addEventListener('message', onFrameMessage);
    globalThis.addEventListener('keydown', onKeyDown, true);
    globalThis.addEventListener('popstate', syncDocumentMetadata);
    globalThis.addEventListener('hashchange', syncDocumentMetadata);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    globalThis.addEventListener('resize', onResize);
    ctx.onInvalidated(() => {
      lazyUnload.dispose();
      titleObserver?.disconnect();
      document.removeEventListener('DOMContentLoaded', installTitleObserver);
      browser.storage.onChanged.removeListener(onStorageChange);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
      globalThis.removeEventListener('message', onFrameMessage);
      globalThis.removeEventListener('keydown', onKeyDown, true);
      globalThis.removeEventListener('popstate', syncDocumentMetadata);
      globalThis.removeEventListener('hashchange', syncDocumentMetadata);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      globalThis.removeEventListener('resize', onResize);
      host.remove();
    });
  },
});
