import { browser } from 'wxt/browser';
import type { BrowserCookie, CookieInput, CookieRemoveInput } from '@/types/models';

type CookieGetAllDetails = Parameters<typeof browser.cookies.getAll>[0];
type CookieSetDetails = Parameters<typeof browser.cookies.set>[0];
type CookieRemoveDetails = Parameters<typeof browser.cookies.remove>[0];

export function cookieQueryCandidates(
  url: string,
  storeId: string | undefined,
  firefox: boolean,
): CookieGetAllDetails[] {
  const details = { url, ...(storeId ? { storeId } : {}) };
  return firefox
    ? [
      { ...details, firstPartyDomain: null, partitionKey: {} } as unknown as CookieGetAllDetails,
      { ...details, partitionKey: {} },
      details,
    ]
    : [{ ...details, partitionKey: {} }, details];
}

export function cookieSetDetails(input: CookieInput, firefox: boolean): CookieSetDetails {
  return {
    url: input.url,
    name: input.name,
    value: input.value,
    path: input.path || '/',
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: input.sameSite || 'unspecified',
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.expirationDate !== undefined ? { expirationDate: input.expirationDate } : {}),
    ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(firefox && input.firstPartyDomain !== undefined ? { firstPartyDomain: input.firstPartyDomain } : {}),
    ...(input.partitionKey ? { partitionKey: { ...input.partitionKey } } : {}),
  } as CookieSetDetails;
}

export function cookieRemoveDetails(input: CookieRemoveInput, firefox: boolean): CookieRemoveDetails {
  const { firstPartyDomain, ...shared } = input;
  return {
    ...shared,
    ...(firefox && firstPartyDomain !== undefined ? { firstPartyDomain } : {}),
  } as CookieRemoveDetails;
}

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
    firstPartyDomain: typeof extended.firstPartyDomain === 'string' ? extended.firstPartyDomain : undefined,
    partitionKey: cookie.partitionKey ? { ...cookie.partitionKey } : undefined,
    priority: extended.priority,
    sameParty: extended.sameParty,
  };
}

export async function listCookies(url: string, storeId?: string): Promise<BrowserCookie[]> {
  let cookies: Browser.cookies.Cookie[] | undefined;
  let lastError: unknown;
  for (const details of cookieQueryCandidates(url, storeId, import.meta.env.FIREFOX)) {
    try {
      cookies = await browser.cookies.getAll(details);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!cookies) throw lastError;
  return cookies.map(toCookie).sort((left, right) => left.name.localeCompare(right.name));
}

export async function setCookie(input: CookieInput): Promise<BrowserCookie> {
  const cookie = await browser.cookies.set(cookieSetDetails(input, import.meta.env.FIREFOX));
  if (!cookie) throw new Error('Cookie 写入失败');
  return toCookie(cookie);
}

export async function removeCookie(input: CookieRemoveInput): Promise<void> {
  const result = await browser.cookies.remove(cookieRemoveDetails(input, import.meta.env.FIREFOX));
  if (!result) throw new Error('Cookie 不存在或删除失败');
}
