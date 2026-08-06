import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserAgentAssignment } from '@/types/models';

const fixture = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  rules: [] as Array<{ id: number; [key: string]: unknown }>,
  failLocalSet: false,
  failDnrUpdate: false,
  updateDynamicRules: vi.fn(async (_input: { removeRuleIds?: number[]; addRules?: Array<{ id: number; [key: string]: unknown }> }) => undefined),
}));

function area(data: Record<string, unknown>, local = false) {
  return {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(items: Record<string, unknown>) {
      if (local && fixture.failLocalSet) {
        fixture.failLocalSet = false;
        throw new Error('local storage unavailable');
      }
      Object.assign(data, structuredClone(items));
    },
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: area(fixture.local, true),
      session: area(fixture.session),
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return structuredClone(fixture.rules);
      },
      updateDynamicRules: fixture.updateDynamicRules,
    },
  },
}));

import { DEFAULT_STATE, getState, setState } from '@/platform/storage/state';
import {
  applyUserAgentToSite,
  deleteUserAgentProfile,
  reconcileUserAgentRuntime,
  saveUserAgentProfile,
} from './user-agent-service';
import {
  BUILTIN_USER_AGENT_PROFILE_IDS,
  MAX_USER_AGENT_ASSIGNMENTS,
} from '@/shared/user-agent-state';
import { BUILTIN_USER_AGENT_PROFILES } from './user-agent-profiles';

function assignment(index: number): UserAgentAssignment {
  return {
    id: `assignment-${index}`,
    hostname: `host-${index}.example.test`,
    profileId: 'chrome-windows',
    createdAt: index + 1,
    updatedAt: index + 1,
  };
}

describe('atomic User-Agent settings', () => {
  beforeEach(async () => {
    for (const key of Object.keys(fixture.local)) delete fixture.local[key];
    for (const key of Object.keys(fixture.session)) delete fixture.session[key];
    fixture.rules.length = 0;
    fixture.failLocalSet = false;
    fixture.failDnrUpdate = false;
    vi.clearAllMocks();
    fixture.updateDynamicRules.mockImplementation(async ({ removeRuleIds = [], addRules = [] }) => {
      if (fixture.failDnrUpdate) {
        fixture.failDnrUpdate = false;
        throw new Error('DNR rejected the ruleset');
      }
      const removed = new Set(removeRuleIds);
      fixture.rules = [
        ...fixture.rules.filter((rule) => !removed.has(rule.id)),
        ...structuredClone(addRules),
      ];
    });
    await setState(structuredClone(DEFAULT_STATE));
  });

  it('keeps the shared builtin-id contract synchronized with the actual catalog', () => {
    expect(BUILTIN_USER_AGENT_PROFILES.map((profile) => profile.id)).toEqual(BUILTIN_USER_AGENT_PROFILE_IDS);
  });

  it('commits DNR and persistent state together for a site assignment', async () => {
    const state = await applyUserAgentToSite('https://app.example.test/login', 'safari-iphone');

    expect(state.userAgentAssignments).toHaveLength(1);
    expect((await getState()).userAgentAssignments[0]).toMatchObject({
      hostname: 'app.example.test',
      profileId: 'safari-iphone',
    });
    expect(fixture.rules).toHaveLength(1);
    expect(fixture.rules[0]).toMatchObject({
      action: { requestHeaders: [{ header: 'user-agent', operation: 'set' }] },
      condition: { urlFilter: '||app.example.test^' },
    });
  });

  it('does not persist a site assignment when DNR rejects the new rules', async () => {
    fixture.failDnrUpdate = true;

    await expect(applyUserAgentToSite('https://failed.example.test/', 'chrome-windows'))
      .rejects.toMatchObject({ code: 'ua_rules_apply_failed' });

    expect((await getState()).userAgentAssignments).toEqual([]);
    expect(fixture.rules).toEqual([]);
  });

  it('reconciles DNR back to authoritative storage when the state write fails', async () => {
    fixture.failLocalSet = true;

    await expect(applyUserAgentToSite('https://rollback.example.test/', 'chrome-windows'))
      .rejects.toMatchObject({ code: 'ua_state_commit_failed' });

    expect((await getState()).userAgentAssignments).toEqual([]);
    expect(fixture.rules).toEqual([]);
    expect(fixture.updateDynamicRules).toHaveBeenCalledTimes(2);
  });

  it('reports an explicit consistency error when authoritative DNR recovery also fails', async () => {
    fixture.failLocalSet = true;
    let updateCount = 0;
    fixture.updateDynamicRules.mockImplementation(async ({ removeRuleIds = [], addRules = [] }) => {
      updateCount += 1;
      if (updateCount === 2) throw new Error('DNR recovery unavailable');
      const removed = new Set(removeRuleIds);
      fixture.rules = [
        ...fixture.rules.filter((rule) => !removed.has(rule.id)),
        ...structuredClone(addRules),
      ];
    });

    await expect(applyUserAgentToSite('https://degraded.example.test/', 'chrome-windows'))
      .rejects.toMatchObject({ code: 'ua_consistency_restore_failed' });

    expect((await getState()).userAgentAssignments).toEqual([]);
    expect(fixture.rules).toHaveLength(1);
  });

  it('serializes concurrent site assignments without losing either rule', async () => {
    await Promise.all([
      applyUserAgentToSite('https://one.example.test/', 'chrome-windows'),
      applyUserAgentToSite('https://two.example.test/', 'safari-macos'),
    ]);

    const state = await getState();
    expect(state.userAgentAssignments.map((item) => item.hostname)).toEqual([
      'one.example.test',
      'two.example.test',
    ]);
    expect(fixture.rules).toHaveLength(2);
  });

  it('deletes a custom profile and all of its assignments in one transaction', async () => {
    const { profile } = await saveUserAgentProfile({ name: 'Fixture', userAgent: 'Fixture-UA/1.0' });
    await applyUserAgentToSite('https://custom.example.test/', profile.id);

    const state = await deleteUserAgentProfile(profile.id);

    expect(state.customUserAgentProfiles).toEqual([]);
    expect(state.userAgentAssignments).toEqual([]);
    expect(fixture.rules).toEqual([]);
  });

  it('reconciles stale owned rules on Service Worker startup without touching other DNR owners', async () => {
    fixture.rules = [
      { id: 20_000, priority: 1, stale: true },
      { id: 100, priority: 1, unrelated: true },
    ];

    await reconcileUserAgentRuntime();

    expect(fixture.rules).toEqual([{ id: 100, priority: 1, unrelated: true }]);
  });

  it('rejects the 5001st assignment before touching DNR or persistent state', async () => {
    const assignments = Array.from({ length: MAX_USER_AGENT_ASSIGNMENTS }, (_, index) => assignment(index));
    await setState({ ...structuredClone(DEFAULT_STATE), userAgentAssignments: assignments });
    fixture.updateDynamicRules.mockClear();

    await expect(applyUserAgentToSite('https://overflow.example.test/', 'chrome-windows'))
      .rejects.toThrow(`不能超过 ${MAX_USER_AGENT_ASSIGNMENTS} 条`);

    expect(fixture.updateDynamicRules).not.toHaveBeenCalled();
    expect((await getState()).userAgentAssignments).toHaveLength(MAX_USER_AGENT_ASSIGNMENTS);
  });
});
