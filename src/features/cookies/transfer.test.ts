import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  setCookie: vi.fn(async (input: unknown) => input),
}));

vi.mock('@/features/cookies/service', () => ({ setCookie: fixture.setCookie }));

import type { BrowserCookie, CookieInput } from '@/types/models';
import { buildCookieUrl, exportCookies, importCookies } from './transfer';

function cookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'session',
    value: 'secret-value',
    domain: 'app.example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: true,
    session: false,
    expirationDate: 4_200_000_000,
    sameSite: 'lax',
    storeId: 'firefox-container-1',
    firstPartyDomain: 'first-party.example.test',
    partitionKey: {
      topLevelSite: 'https://top.example.test',
      hasCrossSiteAncestor: false,
    },
    ...overrides,
  };
}

describe('Cookie transfer', () => {
  beforeEach(() => fixture.setCookie.mockClear());

  it('constructs a domain/path aware URL', () => {
    expect(buildCookieUrl('http://app.example.test/start', { domain: '.example.test', path: 'api', secure: true }))
      .toBe('https://example.test/api');
  });

  it('redacts exports unless values are explicitly requested', () => {
    expect(exportCookies([cookie()], 'json', false)).toContain('[REDACTED]');
    expect(exportCookies([cookie()], 'netscape', false)).not.toContain('secret-value');
    expect(exportCookies([cookie()], 'set-cookie', true)).toContain('session=secret-value');
  });

  it('round-trips a HostOnly JSON cookie without passing domain to the browser', async () => {
    const source = cookie();
    const result = await importCookies(
      'https://unrelated.example.test/',
      'json',
      exportCookies([source], 'json', true),
    );

    expect(result).toMatchObject({ imported: 1, failed: 0, warnings: [] });
    const input = fixture.setCookie.mock.calls[0][0] as CookieInput;
    expect(input).toMatchObject({
      url: 'https://app.example.test/',
      name: 'session',
      value: 'secret-value',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 4_200_000_000,
      storeId: 'firefox-container-1',
      firstPartyDomain: 'first-party.example.test',
      partitionKey: {
        topLevelSite: 'https://top.example.test',
        hasCrossSiteAncestor: false,
      },
    });
    expect(input).not.toHaveProperty('domain');
  });

  it('round-trips Domain and Session cookie semantics independently', async () => {
    const domainCookie = cookie({
      name: 'domain-cookie',
      domain: '.example.test',
      hostOnly: false,
      session: true,
      expirationDate: undefined,
      partitionKey: undefined,
      firstPartyDomain: undefined,
    });

    await importCookies('https://app.example.test/', 'json', exportCookies([domainCookie], 'json', true));

    const input = fixture.setCookie.mock.calls[0][0] as CookieInput;
    expect(input.domain).toBe('.example.test');
    expect(input.url).toBe('https://example.test/');
    expect(input.expirationDate).toBeUndefined();
  });

  it('uses the Netscape include-subdomains column to distinguish HostOnly and Domain cookies', async () => {
    const hostOnly = cookie({ firstPartyDomain: undefined, partitionKey: undefined, storeId: '0' });
    const domain = cookie({
      name: 'domain-cookie',
      domain: '.example.test',
      hostOnly: false,
      firstPartyDomain: undefined,
      partitionKey: undefined,
      storeId: '0',
    });
    const exported = exportCookies([hostOnly, domain], 'netscape', true);

    const result = await importCookies('https://app.example.test/', 'netscape', exported);

    expect(result).toMatchObject({ imported: 2, failed: 0 });
    expect(result.warnings.join(' ')).toContain('Netscape 格式不携带');
    const hostInput = fixture.setCookie.mock.calls[0][0] as CookieInput;
    const domainInput = fixture.setCookie.mock.calls[1][0] as CookieInput;
    expect(hostInput).not.toHaveProperty('domain');
    expect(hostInput.httpOnly).toBe(true);
    expect(hostInput.url).toBe('https://app.example.test/');
    expect(domainInput.domain).toBe('.example.test');
    expect(domainInput.url).toBe('https://example.test/');
  });

  it('explains Cookie Store remapping and unsupported browser attributes', async () => {
    const text = JSON.stringify([{
      ...cookie(),
      priority: 'high',
      sameParty: true,
    }]);

    const result = await importCookies('https://app.example.test/', 'json', text, 'firefox-container-2');

    expect(result.imported).toBe(1);
    expect(result.warnings.join(' ')).toContain('Priority/SameParty');
    expect(result.warnings.join(' ')).toContain('已映射到当前页面');
    expect(fixture.setCookie).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'firefox-container-2' }));
  });

  it('does not silently invent an invalid partition top-level site', async () => {
    const result = await importCookies('https://app.example.test/', 'json', JSON.stringify([{
      ...cookie(),
      partitionKey: { topLevelSite: 'file:///tmp/profile' },
    }]));

    expect(result.warnings.join(' ')).toContain('不是有效的 HTTP(S) 站点');
    expect(fixture.setCookie.mock.calls[0][0]).not.toHaveProperty('partitionKey');
  });
});
