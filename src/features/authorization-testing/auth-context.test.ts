import { describe, expect, it } from 'vitest';
import type { BrowserCookie, PageContext, PageStorageEntry } from '@/types/models';
import { authenticationFingerprint } from './auth-fingerprint';
import { AUTHORIZATION_WORKSPACE_TTL_MS } from './lifetime';

function cookie(name: string, value: string): BrowserCookie {
  return {
    name,
    value,
    domain: 'example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: true,
    hostOnly: true,
    storeId: 'opaque-store',
  };
}

function storageEntry(key: string, value: string): PageStorageEntry {
  return {
    key,
    value,
    byteLength: value.length,
    authRelated: true,
    truncated: false,
  };
}

function context(cookies: BrowserCookie[], storage: PageStorageEntry[] = []): PageContext {
  return {
    cookies,
    document: {
      url: 'https://example.test/account',
      localStorage: {
        supported: true,
        entries: storage,
        totalEntries: storage.length,
        approximateBytes: 0,
        truncated: false,
      },
      sessionStorage: {
        supported: true,
        entries: [],
        totalEntries: 0,
        approximateBytes: 0,
        truncated: false,
      },
    },
  } as unknown as PageContext;
}

describe('authorization context fingerprint', () => {
  it('keeps authorization context available for human and Agent review', () => {
    expect(AUTHORIZATION_WORKSPACE_TTL_MS).toBe(30 * 60_000);
  });

  it('keeps raw Cookie and Storage values out of the canonical identity fingerprint', async () => {
    const signed: string[] = [];
    const signer = async (value: string) => {
      signed.push(value);
      return 'f'.repeat(64);
    };

    const fingerprint = await authenticationFingerprint(
      context(
        [cookie('session_id', 'cookie-secret-value')],
        [storageEntry('access_token', 'storage-secret-value')],
      ),
      signer,
    );
    const canonical = signed.at(-1) || '';

    expect(fingerprint).toBe(`hmac-sha256:${'f'.repeat(64)}`);
    expect(canonical).toContain('session_id');
    expect(canonical).toContain('access_token');
    expect(canonical).not.toContain('cookie-secret-value');
    expect(canonical).not.toContain('storage-secret-value');
  });

  it('fails closed instead of fingerprinting a truncated Cookie collection', async () => {
    const cookies = Array.from({ length: 501 }, (_, index) => cookie(`cookie-${index}`, 'value'));

    await expect(authenticationFingerprint(context(cookies), async () => 'f'.repeat(64)))
      .rejects.toThrow('超过 500 个 Cookie');
  });

  it('fails closed when the shared page-context Storage snapshot is incomplete', async () => {
    const pageContext = context([cookie('session_id', 'value')]);
    pageContext.document.localStorage!.truncated = true;

    await expect(authenticationFingerprint(pageContext, async () => 'f'.repeat(64)))
      .rejects.toThrow('localStorage 快照发生截断');
  });
});
