import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activateTab: vi.fn(async () => undefined),
  getFrame: vi.fn(),
  getTab: vi.fn(),
  resolveDocumentTarget: vi.fn(),
  executeScript: vi.fn(),
  scriptingTarget: vi.fn((target) => target),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {},
    webNavigation: { getFrame: fixture.getFrame },
    scripting: { executeScript: fixture.executeScript },
  },
}));
vi.mock('@/platform/storage/state', () => ({
  getState: vi.fn(async () => structuredClone(fixture.state)),
  updateState: vi.fn(),
}));
vi.mock('@/platform/browser/targets', () => ({
  activateTab: fixture.activateTab,
  getTab: fixture.getTab,
  resolveDocumentTarget: fixture.resolveDocumentTarget,
  scriptingTarget: fixture.scriptingTarget,
}));

import { ExtensionError } from '@/shared/errors';
import { focusHandoff, getHandoffPresentation, isSafeHandoffPresentationDataUrl } from './service';

const grant = {
  id: 'paired-browser-instance',
  taskId: 'paired-browser-instance',
  targets: [],
  scopes: [],
  createdAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function waitingHandoff(origin = 'https://passport.example.test') {
  return {
    handoff: {
      id: 'handoff-1',
      taskId: 'paired-browser-instance',
      state: 'waiting_for_user',
      reason: 'qr_code',
      target: {
        tabId: 7,
        frameId: 0,
        documentId: 'document-old',
        origin,
        grantedUrl: `${origin}/login`,
        title: 'Sign in',
      },
    },
  };
}

describe('handoff presentation data URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.state = {};
  });

  it('accepts bounded raster data and rejects executable or oversized content', () => {
    expect(isSafeHandoffPresentationDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isSafeHandoffPresentationDataUrl('data:image/svg+xml,<svg onload="alert(1)"/>')).toBe(false);
    expect(isSafeHandoffPresentationDataUrl(`data:image/png;base64,${'AAAA'.repeat(350_000)}`)).toBe(false);
  });

  it('focuses only the waiting handoff owned by the local paired task', async () => {
    fixture.state = {
      handoff: {
        id: 'handoff-1',
        taskId: 'paired-browser-instance',
        state: 'waiting_for_user',
        target: { tabId: 7 },
      },
    };

    await expect(focusHandoff('handoff-1', grant)).resolves.toEqual({ focused: true, tabId: 7 });
    expect(fixture.activateTab).toHaveBeenCalledWith(7);
    await expect(focusHandoff('other-handoff', grant)).rejects.toMatchObject({ code: 'handoff_not_waiting' });
  });

  it('rebinds presentation reads after a same-origin document refresh', async () => {
    fixture.state = waitingHandoff();
    fixture.resolveDocumentTarget
      .mockRejectedValueOnce(new ExtensionError('stale_document', 'stale'))
      .mockResolvedValueOnce({ tabId: 7, frameId: 0, documentId: 'document-new' });
    fixture.getFrame.mockResolvedValue({ url: 'https://passport.example.test/login?refreshed=1' });
    fixture.getTab.mockResolvedValue({ id: 7 });
    fixture.executeScript.mockResolvedValue([]);

    await expect(getHandoffPresentation('handoff-1', grant)).resolves.toMatchObject({ state: 'not_found' });
    expect(fixture.resolveDocumentTarget).toHaveBeenLastCalledWith({ tabId: 7, frameId: 0 });
  });

  it('reports a changed page instead of leaking a stale-document error', async () => {
    fixture.state = waitingHandoff();
    fixture.resolveDocumentTarget.mockRejectedValueOnce(new ExtensionError('stale_document', 'stale'));
    fixture.getFrame.mockResolvedValue({ url: 'https://www.example.test/' });

    await expect(getHandoffPresentation('handoff-1', grant)).resolves.toMatchObject({ state: 'page_changed' });
    expect(fixture.resolveDocumentTarget).toHaveBeenCalledTimes(1);
  });
});
