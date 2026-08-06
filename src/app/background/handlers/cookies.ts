import type { BackgroundRequestHandler } from '../router';
import { ok } from '../response';
import { targetTabId } from '../request-context';
import { listCookies, removeCookie, setCookie } from '@/features/cookies/service';
import { exportCookies, importCookies } from '@/features/cookies/transfer';
import { resolveTabCookieStoreId } from '@/platform/browser/isolation';
import { ExtensionError } from '@/shared/errors';

async function requestCookieStoreId(
  tabId: number | undefined,
  sender: Parameters<BackgroundRequestHandler>[1],
): Promise<string> {
  const target = targetTabId(tabId, sender);
  if (!target) {
    throw new ExtensionError('target_unavailable', '请选择一个可访问的 HTTP(S) 标签页');
  }
  return resolveTabCookieStoreId(target);
}

export const handleCookieRequest: BackgroundRequestHandler = async (request, sender) => {
  switch (request.action) {
    case 'cookie.list': return ok(await listCookies(
      request.payload.url,
      await requestCookieStoreId(request.payload.tabId, sender),
    ));
    case 'cookie.set': {
      const { tabId, ...input } = request.payload;
      return ok(await setCookie({
        ...input,
        storeId: await requestCookieStoreId(tabId, sender),
      }));
    }
    case 'cookie.remove':
      await removeCookie(request.payload);
      return ok();
    case 'cookie.removeMany': {
      const results = await Promise.allSettled(
        request.payload.cookies.map((cookie) => removeCookie(cookie)),
      );
      const removed = results.filter((result) => result.status === 'fulfilled').length;
      return ok({ removed, failed: results.length - removed });
    }
    case 'cookie.import': return ok(await importCookies(
      request.payload.url,
      request.payload.format,
      request.payload.text,
      await requestCookieStoreId(request.payload.tabId, sender),
    ));
    case 'cookie.export': return ok(exportCookies(
      await listCookies(
        request.payload.url,
        await requestCookieStoreId(request.payload.tabId, sender),
      ),
      request.payload.format,
      request.payload.includeValues,
    ));
    default: return undefined;
  }
};
