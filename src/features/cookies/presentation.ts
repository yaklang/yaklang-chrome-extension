import type { BrowserCookie, CookieRemoveInput } from '@/types/models';

export function cookieKey(cookie: BrowserCookie): string {
  return `${cookie.storeId}:${cookie.partitionKey?.topLevelSite || ''}:${cookie.domain}:${cookie.path}:${cookie.name}`;
}

export function cookieRequestUrl(cookie: BrowserCookie): string {
  const domain = cookie.domain.replace(/^\./, '');
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`;
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`;
}

export function cookieRemovalInput(cookie: BrowserCookie): CookieRemoveInput {
  return {
    url: cookieRequestUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
    firstPartyDomain: cookie.firstPartyDomain,
    partitionKey: cookie.partitionKey,
  };
}
