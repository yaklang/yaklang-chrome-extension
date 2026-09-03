import { browser } from 'wxt/browser';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import { getFrameInventory } from '@/features/page-context/frames';
import { activateTab, getTab, scheduleBrowserInstanceClose } from '@/platform/browser/targets';
import {
  createBrowserIsolationProof,
  deleteFirefoxContainerIdentity,
  inspectBrowserIsolation,
  listFirefoxContainerIdentities,
  openFirefoxContainerIdentity,
  openIncognitoIdentity,
} from '@/features/authorization-testing/isolation';
import { ExtensionError } from '@/shared/errors';
import { assertBrowserAccessPolicy, getEnterprisePolicy } from '@/platform/policy/managed';
import { NAVIGATION_CAPABILITY_DOMAIN } from '../capability-domains';

export const navigationCapabilityHandler: CapabilityDomainHandler = {
  ...NAVIGATION_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.tabs') {
      const { tabs } = await inspectBrowserIsolation();
      const allowedOrigins = (await getEnterprisePolicy()).policy.grantAllowedOrigins;
      return tabs.filter((tab) => !allowedOrigins?.length || allowedOrigins.includes(new URL(tab.url).origin))
        .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active))
        || (right.lastAccessed || 0) - (left.lastAccessed || 0));
    }
    if (method === 'browser.tab.open') {
      const url = String(input.url || '');
      assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, { origin: new URL(url).origin });
      const tab = await browser.tabs.create({ url, active: true });
      if (!tab.id) throw new ExtensionError('target_unavailable', '浏览器没有返回新标签页 ID');
      await activateTab(tab.id);
      return { opened: true, id: tab.id, windowId: tab.windowId, active: true, url };
    }
    if (method === 'browser.thumbnail') {
      const tab = await getTab(typeof input.tabId === 'number' ? input.tabId : undefined);
      await allowedTarget(grant, { tabId: tab.id }, false);
      if (!tab.active) {
        throw new ExtensionError('target_not_active', '只能预览浏览器窗口当前可见的标签页');
      }
      return {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        capturedAt: Date.now(),
        dataUrl: await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 }),
      };
    }
    if (method === 'browser.frames') {
      const tabId = (await getTab(typeof input.tabId === 'number' ? input.tabId : undefined)).id;
      await allowedTarget(grant, { tabId }, false);
      const frames = await getFrameInventory(tabId);
      const allowedOrigins = (await getEnterprisePolicy()).policy.grantAllowedOrigins;
      return frames.filter((frame) => !allowedOrigins?.length
        || Boolean(frame.origin && allowedOrigins.includes(frame.origin)));
    }
    if (method === 'browser.instance.close') return scheduleBrowserInstanceClose();
    if (method === 'browser.isolation.inspect') {
      const requestedTabIds = Array.isArray(input.tabIds)
        ? input.tabIds.map(Number)
        : undefined;
      const inspection = await inspectBrowserIsolation(requestedTabIds);
      const allowedOrigins = (await getEnterprisePolicy()).policy.grantAllowedOrigins;
      if (!allowedOrigins?.length) return inspection;
      const tabs = inspection.tabs.filter((tab) => allowedOrigins.includes(new URL(tab.url).origin));
      const tabIds = new Set(tabs.map((tab) => tab.id));
      return {
        ...inspection,
        tabs,
        contexts: inspection.contexts
          .map((context) => ({ ...context, tabIds: context.tabIds.filter((tabId) => tabIds.has(tabId)) }))
          .filter((context) => context.tabIds.length > 0),
      };
    }
    if (method === 'browser.isolation.proof') {
      requireScope(grant, 'browser.cookies.read');
      requireScope(grant, 'browser.storage.read');
      const leftTabId = Number(input.leftTabId);
      const rightTabId = Number(input.rightTabId);
      await Promise.all([
        allowedTarget(grant, { tabId: leftTabId }, false),
        allowedTarget(grant, { tabId: rightTabId }, false),
      ]);
      return createBrowserIsolationProof(leftTabId, rightTabId);
    }
    if (method === 'browser.isolation.incognito.open') {
      assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, {
        origin: new URL(String(input.url || '')).origin,
      });
      return openIncognitoIdentity(String(input.url || ''));
    }
    if (method === 'browser.isolation.container.open') {
      assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, {
        origin: new URL(String(input.url || '')).origin,
      });
      return openFirefoxContainerIdentity({
        url: String(input.url || ''),
        name: typeof input.name === 'string' ? input.name : undefined,
      });
    }
    if (method === 'browser.isolation.container.list') {
      return listFirefoxContainerIdentities();
    }
    return deleteFirefoxContainerIdentity(String(input.cookieStoreId || ''));
  },
};
