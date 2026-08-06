import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveTabInfo, ExtensionState, FloatingPanelPreferences } from '@/types/models';
import {
  createLazyUnloadController,
  floatingPanelVisible,
  isFloatingPanelShortcut,
  mergeFloatingTabUpdate,
  resolvePanelPlacement,
  shouldCollapseForFullscreen,
} from './host-controller';

const preferences: FloatingPanelPreferences = {
  enabled: true,
  side: 'right',
  y: 0.46,
  displayMode: 'always',
  siteMode: 'all',
  siteOrigins: [],
  shortcutEnabled: true,
  autoCollapseFullscreen: true,
};

const tab: ActiveTabInfo = {
  id: 7,
  windowId: 1,
  title: 'Before',
  url: 'https://example.test/before',
  incognito: false,
  isolationContextId: 'browser-profile:default',
};

function state(overrides: Partial<ExtensionState> = {}): ExtensionState {
  return {
    version: 7,
    proxyProfiles: [],
    proxyRules: [],
    proxyRuleSources: [],
    proxyRouting: { defaultProfileId: 'direct', failMode: 'closed' },
    proxyRuntime: { dirty: false, compiledBytes: 0, manualRuleCount: 0, sourceRuleCount: 0, warnings: [] },
    activeProxyId: 'direct',
    customUserAgentProfiles: [],
    userAgentAssignments: [],
    bridge: {
      transport: 'websocket', nativeHost: 'com.yaklang.browser_agent',
      endpoint: 'ws://127.0.0.1:64333/extension', autoConnect: false, installationId: 'fixture-installation',
    },
    floatingPanel: preferences,
    ...overrides,
  };
}

describe('floating panel host controller', () => {
  beforeEach(() => vi.useRealTimers());

  it('updates URL and title for the same SPA tab without changing its isolation identity', () => {
    expect(mergeFloatingTabUpdate(tab, {
      tabId: tab.id,
      title: 'Account · 42',
      url: 'https://example.test/account/42',
    })).toEqual({
      ...tab,
      title: 'Account · 42',
      url: 'https://example.test/account/42',
    });
    expect(mergeFloatingTabUpdate(tab, { tabId: 9, title: 'Another tab' })).toBe(tab);
    expect(mergeFloatingTabUpdate(tab, { tabId: tab.id, url: 'chrome://settings' })).toBe(tab);
  });

  it('applies all, allowlist, denylist and active-task visibility policies', () => {
    expect(floatingPanelVisible(state(), tab, 'https://example.test')).toBe(true);
    expect(floatingPanelVisible(state({ floatingPanel: { ...preferences, siteMode: 'allowlist', siteOrigins: [] } }), tab, 'https://example.test')).toBe(false);
    expect(floatingPanelVisible(state({ floatingPanel: { ...preferences, siteMode: 'allowlist', siteOrigins: ['https://example.test'] } }), tab, 'https://example.test')).toBe(true);
    expect(floatingPanelVisible(state({ floatingPanel: { ...preferences, siteMode: 'denylist', siteOrigins: ['https://example.test'] } }), tab, 'https://example.test')).toBe(false);
    expect(floatingPanelVisible(state({ floatingPanel: { ...preferences, displayMode: 'active-task' } }), tab, 'https://example.test')).toBe(false);
    expect(floatingPanelVisible(state({
      floatingPanel: { ...preferences, displayMode: 'active-task' },
      activeGrant: {
        id: 'grant-1', taskId: 'task-1', createdAt: 1, expiresAt: 20_000,
        scopes: [], targets: [{
          tabId: tab.id, frameId: 0, isolationContextId: 'browser-profile:default',
          origin: 'https://example.test', grantedUrl: tab.url, title: 'Fixture',
        }],
      },
    }), tab, 'https://example.test', 10_000)).toBe(true);
  });

  it('clamps drag placement and snaps to the nearest side', () => {
    expect(resolvePanelPlacement(10, -100, 1_000, 800)).toEqual({ side: 'left', y: 0.08 });
    expect(resolvePanelPlacement(999, 2_000, 1_000, 800)).toEqual({ side: 'right', y: 0.92 });
    expect(resolvePanelPlacement(400, 320, 1_000, 800)).toEqual({ side: 'left', y: 0.4 });
  });

  it('does not steal the keyboard shortcut from editable controls or key repeat', () => {
    const event = { altKey: true, shiftKey: true, code: 'KeyY', repeat: false };
    expect(isFloatingPanelShortcut(preferences, event, false)).toBe(true);
    expect(isFloatingPanelShortcut(preferences, event, true)).toBe(false);
    expect(isFloatingPanelShortcut(preferences, { ...event, repeat: true }, false)).toBe(false);
    expect(shouldCollapseForFullscreen(preferences, true)).toBe(true);
    expect(shouldCollapseForFullscreen({ ...preferences, autoCollapseFullscreen: false }, true)).toBe(false);
  });

  it('cancels and replaces lazy iframe unload timers deterministically', () => {
    vi.useFakeTimers();
    const unload = vi.fn();
    const controller = createLazyUnloadController(60_000, unload);
    controller.schedule();
    vi.advanceTimersByTime(30_000);
    controller.schedule();
    vi.advanceTimersByTime(30_001);
    expect(unload).not.toHaveBeenCalled();
    controller.cancel();
    vi.advanceTimersByTime(60_000);
    expect(unload).not.toHaveBeenCalled();
    controller.schedule();
    vi.advanceTimersByTime(60_000);
    expect(unload).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
