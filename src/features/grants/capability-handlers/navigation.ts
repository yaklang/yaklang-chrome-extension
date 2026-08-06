import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import { getFrameInventory } from '@/features/page-context/frames';
import { getTab } from '@/platform/browser/targets';
import {
  createBrowserIsolationProof,
  deleteFirefoxContainerIdentity,
  inspectBrowserIsolation,
  listFirefoxContainerIdentities,
  openFirefoxContainerIdentity,
  openIncognitoIdentity,
} from '@/features/authorization-testing/isolation';
import { ExtensionError } from '@/shared/errors';
import { NAVIGATION_CAPABILITY_DOMAIN } from '../capability-domains';

export const navigationCapabilityHandler: CapabilityDomainHandler = {
  ...NAVIGATION_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.tabs') {
      const tabIds = [...new Set(grant.targets.map((target) => target.tabId))];
      const tabs = await Promise.all(tabIds.map(async (tabId) => {
        const targets = grant.targets.filter((target) => target.tabId === tabId);
        for (const target of targets) {
          try {
            await allowedTarget(grant, {
              tabId,
              frameId: target.frameId,
              documentId: target.documentId,
            });
            return getTab(tabId);
          } catch {
            // A tab remains visible while at least one explicitly granted frame is current.
          }
        }
        return undefined;
      }));
      return tabs.filter(Boolean);
    }
    if (method === 'browser.frames') {
      const tabId = typeof input.tabId === 'number' ? input.tabId : grant.targets[0]?.tabId;
      if (!tabId || !grant.targets.some((target) => target.tabId === tabId)) {
        throw new ExtensionError('target_denied', '目标标签页不在本次共享会话中');
      }
      return getFrameInventory(tabId);
    }
    if (method === 'browser.isolation.inspect') {
      const grantedTabIds = [...new Set(grant.targets.map((target) => target.tabId))];
      const requestedTabIds = Array.isArray(input.tabIds)
        ? input.tabIds.map(Number)
        : grantedTabIds;
      if (requestedTabIds.some((tabId) => !grantedTabIds.includes(tabId))) {
        throw new ExtensionError(
          'target_denied',
          '身份隔离检查只能读取本次共享会话中的标签页',
        );
      }
      return inspectBrowserIsolation(requestedTabIds);
    }
    if (method === 'browser.isolation.proof') {
      requireScope(grant, 'browser.cookies.read');
      requireScope(grant, 'browser.storage.read');
      const leftTabId = Number(input.leftTabId);
      const rightTabId = Number(input.rightTabId);
      if (![leftTabId, rightTabId].every((tabId) => (
        grant.targets.some((target) => target.tabId === tabId)
      ))) {
        throw new ExtensionError(
          'target_denied',
          '隔离证明的两个身份都必须在本次共享会话中',
        );
      }
      return createBrowserIsolationProof(leftTabId, rightTabId);
    }
    if (method === 'browser.isolation.incognito.open') {
      return openIncognitoIdentity(String(input.url || ''));
    }
    if (method === 'browser.isolation.container.open') {
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
