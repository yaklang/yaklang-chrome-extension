import { browser } from 'wxt/browser';
import {
  clearNetworkRequests, exportNetworkRequest, listNetworkRequests, networkCaptureStatus,
  redactNetworkRequests, startNetworkCapture, stopNetworkCapture,
  stopNetworkCapturesForGrant,
} from '@/features/network-capture/service';
import {
  clearPageObservations, listPageObservations, pageObservationStatus, startPageObservation,
  stopPageObservation, stopPageObservationsForGrant,
} from '@/features/page-observation/service';
import { capturedRequestEnginePayload } from '@/features/network-capture/workflows';
import type {
  BridgeGrant, BrowserRequestAnalysisBundle, BrowserTarget, CapabilityScope, HandoffReason,
  PageContextOptions, YakPocGenerateResult,
} from '@/types/models';
import { CONTROL_CAPABILITY_SCOPES, READ_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import { parseCapabilityParams } from '@/protocol/bridge';
import { getFrameInventory } from '@/features/page-context/frames';
import { activateTab, getTab, resolveDocumentTarget } from '@/platform/browser/targets';
import {
  actOnPageNode, capturePageContext, evalInPage, inspectPageNode, invokePageFunction,
} from '@/features/page-context/service';
import { listCookies } from '@/features/cookies/service';
import { getState, updateState } from '@/platform/storage/state';
import { switchProxy } from '@/features/proxy/service';
import { ExtensionError } from '@/shared/errors';
import { setAgentRuntimeState } from '@/features/agent-runtime/service';

export { CONTROL_CAPABILITY_SCOPES, READ_CAPABILITY_SCOPES } from '@/protocol/capabilities';

const CAPABILITY_SCOPES: Record<string, CapabilityScope> = {
  'browser.tabs': 'browser.tabs.read',
  'browser.frames': 'browser.tabs.read',
  'browser.context': 'browser.dom.read',
  'browser.node.inspect': 'browser.dom.read',
  'browser.node.action': 'browser.dom.write',
  'browser.cookies': 'browser.cookies.read',
  'browser.takeover': 'browser.tab.activate',
  'browser.handoff.request': 'browser.human.takeover',
  'browser.handoff.status': 'browser.human.takeover',
  'browser.network.start': 'browser.network.capture',
  'browser.network.status': 'browser.network.read',
  'browser.network.list': 'browser.network.read',
  'browser.network.clear': 'browser.network.capture',
  'browser.network.stop': 'browser.network.capture',
  'browser.network.export': 'browser.network.sensitive.read',
  'browser.network.poc': 'browser.network.sensitive.read',
  'browser.network.analysis': 'browser.network.sensitive.read',
  'browser.observe.start': 'browser.observation.control',
  'browser.observe.status': 'browser.observation.read',
  'browser.observe.list': 'browser.observation.read',
  'browser.observe.clear': 'browser.observation.control',
  'browser.observe.stop': 'browser.observation.control',
  'browser.invoke': 'browser.page.invoke',
  'browser.eval': 'browser.page.eval.expression',
  'proxy.list': 'browser.proxy.read',
  'proxy.switch': 'browser.proxy.write',
};

async function activeGrant(required: CapabilityScope): Promise<BridgeGrant> {
  const state = await getState();
  const grant = state.activeGrant;
  if (!grant || grant.expiresAt <= Date.now()) {
    if (grant) {
      const state = await updateState((current) => ({
        ...current,
        activeGrant: undefined,
        handoff: current.handoff?.state === 'waiting_for_user'
          ? { ...current.handoff, state: 'cancelled', resolvedAt: Date.now() }
          : current.handoff,
      }));
      await Promise.all([
        stopNetworkCapturesForGrant(grant.id),
        stopPageObservationsForGrant(grant.id),
      ]);
      await setAgentRuntimeState('expired', grant);
      if (state.handoff) await browser.action.setBadgeText({ text: '', tabId: state.handoff.target.tabId });
    }
    throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期');
  }
  if (!grant.scopes.includes(required)) throw new ExtensionError('permission_denied', `共享会话未授权能力: ${required}`);
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

async function allowedTarget(grant: BridgeGrant, input: Record<string, unknown>): Promise<BrowserTarget> {
  const requested = typeof input.tabId === 'number' ? input.tabId : grant.targets[0]?.tabId;
  const requestedFrameId = typeof input.frameId === 'number' ? input.frameId : 0;
  const target = grant.targets.find((item) => item.tabId === requested && item.frameId === requestedFrameId);
  if (!target) throw new ExtensionError('target_denied', '目标标签页不在本次共享会话中');
  const currentFrame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (!currentFrame) throw new ExtensionError('target_unavailable', '目标 frame 已不存在');
  let currentOrigin = originOf(currentFrame.url);
  if (!currentOrigin) {
    currentOrigin = (await getFrameInventory(target.tabId)).find((frame) => frame.frameId === target.frameId)?.origin || '';
  }
  if (currentOrigin !== target.origin) throw new ExtensionError('origin_changed', '目标 frame 已经跨来源导航，请重新授权');
  if (target.documentId && currentFrame.documentId && target.documentId !== currentFrame.documentId) {
    throw new ExtensionError('stale_document', '目标 frame 已经刷新或导航，请重新授权');
  }
  if (typeof input.documentId === 'string' && target.documentId && input.documentId !== target.documentId) {
    throw new ExtensionError('stale_document', '请求的页面文档已经失效，请重新授权');
  }
  const resolved = await resolveDocumentTarget(target);
  if (target.documentId && resolved.documentId && target.documentId !== resolved.documentId) {
    throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新授权');
  }
  return resolved;
}

function requireScope(grant: BridgeGrant, scope: CapabilityScope): void {
  if (!grant.scopes.includes(scope)) throw new ExtensionError('permission_denied', `共享会话未授权能力: ${scope}`);
}

export async function routeCapability(
  method: string,
  params: unknown,
  requestEngine?: <T>(method: string, params: unknown) => Promise<T>,
): Promise<unknown> {
  if (method === 'system.ping') return { now: Date.now(), extensionVersion: browser.runtime.getManifest().version };
  if (import.meta.env.FIREFOX && import.meta.env.MODE === 'store' && ['browser.invoke', 'browser.eval'].includes(method)) {
    throw new ExtensionError('channel_unavailable', 'Firefox AMO 渠道不提供页面函数调用或通用 Eval');
  }
  const input = parseCapabilityParams(method, params);
  const required = method === 'browser.eval' && input.mode === 'program'
    ? 'browser.page.eval.program'
    : CAPABILITY_SCOPES[method];
  if (!required) throw new Error(`不支持的 Bridge 方法: ${method}`);
  const grant = await activeGrant(required);

  if (method === 'browser.tabs') {
    const tabIds = [...new Set(grant.targets.map((target) => target.tabId))];
    const tabs = await Promise.all(tabIds.map(async (tabId) => {
      const targets = grant.targets.filter((target) => target.tabId === tabId);
      for (const target of targets) {
        try {
          await allowedTarget(grant, { tabId, frameId: target.frameId, documentId: target.documentId });
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

  if (method === 'browser.handoff.status') {
    const handoff = (await getState()).handoff;
    return handoff?.taskId === grant.taskId ? handoff : { state: 'idle' };
  }

  if (method === 'browser.handoff.request') {
    const resolvedTarget = await allowedTarget(grant, input);
    const grantTarget = grant.targets.find((target) => target.tabId === resolvedTarget.tabId && target.frameId === resolvedTarget.frameId);
    if (!grantTarget) throw new Error('目标标签页不在本次共享会话中');
    const now = Date.now();
    const state = await updateState((current) => {
      if (current.activeGrant?.id !== grant.id || current.activeGrant.expiresAt <= Date.now()) {
        throw new ExtensionError('grant_expired', '浏览器共享会话已经变化，请重新发起请求');
      }
      if (current.handoff?.state === 'waiting_for_user') {
        throw new ExtensionError('handoff_in_progress', '已有人工接管请求正在等待处理');
      }
      return {
        ...current,
        handoff: {
          id: crypto.randomUUID(),
          taskId: grant.taskId,
          target: grantTarget,
          reason: input.reason as HandoffReason,
          message: typeof input.message === 'string' ? input.message : '',
          state: 'waiting_for_user',
          requestedAt: now,
        },
      };
    });
    await activateTab(resolvedTarget.tabId);
    await browser.action.setBadgeBackgroundColor({ color: '#ee7815' });
    await browser.action.setBadgeText({ text: '待确认', tabId: resolvedTarget.tabId });
    await setAgentRuntimeState('waiting_for_human', grant);
    return state.handoff;
  }

  if (method.startsWith('browser.network.')) {
    const target = await allowedTarget(grant, input);
    if (method === 'browser.network.start') {
      if (input.captureHeaders === true || input.captureBody === true) requireScope(grant, 'browser.network.sensitive.read');
      return startNetworkCapture(target, {
        captureHeaders: input.captureHeaders === true,
        captureBody: input.captureBody === true,
        maxEntries: typeof input.maxEntries === 'number' ? input.maxEntries : undefined,
        maxBodyBytes: typeof input.maxBodyBytes === 'number' ? input.maxBodyBytes : undefined,
      }, { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt });
    }
    if (method === 'browser.network.status') return networkCaptureStatus(target);
    if (method === 'browser.network.list') {
      const records = await listNetworkRequests(target, typeof input.limit === 'number' ? input.limit : 100);
      return grant.scopes.includes('browser.network.sensitive.read') ? records : redactNetworkRequests(records);
    }
    if (method === 'browser.network.clear') return clearNetworkRequests(target);
    if (method === 'browser.network.stop') return stopNetworkCapture(target);
    if (method === 'browser.network.export') return exportNetworkRequest(target, String(input.id));
    if (method === 'browser.network.poc') {
      if (!requestEngine) throw new ExtensionError('bridge_disconnected', 'Yak 引擎请求通道不可用');
      return requestEngine<YakPocGenerateResult>('yakit.poc.generate', await capturedRequestEnginePayload(target, String(input.id), false));
    }
    if (method === 'browser.network.analysis') {
      if (!requestEngine) throw new ExtensionError('bridge_disconnected', 'Yak 引擎请求通道不可用');
      return requestEngine<BrowserRequestAnalysisBundle>(
        'yakit.browser_request.prepare_analysis',
        await capturedRequestEnginePayload(target, String(input.id), grant.scopes.includes('browser.observation.read')),
      );
    }
  }

  if (method.startsWith('browser.observe.')) {
    const target = await allowedTarget(grant, input);
    if (method === 'browser.observe.start') {
      if (input.captureValues === true) requireScope(grant, 'browser.observation.sensitive.read');
      return startPageObservation(target, {
        captureValues: input.captureValues === true,
        maxEntries: typeof input.maxEntries === 'number' ? input.maxEntries : undefined,
        maxValueBytes: typeof input.maxValueBytes === 'number' ? input.maxValueBytes : undefined,
        expiresAt: grant.expiresAt,
      }, { kind: 'grant', grantId: grant.id });
    }
    if (method === 'browser.observe.status') return pageObservationStatus(target);
    if (method === 'browser.observe.list') {
      return listPageObservations(
        target,
        typeof input.limit === 'number' ? input.limit : 100,
        grant.scopes.includes('browser.observation.sensitive.read'),
      );
    }
    if (method === 'browser.observe.clear') return clearPageObservations(target);
    if (method === 'browser.observe.stop') return stopPageObservation(target);
  }

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
    const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
    const grantTarget = grant.targets.find((item) => item.tabId === target.tabId && item.frameId === target.frameId);
    const url = frame?.url && /^https?:/i.test(frame.url) ? frame.url : `${grantTarget?.origin || ''}/`;
    if (!/^https?:/i.test(url)) throw new ExtensionError('target_unavailable', '目标 frame 没有可读取 Cookie 的 HTTP 来源');
    return listCookies(url);
  }
  if (method === 'browser.takeover') {
    const target = await allowedTarget(grant, input);
    await activateTab(target.tabId);
    await browser.action.setBadgeBackgroundColor({ color: '#f28c28' });
    await browser.action.setBadgeText({ text: '接管', tabId: target.tabId });
    globalThis.setTimeout(() => void browser.action.setBadgeText({ text: '', tabId: target.tabId }), 10_000);
    return { activated: true, target };
  }
  if (method === 'browser.invoke') {
    if (typeof input.path !== 'string') throw new Error('缺少页面函数路径');
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000;
    return invokePageFunction(input.path, Array.isArray(input.args) ? input.args : [], await allowedTarget(grant, input), timeoutMs);
  }
  if (method === 'browser.eval') {
    if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('缺少页面执行代码');
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000;
    return evalInPage(input.code, input.mode as 'expression' | 'program', await allowedTarget(grant, input), timeoutMs);
  }
  const state = await getState();
  if (method === 'proxy.list') return state.proxyProfiles;
  if (method === 'proxy.switch') {
    if (typeof input.id !== 'string') throw new Error('缺少代理配置 ID');
    await switchProxy(input.id);
    return { activeProxyId: input.id };
  }
  throw new Error(`不支持的 Bridge 方法: ${method}`);
}
