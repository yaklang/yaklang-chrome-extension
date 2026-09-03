import { describe, expect, it, vi } from 'vitest';
import type { BridgeGrant } from '@/types/models';

const fixture = vi.hoisted(() => ({
  access: vi.fn(async (): Promise<BridgeGrant> => ({
    id: 'paired-browser-instance',
    taskId: 'paired-browser-instance',
    targets: [],
    scopes: ['browser.dom.read'],
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  })),
  dispatch: vi.fn(async () => ({ ok: true })),
}));

vi.mock('wxt/browser', () => ({
  browser: { runtime: { getManifest: () => ({ version: '1.0.0' }) } },
}));
vi.mock('./capability-context', () => ({
  browserInstanceAccess: fixture.access,
}));
vi.mock('./capability-router', () => ({
  dispatchCapability: fixture.dispatch,
}));

import { routeCapability } from './service';

describe('paired browser capability routing', () => {
  it('routes page access through the paired instance without an active page grant', async () => {
    await expect(routeCapability('browser.context', { includeDom: true })).resolves.toEqual({ ok: true });
    expect(fixture.access).toHaveBeenCalledWith('browser.dom.read');
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'browser.context',
      input: { includeDom: true },
    }));
  });
});
