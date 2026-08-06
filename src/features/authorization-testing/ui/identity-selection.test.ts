import { describe, expect, it } from 'vitest';
import {
  authorizationIdentityOptionDisabledReason,
  normalizeAuthorizationIdentityTabSelection,
} from './identity-selection';

describe('normalizeAuthorizationIdentityTabSelection', () => {
  it('moves the only surviving persisted page to identity A', () => {
    expect(normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: [22],
      activeTabId: 22,
      leftTabId: 11,
      rightTabId: 22,
    })).toEqual({
      leftTabId: 22,
      rightTabId: undefined,
    });
  });

  it('clears stale selections without visually falling back to another page', () => {
    expect(normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: [],
      leftTabId: 11,
      rightTabId: 22,
    })).toEqual({
      leftTabId: undefined,
      rightTabId: undefined,
    });
  });

  it('keeps two different valid user selections', () => {
    expect(normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: [11, 22],
      activeTabId: 22,
      leftTabId: 11,
      rightTabId: 22,
    })).toEqual({
      leftTabId: 11,
      rightTabId: 22,
    });
  });

  it('uses the active page for A while preserving a different B page', () => {
    expect(normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: [11, 22],
      activeTabId: 11,
      leftTabId: 99,
      rightTabId: 22,
    })).toEqual({
      leftTabId: 11,
      rightTabId: 22,
    });
  });

  it('does not automatically treat a second ordinary tab as identity B', () => {
    expect(normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: [11, 22],
      activeTabId: 11,
    })).toEqual({
      leftTabId: 11,
      rightTabId: undefined,
    });
  });
});

describe('authorizationIdentityOptionDisabledReason', () => {
  it('disables the exact page already assigned to the other identity', () => {
    expect(authorizationIdentityOptionDisabledReason({
      candidateTabId: 11,
      candidateIsolationContextId: 'profile:normal',
      otherTabId: 11,
      otherIsolationContextId: 'profile:normal',
      otherLabel: '身份 A',
    })).toBe('已用于身份 A');
  });

  it('disables another page that shares the other identity login context', () => {
    expect(authorizationIdentityOptionDisabledReason({
      candidateTabId: 22,
      candidateIsolationContextId: 'profile:normal',
      otherTabId: 11,
      otherIsolationContextId: 'profile:normal',
      otherLabel: '身份 A',
    })).toBe('与身份 A 共享登录态');
  });

  it('keeps pages from another isolation context selectable', () => {
    expect(authorizationIdentityOptionDisabledReason({
      candidateTabId: 22,
      candidateIsolationContextId: 'profile:incognito',
      otherTabId: 11,
      otherIsolationContextId: 'profile:normal',
      otherLabel: '身份 A',
    })).toBeUndefined();
  });
});
