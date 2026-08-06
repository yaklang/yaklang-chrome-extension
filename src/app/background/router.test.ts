import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import type { BackgroundRequestHandler } from './router';
import { dispatchBackgroundHandlers } from './router';

describe('background domain router', () => {
  it('stops at the first domain that owns an action', async () => {
    const first: BackgroundRequestHandler = vi.fn(async () => undefined);
    const second: BackgroundRequestHandler = vi.fn(async () => ({ ok: true, data: 'handled' }));
    const third: BackgroundRequestHandler = vi.fn(async () => ({ ok: true, data: 'wrong' }));
    const request = { action: 'state.get' as const };
    const sender = {} as Browser.runtime.MessageSender;

    await expect(dispatchBackgroundHandlers(request, sender, [first, second, third]))
      .resolves.toEqual({ ok: true, data: 'handled' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).not.toHaveBeenCalled();
  });

  it('returns undefined when no domain owns the action', async () => {
    const handler: BackgroundRequestHandler = vi.fn(async () => undefined);
    await expect(dispatchBackgroundHandlers(
      { action: 'state.get' },
      {} as Browser.runtime.MessageSender,
      [handler],
    )).resolves.toBeUndefined();
  });
});
