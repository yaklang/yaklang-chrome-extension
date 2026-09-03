import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  getTab: vi.fn(),
  updateTab: vi.fn(),
  getWindow: vi.fn(),
  getAllWindows: vi.fn(),
  updateWindow: vi.fn(),
  removeWindow: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { get: fixture.getTab, update: fixture.updateTab },
    windows: {
      get: fixture.getWindow,
      getAll: fixture.getAllWindows,
      update: fixture.updateWindow,
      remove: fixture.removeWindow,
    },
  },
}));

import { activateTab, scheduleBrowserInstanceClose } from './targets';

describe('browser window actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('restores a minimized window before bringing it to the front', async () => {
    fixture.getTab.mockResolvedValue({ id: 7, windowId: 3 });
    fixture.getWindow.mockResolvedValue({ id: 3, state: 'minimized' });

    await activateTab(7);

    expect(fixture.updateTab).toHaveBeenCalledWith(7, { active: true });
    expect(fixture.updateWindow).toHaveBeenNthCalledWith(1, 3, { state: 'normal' });
    expect(fixture.updateWindow).toHaveBeenNthCalledWith(2, 3, { focused: true });
  });

  it('acknowledges the request before closing every window in the instance', async () => {
    vi.useFakeTimers();
    fixture.getAllWindows.mockResolvedValue([{ id: 3 }, { id: 4 }]);
    fixture.removeWindow.mockResolvedValue(undefined);

    await expect(scheduleBrowserInstanceClose()).resolves.toEqual({ closing: true, windowCount: 2 });
    expect(fixture.removeWindow).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fixture.removeWindow).toHaveBeenCalledTimes(2);
  });
});
