import { browser } from 'wxt/browser';
import type { BridgeGrant, BrowserTarget, CapabilityScope } from '@/types/models';
import { getFrameInventory } from '@/features/page-context/frames';
import { getTab, resolveDocumentTarget } from '@/platform/browser/targets';
import { ExtensionError } from '@/shared/errors';
import { requireActiveGrant } from './lifecycle';

export type CapabilityEngineRequest = <T>(method: string, params: unknown) => Promise<T>;

export interface CapabilityRouteContext {
  method: string;
  input: Record<string, unknown>;
  grant: BridgeGrant;
  requestEngine?: CapabilityEngineRequest;
}

export interface CapabilityDomainHandler {
  id: string;
  owns(method: string): boolean;
  handle(context: CapabilityRouteContext): Promise<unknown>;
}

export async function activeGrant(required: CapabilityScope): Promise<BridgeGrant> {
  const grant = await requireActiveGrant();
  requireScope(grant, required);
  return grant;
}

function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

export async function allowedTarget(
  grant: BridgeGrant,
  input: { tabId?: unknown; frameId?: unknown; documentId?: unknown },
  resolveInPage = true,
): Promise<BrowserTarget> {
  const requested = typeof input.tabId === 'number' ? input.tabId : grant.targets[0]?.tabId;
  const requestedFrameId = typeof input.frameId === 'number' ? input.frameId : 0;
  const target = grant.targets.find((item) => (
    item.tabId === requested && item.frameId === requestedFrameId
  ));
  if (!target) throw new ExtensionError('target_denied', '目标标签页不在本次共享会话中');
  const currentTab = await getTab(target.tabId);
  if (!currentTab.isolationContextId
    || currentTab.isolationContextId !== target.isolationContextId
    || currentTab.cookieStoreId !== target.cookieStoreId) {
    throw new ExtensionError('isolation_stale', '目标标签页的身份隔离上下文已经变化，请重新共享页面');
  }
  const currentFrame = await browser.webNavigation.getFrame({
    tabId: target.tabId,
    frameId: target.frameId,
  });
  if (!currentFrame) throw new ExtensionError('target_unavailable', '目标 frame 已不存在');
  let currentOrigin = originOf(currentFrame.url);
  if (!currentOrigin) {
    currentOrigin = (await getFrameInventory(target.tabId))
      .find((frame) => frame.frameId === target.frameId)?.origin || '';
  }
  if (currentOrigin !== target.origin) {
    throw new ExtensionError('origin_changed', '目标 frame 已经跨来源导航，请重新授权');
  }
  if (target.documentId && currentFrame.documentId
    && target.documentId !== currentFrame.documentId) {
    throw new ExtensionError('stale_document', '目标 frame 已经刷新或导航，请重新授权');
  }
  if (typeof input.documentId === 'string' && target.documentId
    && input.documentId !== target.documentId) {
    throw new ExtensionError('stale_document', '请求的页面文档已经失效，请重新授权');
  }
  if (!resolveInPage) return target;
  const resolved = await resolveDocumentTarget(target);
  if (target.documentId && resolved.documentId && target.documentId !== resolved.documentId) {
    throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新授权');
  }
  return resolved;
}

export function requireScope(grant: BridgeGrant, scope: CapabilityScope): void {
  if (!grant.scopes.includes(scope)) {
    throw new ExtensionError('permission_denied', `共享会话未授权能力: ${scope}`);
  }
}
