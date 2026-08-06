import type { ActiveTabInfo, ExtensionState, FloatingPanelPreferences } from '@/types/models';

export interface FloatingTabUpdate {
  tabId: number;
  title?: string;
  url?: string;
}

export function mergeFloatingTabUpdate(
  current: ActiveTabInfo | undefined,
  update: FloatingTabUpdate,
): ActiveTabInfo | undefined {
  if (!current || current.id !== update.tabId) return current;
  const nextUrl = typeof update.url === 'string' && /^https?:/i.test(update.url)
    ? update.url.slice(0, 8_192)
    : current.url;
  const nextTitle = typeof update.title === 'string' && update.title.trim()
    ? update.title.trim().slice(0, 1_024)
    : current.title;
  if (nextUrl === current.url && nextTitle === current.title) return current;
  return { ...current, url: nextUrl, title: nextTitle };
}

export function floatingPanelVisible(
  state: ExtensionState,
  tab: ActiveTabInfo | undefined,
  pageOrigin: string,
  now = Date.now(),
): boolean {
  if (!state.floatingPanel.enabled) return false;
  const siteAllowed = state.floatingPanel.siteMode === 'allowlist'
    ? state.floatingPanel.siteOrigins.includes(pageOrigin)
    : state.floatingPanel.siteMode === 'denylist'
      ? !state.floatingPanel.siteOrigins.includes(pageOrigin)
      : true;
  if (!siteAllowed) return false;
  if (state.floatingPanel.displayMode === 'always') return true;
  const activeGrant = Boolean(state.activeGrant && state.activeGrant.expiresAt > now && tab
    && state.activeGrant.targets.some((target) => target.tabId === tab.id));
  const waitingHandoff = Boolean(state.handoff?.state === 'waiting_for_user' && tab
    && state.handoff.target.tabId === tab.id);
  return activeGrant || waitingHandoff;
}

export function resolvePanelPlacement(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): { side: 'left' | 'right'; y: number } {
  const safeWidth = Math.max(1, viewportWidth);
  const safeHeight = Math.max(1, viewportHeight);
  return {
    side: clientX < safeWidth / 2 ? 'left' : 'right',
    y: Math.min(Math.max(clientY / safeHeight, 0.08), 0.92),
  };
}

export function isFloatingPanelShortcut(
  preferences: FloatingPanelPreferences,
  input: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'code' | 'repeat'>,
  editableTarget: boolean,
): boolean {
  return preferences.shortcutEnabled
    && input.altKey
    && input.shiftKey
    && input.code === 'KeyY'
    && !input.repeat
    && !editableTarget;
}

export function shouldCollapseForFullscreen(
  preferences: FloatingPanelPreferences,
  fullscreenActive: boolean,
): boolean {
  return preferences.autoCollapseFullscreen && fullscreenActive;
}

export interface LazyUnloadController {
  schedule(): void;
  cancel(): void;
  dispose(): void;
}

export function createLazyUnloadController(
  delayMs: number,
  unload: () => void,
): LazyUnloadController {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = undefined;
  };
  return {
    schedule() {
      cancel();
      timer = globalThis.setTimeout(() => {
        timer = undefined;
        unload();
      }, Math.max(0, delayMs));
    },
    cancel,
    dispose: cancel,
  };
}
