import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStore = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        async get(key: string) {
          return key in localStore ? { [key]: structuredClone(localStore[key]) } : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(localStore, structuredClone(values));
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localStore[key];
        },
      },
    },
  },
}));

import {
  MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES,
  clearBrowserTransformReplayDraft,
  deleteBrowserTransformReplayDrafts,
  getBrowserTransformReplayDraft,
  saveBrowserTransformReplayDraft,
} from './replay-draft';

const base = {
  profileId: 'profile-1',
  direction: 'request' as const,
  origin: 'https://example.test',
  method: 'POST',
  url: 'https://example.test/login',
  headers: '{"Content-Type":"application/json"}',
  body: '{"username":"admin","password":"123456"}',
  sample: { body: '{"username":"admin","password":"123456"}', label: '登录短时样本' },
};

describe('browser transform replay drafts', () => {
  beforeEach(() => {
    for (const key of Object.keys(localStore)) delete localStore[key];
  });

  it('persists request and response replay inputs independently', async () => {
    expect((await saveBrowserTransformReplayDraft(base)).status).toBe('saved');
    expect((await saveBrowserTransformReplayDraft({
      ...base,
      direction: 'response',
      method: 'GET',
      body: 'ciphertext',
      sample: undefined,
    })).status).toBe('saved');

    await expect(getBrowserTransformReplayDraft(base.profileId, 'request', base.origin)).resolves.toMatchObject({
      method: 'POST',
      body: base.body,
      sample: base.sample,
    });
    await expect(getBrowserTransformReplayDraft(base.profileId, 'response', base.origin)).resolves.toMatchObject({
      method: 'GET',
      body: 'ciphertext',
      sample: undefined,
    });
  });

  it('removes an older stored value instead of restoring stale data when the current draft is too large', async () => {
    await saveBrowserTransformReplayDraft(base);
    const result = await saveBrowserTransformReplayDraft({
      ...base,
      body: 'x'.repeat(MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES + 1),
      sample: undefined,
    });

    expect(result).toMatchObject({ status: 'too-large', maxBytes: MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES });
    await expect(getBrowserTransformReplayDraft(base.profileId, 'request', base.origin)).resolves.toBeUndefined();
  });

  it('does not restore a draft under a different page origin', async () => {
    await saveBrowserTransformReplayDraft(base);

    await expect(getBrowserTransformReplayDraft(base.profileId, 'request', 'https://other.test')).resolves.toBeUndefined();
    expect(Object.keys(localStore)).toHaveLength(0);
  });

  it('clears one direction or every draft associated with a deleted profile', async () => {
    await saveBrowserTransformReplayDraft(base);
    await saveBrowserTransformReplayDraft({ ...base, direction: 'response' });
    await clearBrowserTransformReplayDraft(base.profileId, 'request');

    await expect(getBrowserTransformReplayDraft(base.profileId, 'request', base.origin)).resolves.toBeUndefined();
    await expect(getBrowserTransformReplayDraft(base.profileId, 'response', base.origin)).resolves.toBeDefined();

    await deleteBrowserTransformReplayDrafts(base.profileId);
    expect(Object.keys(localStore)).toHaveLength(0);
  });

  it('serializes a clear behind an in-flight write for the same profile direction', async () => {
    const writing = saveBrowserTransformReplayDraft(base);
    const clearing = clearBrowserTransformReplayDraft(base.profileId, 'request');
    await Promise.all([writing, clearing]);

    await expect(getBrowserTransformReplayDraft(base.profileId, 'request', base.origin)).resolves.toBeUndefined();
  });
});
