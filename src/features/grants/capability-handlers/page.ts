import { browser } from 'wxt/browser';
import type { PageContextOptions } from '@/types/models';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import { activateTab } from '@/platform/browser/targets';
import {
  actOnPageNode,
  capturePageContext,
  evalInPage,
  inspectPageNode,
  invokePageFunction,
} from '@/features/page-context/service';
import { listCookies } from '@/features/cookies/service';
import { resolveTabCookieStoreId } from '@/platform/browser/isolation';
import { ExtensionError } from '@/shared/errors';
import { PAGE_CAPABILITY_DOMAIN } from '../capability-domains';

export const pageCapabilityHandler: CapabilityDomainHandler = {
  ...PAGE_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.context') {
      const options: PageContextOptions = {
        includeDom: input.includeDom !== false,
        includeStorage: input.includeStorage === true,
        includeCookies: input.includeCookies === true,
      };
      if (options.includeStorage) requireScope(grant, 'browser.storage.read');
      if (options.includeCookies) requireScope(grant, 'browser.cookies.read');
      return capturePageContext(options, await allowedTarget(grant, input));
    }
    if (method === 'browser.node.inspect') {
      const target = await allowedTarget(grant, input);
      return inspectPageNode(String(input.captureId), String(input.nodeId), target);
    }
    if (method === 'browser.node.action') {
      const target = await allowedTarget(grant, input);
      return actOnPageNode(
        String(input.captureId),
        String(input.nodeId),
        input.action as 'click' | 'focus' | 'scroll' | 'setValue',
        target,
        typeof input.value === 'string' ? input.value : undefined,
      );
    }
    if (method === 'browser.cookies') {
      const target = await allowedTarget(grant, input);
      const frame = await browser.webNavigation.getFrame({
        tabId: target.tabId,
        frameId: target.frameId,
      });
      const grantTarget = grant.targets.find((item) => (
        item.tabId === target.tabId && item.frameId === target.frameId
      ));
      const url = frame?.url && /^https?:/i.test(frame.url)
        ? frame.url
        : `${grantTarget?.origin || ''}/`;
      if (!/^https?:/i.test(url)) {
        throw new ExtensionError(
          'target_unavailable',
          '目标 frame 没有可读取 Cookie 的 HTTP 来源',
        );
      }
      return listCookies(url, await resolveTabCookieStoreId(target.tabId));
    }
    if (method === 'browser.takeover') {
      const target = await allowedTarget(grant, input);
      await activateTab(target.tabId);
      await browser.action.setBadgeBackgroundColor({ color: '#f28c28' });
      await browser.action.setBadgeText({ text: '接管', tabId: target.tabId });
      globalThis.setTimeout(
        () => void browser.action.setBadgeText({ text: '', tabId: target.tabId }),
        10_000,
      );
      return { activated: true, target };
    }
    if (method === 'browser.invoke') {
      if (typeof input.path !== 'string') throw new Error('缺少页面函数路径');
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000;
      return invokePageFunction(
        input.path,
        Array.isArray(input.args) ? input.args : [],
        await allowedTarget(grant, input),
        timeoutMs,
      );
    }
    if (typeof input.code !== 'string' || !input.code.trim()) {
      throw new Error('缺少页面执行代码');
    }
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000;
    return evalInPage(
      input.code,
      input.mode as 'expression' | 'program',
      await allowedTarget(grant, input),
      timeoutMs,
    );
  },
};
