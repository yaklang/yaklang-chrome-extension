import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('wxt/browser', () => ({
  browser: { tabs: { sendMessage } },
}));

import { executeFirefoxPageRecorderCommand } from './bridge-client';
import { PAGE_RECORDER_BRIDGE_CHANNEL } from './bridge-protocol';

describe('Firefox page recorder bridge client', () => {
  beforeEach(() => sendMessage.mockReset());

  it('binds every command to the selected frame and returns the page result', async () => {
    sendMessage.mockResolvedValue({ id: 'response-1', ok: true, result: { active: true } });

    await expect(executeFirefoxPageRecorderCommand(
      { tabId: 7, frameId: 3 },
      'status',
    )).resolves.toEqual({ active: true });
    expect(sendMessage).toHaveBeenCalledWith(7, {
      channel: PAGE_RECORDER_BRIDGE_CHANNEL,
      command: 'status',
      input: {},
    }, { frameId: 3 });
  });

  it('fails closed when the page bridge rejects a command', async () => {
    sendMessage.mockResolvedValue({ id: 'response-2', ok: false, error: '页面录制器尚未就绪' });

    await expect(executeFirefoxPageRecorderCommand(
      { tabId: 8, frameId: 0 },
      'transform.execute',
      { profileId: 'profile-1' },
    )).rejects.toMatchObject({ code: 'recorder_unavailable', message: '页面录制器尚未就绪' });
  });
});
