import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  updatedListeners: [] as Array<(tabId: number, change: { url?: string; title?: string; status?: string }) => void>,
  historyListeners: [] as Array<(details: { tabId: number; frameId: number }) => void>,
  fragmentListeners: [] as Array<(details: { tabId: number; frameId: number }) => void>,
  removedListeners: [] as Array<(tabId: number) => void>,
  tabs: new Map<number, { id: number; url: string; title: string }>(),
  sendMessage: vi.fn(async () => undefined),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = fixture.tabs.get(tabId);
        if (!tab) throw new Error('missing tab');
        return tab;
      }),
      sendMessage: fixture.sendMessage,
      onUpdated: { addListener: vi.fn((listener: typeof fixture.updatedListeners[number]) => fixture.updatedListeners.push(listener)) },
      onRemoved: { addListener: vi.fn((listener: typeof fixture.removedListeners[number]) => fixture.removedListeners.push(listener)) },
    },
    webNavigation: {
      onHistoryStateUpdated: { addListener: vi.fn((listener: typeof fixture.historyListeners[number]) => fixture.historyListeners.push(listener)) },
      onReferenceFragmentUpdated: { addListener: vi.fn((listener: typeof fixture.fragmentListeners[number]) => fixture.fragmentListeners.push(listener)) },
    },
  },
}));

import { initializeFloatingPanelLifecycle } from './lifecycle';

describe('floating panel lifecycle relay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.tabs.clear();
    fixture.sendMessage.mockClear();
  });

  it('coalesces SPA URL and title changes into the current main-frame snapshot', async () => {
    initializeFloatingPanelLifecycle();
    fixture.tabs.set(8, { id: 8, url: 'https://example.test/account/2', title: 'Account 2' });
    for (const listener of fixture.historyListeners) listener({ tabId: 8, frameId: 0 });
    for (const listener of fixture.updatedListeners) listener(8, { title: 'Account 2' });
    await vi.advanceTimersByTimeAsync(41);

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenCalledWith(8, {
      action: 'floating.tab.changed',
      payload: { tabId: 8, title: 'Account 2', url: 'https://example.test/account/2' },
    }, { frameId: 0 });
  });

  it('ignores sub-frame navigation and cancels pending work when a tab closes', async () => {
    initializeFloatingPanelLifecycle();
    fixture.tabs.set(9, { id: 9, url: 'https://example.test/', title: 'Fixture' });
    for (const listener of fixture.fragmentListeners) listener({ tabId: 9, frameId: 2 });
    for (const listener of fixture.updatedListeners) listener(9, { url: 'https://example.test/#new' });
    for (const listener of fixture.removedListeners) listener(9);
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });
});
