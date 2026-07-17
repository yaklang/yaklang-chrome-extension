import { browser } from 'wxt/browser';
import { installPageWorldBridge } from '@/features/page-context/content-bridge';
import { isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, BridgeStatus, ExtensionState } from '@/types/models';

const PANEL_IDLE_UNLOAD_MS = 60_000;

const shellCss = `
  :host { all: initial; position: fixed !important; inset: 0 !important; z-index: 2147483646 !important; pointer-events: none !important; }
  .floating-panel { position: fixed; width: 46px; height: 46px; transform: translateY(-50%); pointer-events: auto; transition: width .16s ease; }
  .floating-panel--left { left: 0; }
  .floating-panel--right { right: 0; }
  .floating-panel.is-expanded { width: min(326px, calc(100vw - 8px)); }
  .floating-panel__header { position: absolute; top: 0; z-index: 2; width: 46px; height: 46px; touch-action: none; }
  .floating-panel--left .floating-panel__header { left: 0; }
  .floating-panel--right .floating-panel__header { right: 0; }
  .floating-panel__brand { position: relative; width: 46px; height: 46px; padding: 0; display: grid; place-items: center; border: 1px solid #d7dce1; background: #fff; cursor: pointer; box-shadow: 0 8px 20px rgba(20,24,28,.18); transition: background-color .16s ease, box-shadow .16s ease; }
  .floating-panel__brand:hover { background: #f1f3f5; }
  :host([data-theme='dark']) .floating-panel__brand { border-color: #343a40; background: #1d232b; }
  :host([data-theme='dark']) .floating-panel__brand:hover { background: #262d36; }
  .floating-panel--left .floating-panel__brand { border-left: 0; border-radius: 0 23px 23px 0; }
  .floating-panel--right .floating-panel__brand { border-right: 0; border-radius: 23px 0 0 23px; }
  .floating-panel.is-expanded .floating-panel__brand { box-shadow: none; }
  .floating-panel__brand:focus-visible { outline: 2px solid #ee7815; outline-offset: -3px; }
  .floating-panel__brand img { width: 42px; height: 42px; display: block; object-fit: contain; pointer-events: none; }
  .floating-panel__signal { position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border: 1px solid #fff; border-radius: 50%; background: #90979e; }
  :host([data-theme='dark']) .floating-panel__signal { border-color: #1d232b; }
  .floating-panel__signal.connected { background: #45b77d; }
  .floating-panel__signal.connecting, .floating-panel__signal.negotiating { background: #e3a632; }
  .floating-panel__signal.error { background: #dc5e5e; }
  iframe { width: 100%; height: 320px; display: block; border: 0; border-radius: 8px; box-shadow: 0 10px 28px rgba(22,28,33,.18); }
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
    header.append(launcher);
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
    let idleTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let drag: { pointerId: number; startX: number; startY: number; moved: boolean } | undefined;

    const setBridgeStatus = (status: BridgeStatus) => {
      signal.className = `floating-panel__signal ${status.state}`;
    };
    const siteAllowed = (next: ExtensionState) => {
      const origin = location.origin;
      if (next.floatingPanel.siteMode === 'allowlist') return next.floatingPanel.siteOrigins.includes(origin);
      if (next.floatingPanel.siteMode === 'denylist') return !next.floatingPanel.siteOrigins.includes(origin);
      return true;
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
      const taskTargetsPage = Boolean(
        next.activeGrant && next.activeGrant.expiresAt > Date.now()
        && currentTab && next.activeGrant.targets.some((target) => target.tabId === currentTab!.id),
      );
      const hasPageHandoff = Boolean(
        next.handoff?.state === 'waiting_for_user' && next.handoff.target.tabId === currentTab?.id,
      );
      const visible = next.floatingPanel.enabled && siteAllowed(next)
        && (next.floatingPanel.displayMode === 'always' || taskTargetsPage || hasPageHandoff);
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
      frame.src = `${browser.runtime.getURL('/floating.html')}?tabId=${currentTab?.id || ''}`;
      panel.prepend(frame);
    };
    const unloadFrame = () => {
      frame?.remove();
      frame = undefined;
    };
    function collapse() {
      expanded = false;
      panel.classList.remove('is-expanded');
      launcher.setAttribute('aria-label', '展开 Yakit Browser Agent');
      if (idleTimer) globalThis.clearTimeout(idleTimer);
      idleTimer = globalThis.setTimeout(unloadFrame, PANEL_IDLE_UNLOAD_MS);
    }
    const expand = () => {
      if (idleTimer) globalThis.clearTimeout(idleTimer);
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
    applyState(initialState);
    setBridgeStatus(initialBridge);

    launcher.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      const side = event.clientX < innerWidth / 2 ? 'left' : 'right';
      const y = Math.min(Math.max(event.clientY / innerHeight, 0.08), 0.92);
      panel.classList.toggle('floating-panel--left', side === 'left');
      panel.classList.toggle('floating-panel--right', side === 'right');
      panel.style.top = `${y * 100}%`;
    });
    launcher.addEventListener('pointerup', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = undefined;
      if (moved) {
        const side = event.clientX < innerWidth / 2 ? 'left' : 'right';
        const y = Math.min(Math.max(event.clientY / innerHeight, 0.08), 0.92);
        void send<ExtensionState>('panel.update', { side, y }).then(applyState).catch(() => undefined);
      } else if (expanded) collapse(); else expand();
    });

    const onStorageChange = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) void send<ExtensionState>('state.get').then(applyState).catch(() => undefined);
      if (themeKey in changes) applyTheme((changes[themeKey] as { newValue?: { theme?: string } } | undefined)?.newValue?.theme);
    };
    const onRuntimeMessage = (message: unknown) => {
      const input = message as { action?: string; payload?: BridgeStatus };
      if (input?.action === 'bridge.status.changed' && input.payload) setBridgeStatus(input.payload);
    };
    const onFrameMessage = (event: MessageEvent) => {
      const data = event.data as { channel?: string; type?: string; height?: number };
      if (event.source !== frame?.contentWindow || data?.channel !== 'yakit-floating-host') return;
      if (data.type === 'collapse') collapse();
      if (data.type === 'resize' && typeof data.height === 'number' && frame) {
        frame.style.height = `${Math.min(Math.max(Math.ceil(data.height), 160), Math.min(480, innerHeight - 16))}px`;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!state?.floatingPanel.shortcutEnabled || !event.altKey || !event.shiftKey || event.code !== 'KeyY') return;
      if (host.style.display === 'none') return;
      event.preventDefault();
      if (expanded) collapse(); else expand();
    };
    const onFullscreenChange = () => {
      if (state?.floatingPanel.autoCollapseFullscreen && document.fullscreenElement) collapse();
    };
    const onResize = () => requestAnimationFrame(adjustForEdgeConflict);
    browser.storage.onChanged.addListener(onStorageChange);
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    globalThis.addEventListener('message', onFrameMessage);
    globalThis.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    globalThis.addEventListener('resize', onResize);
    ctx.onInvalidated(() => {
      if (idleTimer) globalThis.clearTimeout(idleTimer);
      browser.storage.onChanged.removeListener(onStorageChange);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
      globalThis.removeEventListener('message', onFrameMessage);
      globalThis.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      globalThis.removeEventListener('resize', onResize);
      host.remove();
    });
  },
});
