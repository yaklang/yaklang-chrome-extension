import { browser } from 'wxt/browser';
import type { BridgeGrant, BrowserTarget, CapabilityScope } from '@/types/models';
import { getFrameInventory } from '@/features/page-context/frames';
import { getTab, resolveDocumentTarget } from '@/platform/browser/targets';
import { assertBrowserAccessPolicy, getEnterprisePolicy } from '@/platform/policy/managed';
import { CONTROL_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import { ExtensionError } from '@/shared/errors';

export type CapabilityEngineRequest = <T>(method: string, params: unknown) => Promise<T>;
export const PAIRED_BROWSER_INSTANCE_ACCESS_ID = 'paired-browser-instance';

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

export async function browserInstanceAccess(required: CapabilityScope): Promise<BridgeGrant> {
  const policy = (await getEnterprisePolicy()).policy;
  assertBrowserAccessPolicy(policy, {
    programEval: required === 'browser.page.eval.program',
  });
  const scopes: CapabilityScope[] = [
    ...CONTROL_CAPABILITY_SCOPES,
    ...(policy.allowProgramEval === false ? [] : ['browser.page.eval.program' as const]),
  ];
  const grant: BridgeGrant = {
    id: PAIRED_BROWSER_INSTANCE_ACCESS_ID,
    taskId: PAIRED_BROWSER_INSTANCE_ACCESS_ID,
    targets: [],
    scopes: [...scopes],
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
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
  _grant: BridgeGrant,
  input: { tabId?: unknown; frameId?: unknown; documentId?: unknown },
  resolveInPage = true,
): Promise<BrowserTarget> {
  const currentTab = await getTab(typeof input.tabId === 'number' ? input.tabId : undefined);
  const target: BrowserTarget = {
    tabId: currentTab.id,
    frameId: typeof input.frameId === 'number' ? input.frameId : 0,
  };
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
  if (!currentOrigin) {
    throw new ExtensionError('target_unavailable', '目标 frame 不是可访问的 HTTP(S) 页面');
  }
  assertBrowserAccessPolicy((await getEnterprisePolicy()).policy, { origin: currentOrigin });
  if (typeof input.documentId === 'string' && currentFrame.documentId
    && input.documentId !== currentFrame.documentId) {
    throw new ExtensionError('stale_document', '请求的页面文档已经刷新或导航，请重新获取页面上下文');
  }
  const currentTarget = { ...target, documentId: currentFrame.documentId };
  return resolveInPage ? resolveDocumentTarget(currentTarget) : currentTarget;
}

export function requireScope(grant: BridgeGrant, scope: CapabilityScope): void {
  if (!grant.scopes.includes(scope)) {
    throw new ExtensionError('permission_denied', `浏览器实例不允许能力: ${scope}`);
  }
}
