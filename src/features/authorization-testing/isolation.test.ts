import { describe, expect, it } from 'vitest';
import type { ActiveTabInfo, BrowserIsolationContext } from '@/types/models';
import {
  activeTabInfo,
  applyTabLocalAuthenticationEvidence,
  buildIsolationProof,
  isolationContextForTab,
  type IsolationCookieStore,
  type IsolationTabDescriptor,
} from './isolation';

function tab(id: number, incognito: boolean, url = 'https://example.test/account'): IsolationTabDescriptor {
  return { id, windowId: incognito ? 2 : 1, title: incognito ? 'B' : 'A', url, incognito };
}

function asActive(
  descriptor: IsolationTabDescriptor,
  context: BrowserIsolationContext,
): ActiveTabInfo {
  return activeTabInfo(descriptor, context);
}

describe('browser identity isolation', () => {
  it('proves a Chromium regular/incognito pair with different opaque Cookie Stores', () => {
    const stores: IsolationCookieStore[] = [
      { id: 'opaque-regular', tabIds: [1, 3] },
      { id: 'opaque-private', tabIds: [2] },
    ];
    const leftDescriptor = tab(1, false);
    const rightDescriptor = tab(2, true);
    const leftContext = isolationContextForTab(leftDescriptor, stores, 'chromium');
    const rightContext = isolationContextForTab(rightDescriptor, stores, 'chromium');
    const proof = buildIsolationProof(
      asActive(leftDescriptor, leftContext),
      asActive(rightDescriptor, rightContext),
      [leftContext, rightContext],
      1_000,
      'proof-1',
    );

    expect(leftContext).toEqual(expect.objectContaining({
      kind: 'browser-profile',
      cookieStoreId: 'opaque-regular',
      tabIds: [1, 3],
    }));
    expect(rightContext).toEqual(expect.objectContaining({
      kind: 'chrome-incognito-store',
      cookieStoreId: 'opaque-private',
      incognito: true,
    }));
    expect(proof).toEqual(expect.objectContaining({
      id: 'proof-1',
      level: 'strong',
      cookieStoreRelation: 'different',
      sameOrigin: true,
      refreshCheck: 'not-required',
    }));
    expect(proof.expiresAt).toBe(1_000 + 30 * 60_000);
  });

  it('fails closed when two ordinary tabs share one Cookie Store', () => {
    const stores: IsolationCookieStore[] = [{ id: 'shared-store', tabIds: [1, 2] }];
    const leftDescriptor = tab(1, false);
    const rightDescriptor = tab(2, false);
    const leftContext = isolationContextForTab(leftDescriptor, stores, 'chromium');
    const rightContext = isolationContextForTab(rightDescriptor, stores, 'chromium');
    const proof = buildIsolationProof(
      asActive(leftDescriptor, leftContext),
      asActive(rightDescriptor, rightContext),
      [leftContext, rightContext],
      1_000,
      'proof-shared',
    );

    expect(leftContext.contextId).toBe(rightContext.contextId);
    expect(proof.level).toBe('none');
    expect(proof.cookieStoreRelation).toBe('same');
    expect(proof.reasons.join(' ')).toContain('不同 tabId 不代表不同登录态');
  });

  it('upgrades same-store tabs only when authentication is sessionStorage-local and distinct', () => {
    const stores: IsolationCookieStore[] = [{ id: 'shared-store', tabIds: [1, 2] }];
    const leftDescriptor = tab(1, false);
    const rightDescriptor = tab(2, false);
    const leftContext = isolationContextForTab(leftDescriptor, stores, 'chromium');
    const rightContext = isolationContextForTab(rightDescriptor, stores, 'chromium');
    const proof = buildIsolationProof(
      asActive(leftDescriptor, leftContext),
      asActive(rightDescriptor, rightContext),
      [leftContext, rightContext],
      1_000,
      'proof-tab-local',
    );

    const upgraded = applyTabLocalAuthenticationEvidence(
      proof,
      {
        origin: 'https://example.test',
        status: 'authenticated',
        authCookieNames: [],
        authLocalStorageKeys: [],
        authSessionStorageKeys: ['access_token'],
        fingerprint: 'left-fingerprint',
      },
      {
        origin: 'https://example.test',
        status: 'authenticated',
        authCookieNames: [],
        authLocalStorageKeys: [],
        authSessionStorageKeys: ['access_token'],
        fingerprint: 'right-fingerprint',
      },
    );

    expect(upgraded.level).toBe('conditional');
    expect(upgraded.accountEvidenceRelation).toBe('different');
    expect(upgraded.requestCredentialRelation).toBe('unknown');
    expect(upgraded.refreshCheck).toBe('passed');
  });

  it('keeps same-store tabs blocked when shared Cookie or localStorage carries authentication', () => {
    const stores: IsolationCookieStore[] = [{ id: 'shared-store', tabIds: [1, 2] }];
    const leftDescriptor = tab(1, false);
    const rightDescriptor = tab(2, false);
    const leftContext = isolationContextForTab(leftDescriptor, stores, 'chromium');
    const rightContext = isolationContextForTab(rightDescriptor, stores, 'chromium');
    const proof = buildIsolationProof(
      asActive(leftDescriptor, leftContext),
      asActive(rightDescriptor, rightContext),
      [leftContext, rightContext],
      1_000,
      'proof-shared-auth',
    );
    const shared = {
      origin: 'https://example.test',
      status: 'authenticated' as const,
      authCookieNames: ['session'],
      authLocalStorageKeys: ['auth'],
      authSessionStorageKeys: ['access_token'],
    };

    const blocked = applyTabLocalAuthenticationEvidence(
      proof,
      { ...shared, fingerprint: 'left' },
      { ...shared, fingerprint: 'right' },
    );

    expect(blocked.level).toBe('none');
    expect(blocked.reasons.join(' ')).toContain('共享 Cookie Store');
  });

  it('recognizes Firefox Container identities without hard-coding tab IDs', () => {
    const stores: IsolationCookieStore[] = [
      { id: 'firefox-container-12', tabIds: [7] },
      { id: 'firefox-container-29', tabIds: [8] },
    ];
    const leftDescriptor = { ...tab(7, false), cookieStoreId: 'firefox-container-12' };
    const rightDescriptor = { ...tab(8, false), cookieStoreId: 'firefox-container-29' };
    const leftContext = isolationContextForTab(leftDescriptor, stores, 'firefox', [{
      cookieStoreId: 'firefox-container-12',
      name: 'Yakit 身份 A',
      color: 'blue',
      icon: 'fingerprint',
      managed: true,
    }]);
    const rightContext = isolationContextForTab(rightDescriptor, stores, 'firefox');
    const proof = buildIsolationProof(
      asActive(leftDescriptor, leftContext),
      asActive(rightDescriptor, rightContext),
      [leftContext, rightContext],
      1_000,
      'proof-container',
    );

    expect(leftContext.kind).toBe('firefox-container');
    expect(leftContext.containerId).toBe('firefox-container-12');
    expect(leftContext).toEqual(expect.objectContaining({
      containerName: 'Yakit 身份 A',
      containerColor: 'blue',
      managed: true,
    }));
    expect(proof.level).toBe('strong');
  });

  it('does not invent isolation when Cookie Store resolution is unavailable', () => {
    const descriptor = tab(9, false);
    const context = isolationContextForTab(descriptor, [], 'chromium');

    expect(context.level).toBe('none');
    expect(context.cookieStoreId).toBeUndefined();
    expect(context.guarantees.cookies).toBe('unknown');
  });

  it('rejects assigning the same page to both identity slots', () => {
    const descriptor = tab(1, false);
    const context = isolationContextForTab(descriptor, [{ id: 'store', tabIds: [1] }], 'chromium');
    const active = asActive(descriptor, context);

    expect(() => buildIsolationProof(active, active, [context])).toThrow('不能选择同一个标签页');
  });
});
