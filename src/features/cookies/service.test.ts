import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  getAll: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    cookies: {
      getAll: fixture.getAll,
      set: fixture.set,
      remove: fixture.remove,
    },
  },
}));

import {
  cookieQueryCandidates,
  cookieRemoveDetails,
  cookieSetDetails,
  listCookies,
  removeCookie,
  setCookie,
} from './service';

function browserCookie(overrides: Record<string, unknown> = {}) {
  return {
    name: 'session',
    value: 'secret',
    domain: 'app.example.test',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
    expirationDate: 4_200_000_000,
    storeId: 'firefox-container-1',
    firstPartyDomain: '',
    partitionKey: {
      topLevelSite: 'https://top.example.test',
      hasCrossSiteAncestor: false,
    },
    ...overrides,
  };
}

describe('Cookie browser API semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.set.mockResolvedValue(browserCookie());
    fixture.getAll.mockResolvedValue([browserCookie()]);
    fixture.remove.mockResolvedValue({});
  });

  it('creates a HostOnly cookie by omitting domain and Firefox-only fields on Chrome', async () => {
    const result = await setCookie({
      url: 'https://app.example.test/',
      name: 'session',
      value: 'secret',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 4_200_000_000,
      storeId: 'firefox-container-1',
      firstPartyDomain: '',
      partitionKey: {
        topLevelSite: 'https://top.example.test',
        hasCrossSiteAncestor: false,
      },
    });

    const details = fixture.set.mock.calls[0][0];
    expect(details).not.toHaveProperty('domain');
    expect(details).not.toHaveProperty('firstPartyDomain');
    expect(details).toMatchObject({
      storeId: 'firefox-container-1',
      partitionKey: {
        topLevelSite: 'https://top.example.test',
        hasCrossSiteAncestor: false,
      },
    });
    expect(result).toMatchObject({
      hostOnly: true,
      firstPartyDomain: '',
      partitionKey: { topLevelSite: 'https://top.example.test', hasCrossSiteAncestor: false },
    });
  });

  it('creates a Domain cookie only when domain is explicitly supplied', async () => {
    fixture.set.mockResolvedValueOnce(browserCookie({ domain: '.example.test', hostOnly: false }));

    const result = await setCookie({
      url: 'https://example.test/',
      name: 'domain-session',
      value: 'secret',
      domain: '.example.test',
    });

    expect(fixture.set).toHaveBeenCalledWith(expect.objectContaining({ domain: '.example.test' }));
    expect(result.hostOnly).toBe(false);
  });

  it('keeps Firefox First-Party Domain fields inside the Firefox adapter branch', () => {
    const input = {
      url: 'https://app.example.test/',
      name: 'session',
      value: 'secret',
      firstPartyDomain: 'first-party.example.test',
      partitionKey: { topLevelSite: 'https://top.example.test' },
    };

    expect(cookieQueryCandidates(input.url, 'firefox-container-1', true)[0]).toEqual({
      url: input.url,
      storeId: 'firefox-container-1',
      firstPartyDomain: null,
      partitionKey: {},
    });
    expect(cookieSetDetails(input, true)).toMatchObject({
      firstPartyDomain: 'first-party.example.test',
      partitionKey: { topLevelSite: 'https://top.example.test' },
    });
    expect(cookieSetDetails(input, false)).not.toHaveProperty('firstPartyDomain');
    expect(cookieRemoveDetails({
      url: input.url,
      name: input.name,
      firstPartyDomain: input.firstPartyDomain,
    }, true)).toHaveProperty('firstPartyDomain', 'first-party.example.test');
    expect(cookieRemoveDetails({
      url: input.url,
      name: input.name,
      firstPartyDomain: input.firstPartyDomain,
    }, false)).not.toHaveProperty('firstPartyDomain');
  });

  it('requests Chrome partition variants without passing Firefox-only keys', async () => {
    const [cookie] = await listCookies('https://app.example.test/', 'firefox-container-1');

    expect(fixture.getAll).toHaveBeenCalledWith({
      url: 'https://app.example.test/',
      storeId: 'firefox-container-1',
      partitionKey: {},
    });
    expect(cookie).toMatchObject({
      storeId: 'firefox-container-1',
      firstPartyDomain: '',
      hostOnly: true,
      partitionKey: {
        topLevelSite: 'https://top.example.test',
        hasCrossSiteAncestor: false,
      },
    });
  });

  it('falls back for browsers that reject newer cookie query keys', async () => {
    fixture.getAll
      .mockRejectedValueOnce(new Error('Unexpected property partitionKey'))
      .mockResolvedValueOnce([browserCookie({ partitionKey: undefined })]);

    await expect(listCookies('https://app.example.test/', '0')).resolves.toHaveLength(1);

    expect(fixture.getAll.mock.calls).toEqual([
      [{ url: 'https://app.example.test/', storeId: '0', partitionKey: {} }],
      [{ url: 'https://app.example.test/', storeId: '0' }],
    ]);
  });

  it('surfaces a host-permission failure after exhausting compatibility queries', async () => {
    fixture.getAll.mockRejectedValue(new Error('Missing host permission for the tab'));

    await expect(listCookies('https://private.example.test/', '0'))
      .rejects.toThrow('Missing host permission');

    expect(fixture.getAll).toHaveBeenCalledTimes(2);
  });

  it('does not report success when the browser rejects or drops a Cookie write', async () => {
    fixture.set.mockRejectedValueOnce(new Error('cookies permission denied'));
    await expect(setCookie({
      url: 'https://private.example.test/',
      name: 'session',
      value: 'secret',
    })).rejects.toThrow('cookies permission denied');

    fixture.set.mockResolvedValueOnce(null);
    await expect(setCookie({
      url: 'https://private.example.test/',
      name: 'session',
      value: 'secret',
    })).rejects.toThrow('Cookie 写入失败');
  });

  it('distinguishes a successful removal from a missing Cookie and permission denial', async () => {
    await expect(removeCookie({
      url: 'https://app.example.test/',
      name: 'session',
      storeId: 'firefox-container-1',
    })).resolves.toBeUndefined();

    fixture.remove.mockResolvedValueOnce(null);
    await expect(removeCookie({
      url: 'https://app.example.test/',
      name: 'missing',
    })).rejects.toThrow('Cookie 不存在或删除失败');

    fixture.remove.mockRejectedValueOnce(new Error('cookies permission denied'));
    await expect(removeCookie({
      url: 'https://app.example.test/',
      name: 'session',
    })).rejects.toThrow('cookies permission denied');
  });
});
