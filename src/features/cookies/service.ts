import { browser } from 'wxt/browser';
import type { BrowserCookie, CookieInput, CookieRemoveInput } from '@/types/models';

function toCookie(cookie: Browser.cookies.Cookie): BrowserCookie {
  const extended = cookie as Browser.cookies.Cookie & {
    firstPartyDomain?: string;
    priority?: 'low' | 'medium' | 'high';
    sameParty?: boolean;
  };
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    storeId: cookie.storeId,
    firstPartyDomain: extended.firstPartyDomain || undefined,
    partitionKey: cookie.partitionKey,
    priority: extended.priority,
    sameParty: extended.sameParty,
  };
}

export async function listCookies(url: string): Promise<BrowserCookie[]> {
  const cookies = await browser.cookies.getAll({ url, partitionKey: {} }).catch(() => browser.cookies.getAll({ url }));
  return cookies.map(toCookie).sort((left, right) => left.name.localeCompare(right.name));
}

export async function setCookie(input: CookieInput): Promise<BrowserCookie> {
  const details = {
    url: input.url,
    name: input.name,
    value: input.value,
    domain: input.domain || undefined,
    path: input.path || '/',
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: input.sameSite || 'unspecified',
    expirationDate: input.expirationDate,
    storeId: input.storeId,
    ...(input.firstPartyDomain ? { firstPartyDomain: input.firstPartyDomain } : {}),
    partitionKey: input.partitionKey,
  } as Parameters<typeof browser.cookies.set>[0];
  const cookie = await browser.cookies.set(details);
  if (!cookie) throw new Error('Cookie 写入失败');
  return toCookie(cookie);
}

export async function removeCookie(input: CookieRemoveInput): Promise<void> {
  const result = await browser.cookies.remove(input);
  if (!result) throw new Error('Cookie 不存在或删除失败');
}
