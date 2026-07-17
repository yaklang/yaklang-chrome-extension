import { browser, type Browser } from 'wxt/browser';
import {
  clearNetworkRequests, exportNetworkRequest, listNetworkRequests, networkCaptureStatus,
  startNetworkCapture, stopNetworkCapture, stopNetworkCapturesForGrant,
} from '@/features/network-capture/service';
import { capturedRequestEnginePayload } from '@/features/network-capture/workflows';
import {
  clearPageObservations, listPageObservations, pageObservationStatus, startPageObservation,
  stopPageObservation, stopPageObservationsForGrant,
} from '@/features/page-observation/service';
import type { ExtensionRequest, ExtensionResponse } from '@/types/messages';
import { parseExtensionRequest } from '@/protocol/extension';
import type {
  BridgeGrantTarget, BrowserRequestAnalysisBundle, BrowserTarget, YakPocGenerateResult, YakitFuzzerOpenResult,
} from '@/types/models';
import { engineBridge } from '@/features/engine-bridge/service';
import { getFrameInventory } from '@/features/page-context/frames';
import { getActiveTab, getTab, resolveDocumentTarget } from '@/platform/browser/targets';
import {
  actOnPageNode, capturePageContext, evalInPage, inspectPageNode, invokePageFunction,
} from '@/features/page-context/service';
import { listCookies, removeCookie, setCookie } from '@/features/cookies/service';
import { exportCookies, importCookies } from '@/features/cookies/transfer';
import {
  applyProxyRules, clearProxyRuleStats, compileProxyRules, getProxyRuleStats, hasProxyAuthPassword,
  previewProxyRules, setProxyAuthPassword, switchProxy,
} from '@/features/proxy/service';
import { getState, updateState } from '@/platform/storage/state';
import { applyUserAgentRules } from '@/features/identity/user-agent';
import { errorCode, ExtensionError } from '@/shared/errors';
import { appendAuditEvent, clearAuditEvents, listAuditEvents } from '@/features/diagnostics/audit';
import {
  clearAgentActions, getAgentRuntime, setAgentRuntimeState, startAgentRuntime,
} from '@/features/agent-runtime/service';
import {
  applyPolicyToBridge, applyPolicyToState, assertGrantPolicy, getEnterprisePolicy,
} from '@/platform/policy/managed';
import { createDiagnosticsBundle } from '@/features/diagnostics/export';
import { getRuntimeMetrics, recordServiceWorkerStart, resetRuntimeMetrics } from '@/features/diagnostics/metrics';

function ok<T>(data?: T): ExtensionResponse<T> {
  return { ok: true, data };
}

function fail(error: unknown): ExtensionResponse {
  return { ok: false, error: error instanceof Error ? error.message : String(error), errorCode: errorCode(error) };
}

function isFloatingSender(sender: Browser.runtime.MessageSender): boolean {
  try {
    const parsed = new URL(sender.url || '');
    return parsed.origin === new URL(browser.runtime.getURL('/')).origin && parsed.pathname === '/floating.html';
  } catch {
    return false;
  }
}

function senderBoundTabId(sender: Browser.runtime.MessageSender): number | undefined {
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  const senderUrl = sender.url || '';
  try {
    const parsed = new URL(senderUrl);
    if (parsed.origin === extensionOrigin && parsed.pathname !== '/floating.html') return undefined;
  } catch {
    // Non-URL senders remain bound to their browser tab below.
  }
  return sender.tab?.id;
}

function targetTabId(requested: number | undefined, sender: Browser.runtime.MessageSender): number | undefined {
  const senderTabId = senderBoundTabId(sender);
  if (senderTabId && requested && senderTabId !== requested) {
    throw new Error('页面内请求不能操作其他标签页');
  }
  return senderTabId || requested;
}

async function requestTarget(
  input: { tabId?: number; frameId?: number; documentId?: string },
  sender: Browser.runtime.MessageSender,
): Promise<BrowserTarget | undefined> {
  const boundTabId = senderBoundTabId(sender);
  if (boundTabId && input.tabId && boundTabId !== input.tabId) {
    throw new ExtensionError('target_denied', '页面内请求不能操作其他标签页');
  }
  if (boundTabId && !isFloatingSender(sender)) {
    const frameId = sender.frameId ?? 0;
    if (input.frameId !== undefined && input.frameId !== frameId) throw new ExtensionError('target_denied', '页面内请求不能操作其他 frame');
    if (input.documentId && sender.documentId && input.documentId !== sender.documentId) {
      throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新选择');
    }
    return { tabId: boundTabId, frameId, documentId: sender.documentId };
  }
  const tabId = boundTabId || input.tabId;
  if (!tabId) return undefined;
  return resolveDocumentTarget({ tabId, frameId: input.frameId ?? 0, documentId: input.documentId });
}

async function requiredRequestTarget(
  input: { tabId?: number; frameId?: number; documentId?: string },
  sender: Browser.runtime.MessageSender,
): Promise<BrowserTarget> {
  const target = await requestTarget(input, sender);
  if (!target) throw new ExtensionError('target_unavailable', '请选择一个可访问的 HTTP(S) 标签页');
  return target;
}

function originOf(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只能授权 HTTP(S) 标签页');
  return parsed.origin;
}

async function createGrantTargets(inputs: Array<{ tabId: number; frameId: number }>): Promise<BridgeGrantTarget[]> {
  const unique = [...new Map(inputs.map((target) => [`${target.tabId}:${target.frameId}`, target])).values()];
  const tabIds = [...new Set(unique.map((target) => target.tabId))];
  const inventories = new Map(await Promise.all(tabIds.map(async (tabId) => [tabId, await getFrameInventory(tabId)] as const)));
  return Promise.all(unique.map(async (input) => {
    const tab = await getTab(input.tabId);
    const frame = inventories.get(input.tabId)?.find((item) => item.frameId === input.frameId);
    if (!frame?.accessible || !frame.documentId || !frame.origin) {
      throw new ExtensionError('target_unavailable', `Frame ${input.frameId} 当前不可访问，不能加入共享会话`);
    }
    originOf(`${frame.origin}/`);
    return {
      tabId: input.tabId,
      frameId: frame.frameId,
      documentId: frame.documentId,
      origin: frame.origin,
      grantedUrl: frame.url,
      title: frame.isTop ? tab.title : `${tab.title} · ${frame.title || frame.name || `Frame ${frame.frameId}`}`,
    };
  }));
}

async function handleRequest(request: ExtensionRequest, sender: Browser.runtime.MessageSender): Promise<ExtensionResponse> {
  switch (request.action) {
    case 'state.get': return ok(await getState());
    case 'tab.active': {
      const boundTabId = senderBoundTabId(sender);
      return ok(boundTabId ? await getTab(boundTabId) : await getActiveTab());
    }
    case 'tab.get': return ok(await getTab(targetTabId(request.payload.tabId, sender)));
    case 'tab.list': return ok((await browser.tabs.query({})).filter((tab) => tab.id && /^https?:/i.test(tab.url || '')).map((tab) => ({
      id: tab.id!, windowId: tab.windowId, title: tab.title || '未命名页面', url: tab.url!, favIconUrl: tab.favIconUrl, lastAccessed: tab.lastAccessed,
    })));
    case 'frame.list': return ok(await getFrameInventory(targetTabId(request.payload.tabId, sender)!));
    case 'proxy.save': {
      const profile = request.payload;
      return ok(await updateState((state) => ({
        ...state,
        proxyProfiles: [...state.proxyProfiles.filter((item) => item.id !== profile.id), profile],
      })));
    }
    case 'proxy.delete': {
      const { id } = request.payload;
      return ok(await updateState((state) => ({
        ...state,
        proxyProfiles: state.proxyProfiles.filter((item) => item.id !== id || item.builtin),
        proxyRules: state.proxyRules.filter((rule) => rule.proxyProfileId !== id),
      })));
    }
    case 'proxy.switch':
      await switchProxy(request.payload.id);
      return ok(await getState());
    case 'proxy.rule.save': {
      const rule = request.payload;
      const profiles = (await getState()).proxyProfiles;
      if (!profiles.some((profile) => profile.id === rule.proxyProfileId && ['direct', 'fixed_servers'].includes(profile.kind))) {
        throw new Error('规则 PAC 只能使用直接连接或固定代理出口');
      }
      return ok(await updateState((state) => ({
        ...state,
        proxyRules: [...state.proxyRules.filter((item) => item.id !== rule.id), rule],
      })));
    }
    case 'proxy.rule.delete': {
      const { id } = request.payload;
      return ok(await updateState((state) => ({ ...state, proxyRules: state.proxyRules.filter((item) => item.id !== id) })));
    }
    case 'proxy.rules.apply':
      await applyProxyRules();
      return ok(await getState());
    case 'proxy.rules.preview': {
      const state = await getState();
      return ok(previewProxyRules(request.payload.url, state.proxyRules, state.proxyProfiles, state.proxyRouting));
    }
    case 'proxy.rules.compile': {
      const state = await getState();
      return ok(compileProxyRules(state.proxyRules, state.proxyProfiles, state.proxyRouting));
    }
    case 'proxy.rules.reorder': {
      const ids = request.payload.ids;
      const state = await getState();
      if (ids.length !== state.proxyRules.length || new Set(ids).size !== ids.length || ids.some((id) => !state.proxyRules.some((rule) => rule.id === id))) {
        throw new Error('规则排序必须包含当前全部规则且不能重复');
      }
      const byId = new Map(state.proxyRules.map((rule) => [rule.id, rule]));
      return ok(await updateState((current) => ({
        ...current,
        proxyRules: ids.map((id, index) => ({ ...byId.get(id)!, priority: (ids.length - index) * 10 })),
      })));
    }
    case 'proxy.rules.settings': {
      const input = request.payload;
      const state = await getState();
      if (!state.proxyProfiles.some((profile) => profile.id === input.defaultProfileId && ['direct', 'fixed_servers'].includes(profile.kind))) throw new Error('默认出口必须是直接连接或固定代理');
      return ok(await updateState((current) => ({ ...current, proxyRouting: input })));
    }
    case 'proxy.rules.stats': return ok(getProxyRuleStats());
    case 'proxy.rules.stats.clear':
      await clearProxyRuleStats();
      return ok();
    case 'proxy.auth.set':
      await setProxyAuthPassword(request.payload.profileId, request.payload.password);
      return ok({ configured: hasProxyAuthPassword(request.payload.profileId) });
    case 'proxy.auth.status': return ok({ configured: hasProxyAuthPassword(request.payload.profileId) });
    case 'proxy.config.export': {
      const state = await getState();
      return ok({ version: 1 as const, profiles: state.proxyProfiles, rules: state.proxyRules, routing: state.proxyRouting });
    }
    case 'proxy.config.import': {
      const configuration = request.payload.configuration;
      const profileIds = new Set(configuration.profiles.map((profile) => profile.id));
      if (profileIds.size !== configuration.profiles.length || !profileIds.has(configuration.routing.defaultProfileId)) throw new Error('代理配置包含重复或缺失的出口 ID');
      if (configuration.rules.some((rule) => !profileIds.has(rule.proxyProfileId))) throw new Error('代理规则引用了不存在的出口');
      const routableIds = new Set(configuration.profiles.filter((profile) => ['direct', 'fixed_servers'].includes(profile.kind)).map((profile) => profile.id));
      if (!routableIds.has(configuration.routing.defaultProfileId) || configuration.rules.some((rule) => !routableIds.has(rule.proxyProfileId))) throw new Error('规则 PAC 只能使用直接连接或固定代理出口');
      return ok(await updateState((current) => ({
        ...current,
        proxyProfiles: configuration.profiles,
        proxyRules: configuration.rules,
        proxyRouting: configuration.routing,
        activeProxyId: 'direct',
      })));
    }
    case 'cookie.list': return ok(await listCookies(request.payload.url));
    case 'cookie.set': return ok(await setCookie(request.payload));
    case 'cookie.remove': {
      const input = request.payload;
      await removeCookie(input);
      return ok();
    }
    case 'cookie.removeMany': {
      const results = await Promise.allSettled(request.payload.cookies.map((cookie) => removeCookie(cookie)));
      const removed = results.filter((result) => result.status === 'fulfilled').length;
      return ok({ removed, failed: results.length - removed });
    }
    case 'cookie.import': return ok(await importCookies(request.payload.url, request.payload.format, request.payload.text));
    case 'cookie.export': return ok(exportCookies(await listCookies(request.payload.url), request.payload.format, request.payload.includeValues));
    case 'ua.save': {
      const rule = request.payload;
      const state = await updateState((current) => ({
        ...current,
        userAgentRules: [...current.userAgentRules.filter((item) => item.id !== rule.id), rule],
      }));
      if (state.activeGrant) await startAgentRuntime(state.activeGrant);
      await applyUserAgentRules(state.userAgentRules);
      return ok(state);
    }
    case 'ua.delete': {
      const state = await updateState((current) => ({
        ...current,
        userAgentRules: current.userAgentRules.filter((item) => item.id !== request.payload.id),
      }));
      await applyUserAgentRules(state.userAgentRules);
      return ok(state);
    }
    case 'ua.apply': {
      const state = await getState();
      await applyUserAgentRules(state.userAgentRules);
      return ok(state);
    }
    case 'context.capture': {
      const { tabId, frameId, documentId, ...options } = request.payload;
      const target = await requiredRequestTarget({ tabId, frameId, documentId }, sender);
      const context = await capturePageContext(options, target);
      void appendAuditEvent({
        category: 'capability', action: 'context.capture', outcome: 'success', targetTabId: target.tabId,
        summary: `${context.document.interactive.length} 个节点，${context.diff.kind}`,
      });
      return ok(context);
    }
    case 'context.node.inspect': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      return ok(await inspectPageNode(input.captureId, input.nodeId, target));
    }
    case 'context.node.action': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      const result = await actOnPageNode(input.captureId, input.nodeId, input.action, target, input.value);
      void appendAuditEvent({
        category: 'capability', action: `context.node.${input.action}`, outcome: 'success', targetTabId: target.tabId,
        summary: input.nodeId,
      });
      return ok(result);
    }
    case 'context.invoke': {
      const input = request.payload;
      return ok(await invokePageFunction(input.path, input.args, await requestTarget(input, sender), input.timeoutMs));
    }
    case 'context.eval': {
      const input = request.payload;
      return ok(await evalInPage(input.code, input.mode, await requestTarget(input, sender), input.timeoutMs));
    }
    case 'panel.update': {
      const input = request.payload;
      const policy = (await getEnterprisePolicy()).policy;
      return ok(await updateState((current) => applyPolicyToState({
        ...current, floatingPanel: {
          enabled: input.enabled ?? current.floatingPanel.enabled,
          side: input.side ?? current.floatingPanel.side,
          y: typeof input.y === 'number' ? Math.min(Math.max(input.y, 0.08), 0.92) : current.floatingPanel.y,
          displayMode: input.displayMode ?? current.floatingPanel.displayMode,
          siteMode: input.siteMode ?? current.floatingPanel.siteMode,
          siteOrigins: input.siteOrigins
            ? [...new Set(input.siteOrigins.map((origin) => new URL(origin).origin))]
            : current.floatingPanel.siteOrigins,
          shortcutEnabled: input.shortcutEnabled ?? current.floatingPanel.shortcutEnabled,
          autoCollapseFullscreen: input.autoCollapseFullscreen ?? current.floatingPanel.autoCollapseFullscreen,
        },
      }, policy)));
    }
    case 'grant.create': {
      const input = request.payload;
      const boundTabId = senderBoundTabId(sender);
      if (boundTabId && input.targets.some((target) => target.tabId !== boundTabId)) {
        throw new Error('页面内请求只能授权当前标签页');
      }
      const now = Date.now();
      const targets = await createGrantTargets(input.targets);
      const policy = (await getEnterprisePolicy()).policy;
      const durationMinutes = assertGrantPolicy(policy, {
        durationMinutes: input.durationMinutes,
        origins: targets.map((target) => target.origin),
        programEval: input.scopes.includes('browser.page.eval.program'),
      });
      const before = await getState();
      const state = await updateState((current) => ({
        ...current,
        activeGrant: {
          id: crypto.randomUUID(),
          taskId: input.taskId || `manual-${crypto.randomUUID()}`,
          targets,
          scopes: [...new Set(input.scopes)],
          createdAt: now,
          expiresAt: now + durationMinutes * 60_000,
        },
        handoff: current.handoff?.state === 'waiting_for_user'
          ? { ...current.handoff, state: 'cancelled', resolvedAt: now }
          : current.handoff,
      }));
      if (before.activeGrant) {
        await Promise.all([
          stopNetworkCapturesForGrant(before.activeGrant.id),
          stopPageObservationsForGrant(before.activeGrant.id),
        ]);
      }
      if (before.handoff?.state === 'waiting_for_user' && state.handoff) {
        await browser.action.setBadgeText({ text: '', tabId: before.handoff.target.tabId });
        engineBridge.emitEvent('browser.handoff.changed', state.handoff);
        void appendAuditEvent({
          category: 'handoff', action: 'handoff.cancelled', outcome: 'cancelled',
          taskId: before.handoff.taskId, targetTabId: before.handoff.target.tabId,
          summary: '创建新授权会话时取消',
        });
      }
      void appendAuditEvent({
        category: 'grant', action: 'grant.create', outcome: 'success', taskId: state.activeGrant?.taskId,
        targetTabId: state.activeGrant?.targets[0]?.tabId,
        summary: `${state.activeGrant?.targets.length || 0} 个标签页，${state.activeGrant?.scopes.length || 0} 项能力`,
      });
      return ok(state);
    }
    case 'grant.revoke': {
      const before = await getState();
      engineBridge.cancelActiveRequests();
      const state = await updateState((current) => ({
        ...current,
        activeGrant: undefined,
        handoff: current.handoff?.state === 'waiting_for_user'
          ? { ...current.handoff, state: 'cancelled', resolvedAt: Date.now() }
          : current.handoff,
      }));
      if (before.activeGrant) {
        await Promise.all([
          stopNetworkCapturesForGrant(before.activeGrant.id),
          stopPageObservationsForGrant(before.activeGrant.id),
        ]);
      }
      await setAgentRuntimeState('revoked', before.activeGrant);
      if (state.handoff && before.handoff?.state === 'waiting_for_user') engineBridge.emitEvent('browser.handoff.changed', state.handoff);
      if (before.handoff?.state === 'waiting_for_user') {
        await browser.action.setBadgeText({ text: '', tabId: before.handoff.target.tabId });
        void appendAuditEvent({
          category: 'handoff', action: 'handoff.cancelled', outcome: 'cancelled',
          taskId: before.handoff.taskId, targetTabId: before.handoff.target.tabId,
          summary: '撤销授权会话时取消',
        });
      }
      void appendAuditEvent({
        category: 'grant', action: 'grant.revoke', outcome: 'success', taskId: before.activeGrant?.taskId,
        targetTabId: before.activeGrant?.targets[0]?.tabId,
      });
      return ok(state);
    }
    case 'handoff.resolve': {
      const input = request.payload;
      const state = await updateState((current) => {
        if (!current.handoff || current.handoff.id !== input.id || current.handoff.state !== 'waiting_for_user') {
          throw new ExtensionError('handoff_not_waiting', '人工接管请求不存在或已经结束');
        }
        return {
          ...current,
          handoff: { ...current.handoff, state: input.outcome, resolvedAt: Date.now() },
        };
      });
      const handoff = state.handoff!;
      await setAgentRuntimeState(input.outcome === 'completed' ? 'running' : 'paused', state.activeGrant);
      await browser.action.setBadgeText({ text: '', tabId: handoff.target.tabId });
      engineBridge.emitEvent('browser.handoff.changed', handoff);
      void appendAuditEvent({
        category: 'handoff', action: `handoff.${input.outcome}`, outcome: input.outcome === 'completed' ? 'success' : 'cancelled',
        taskId: handoff.taskId, targetTabId: handoff.target.tabId,
      });
      return ok(state);
    }
    case 'network.capture.start': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      const status = await startNetworkCapture(target, input);
      void appendAuditEvent({
        category: 'capability', action: 'network.capture.start', outcome: 'success', targetTabId: target.tabId,
        summary: input.captureHeaders || input.captureBody ? '包含用户明确启用的敏感字段' : '仅元数据',
      });
      return ok(status);
    }
    case 'network.capture.status': return ok(await networkCaptureStatus(await requiredRequestTarget(request.payload, sender)));
    case 'network.capture.list': {
      const target = await requiredRequestTarget(request.payload, sender);
      return ok(await listNetworkRequests(target, request.payload.limit));
    }
    case 'network.capture.clear': {
      const target = await requiredRequestTarget(request.payload, sender);
      const status = await clearNetworkRequests(target);
      void appendAuditEvent({ category: 'capability', action: 'network.capture.clear', outcome: 'success', targetTabId: target.tabId });
      return ok(status);
    }
    case 'network.capture.stop': {
      const target = await requiredRequestTarget(request.payload, sender);
      const status = await stopNetworkCapture(target);
      void appendAuditEvent({ category: 'capability', action: 'network.capture.stop', outcome: 'success', targetTabId: target.tabId });
      return ok(status);
    }
    case 'network.capture.export': {
      const target = await requiredRequestTarget(request.payload, sender);
      const exported = await exportNetworkRequest(target, request.payload.id);
      void appendAuditEvent({ category: 'capability', action: 'network.capture.export', outcome: 'success', targetTabId: target.tabId });
      return ok(exported);
    }
    case 'network.capture.send': {
      const target = await requiredRequestTarget(request.payload, sender);
      try {
        const exported = await exportNetworkRequest(target, request.payload.id);
        const result = await engineBridge.requestEngine<YakitFuzzerOpenResult>('yakit.web_fuzzer.open', {
          rawRequestBase64: exported.rawRequestBase64,
          isHttps: exported.isHttps,
          tabName: `Browser · ${new URL(exported.url).hostname}`,
        });
        void appendAuditEvent({
          category: 'capability', action: 'network.capture.send_to_fuzzer', outcome: 'success', targetTabId: target.tabId,
          summary: `Web Fuzzer ${result.pageId}`,
        });
        return ok(result);
      } catch (error) {
        void appendAuditEvent({
          category: 'capability', action: 'network.capture.send_to_fuzzer', outcome: 'error',
          targetTabId: target.tabId, errorCode: errorCode(error),
        });
        throw error;
      }
    }
    case 'network.capture.poc': {
      const target = await requiredRequestTarget(request.payload, sender);
      const result = await engineBridge.requestEngine<YakPocGenerateResult>(
        'yakit.poc.generate',
        await capturedRequestEnginePayload(target, request.payload.id, false),
      );
      void appendAuditEvent({ category: 'capability', action: 'network.capture.generate_poc', outcome: 'success', targetTabId: target.tabId });
      return ok(result);
    }
    case 'network.capture.analysis': {
      const target = await requiredRequestTarget(request.payload, sender);
      const result = await engineBridge.requestEngine<BrowserRequestAnalysisBundle>(
        'yakit.browser_request.prepare_analysis',
        await capturedRequestEnginePayload(target, request.payload.id, true),
      );
      void appendAuditEvent({ category: 'capability', action: 'network.capture.prepare_analysis', outcome: 'success', targetTabId: target.tabId });
      return ok(result);
    }
    case 'observation.start': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      const status = await startPageObservation(target, input);
      void appendAuditEvent({
        category: 'capability', action: 'observation.start', outcome: 'success', targetTabId: target.tabId,
        summary: input.captureValues ? '包含用户明确启用的短时值预览' : '仅元数据',
      });
      return ok(status);
    }
    case 'observation.status': return ok(await pageObservationStatus(await requiredRequestTarget(request.payload, sender)));
    case 'observation.list': {
      const target = await requiredRequestTarget(request.payload, sender);
      return ok(await listPageObservations(target, request.payload.limit, true));
    }
    case 'observation.clear': {
      const target = await requiredRequestTarget(request.payload, sender);
      const status = await clearPageObservations(target);
      void appendAuditEvent({ category: 'capability', action: 'observation.clear', outcome: 'success', targetTabId: target.tabId });
      return ok(status);
    }
    case 'observation.stop': {
      const target = await requiredRequestTarget(request.payload, sender);
      const status = await stopPageObservation(target);
      void appendAuditEvent({ category: 'capability', action: 'observation.stop', outcome: 'success', targetTabId: target.tabId });
      return ok(status);
    }
    case 'audit.list': return ok(await listAuditEvents(request.payload.limit));
    case 'audit.clear': {
      await clearAuditEvents();
      return ok();
    }
    case 'agent.runtime.get': return ok(await getAgentRuntime());
    case 'agent.pause': {
      const state = await getState();
      if (!state.activeGrant) throw new ExtensionError('grant_expired', '没有可暂停的浏览器共享会话');
      engineBridge.cancelActiveRequests();
      const runtime = await setAgentRuntimeState('paused', state.activeGrant);
      void appendAuditEvent({ category: 'grant', action: 'agent.pause', outcome: 'success', taskId: state.activeGrant.taskId });
      return ok(runtime);
    }
    case 'agent.resume': {
      const state = await getState();
      if (!state.activeGrant || state.activeGrant.expiresAt <= Date.now()) throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期');
      const runtime = await setAgentRuntimeState('running', state.activeGrant);
      void appendAuditEvent({ category: 'grant', action: 'agent.resume', outcome: 'success', taskId: state.activeGrant.taskId });
      return ok(runtime);
    }
    case 'agent.actions.clear': return ok(await clearAgentActions());
    case 'policy.status': return ok(await getEnterprisePolicy());
    case 'diagnostics.export': return ok(await createDiagnosticsBundle(engineBridge.getStatus()));
    case 'metrics.get': return ok(await getRuntimeMetrics());
    case 'metrics.reset': return ok(await resetRuntimeMetrics());
    case 'bridge.config.save': {
      const config = applyPolicyToBridge(request.payload, (await getEnterprisePolicy()).policy);
      const state = await updateState((current) => ({ ...current, bridge: config }));
      if (config.autoConnect && config.pairedEngine) await engineBridge.connect(config);
      else engineBridge.disconnect();
      return ok(state);
    }
    case 'bridge.pair': {
      const status = await engineBridge.startPairing();
      void appendAuditEvent({ category: 'bridge', action: 'bridge.pair', outcome: 'success' });
      return ok(status);
    }
    case 'bridge.pair.cancel': return ok(engineBridge.cancelPairing());
    case 'bridge.pair.status': return ok(engineBridge.getPairingStatus());
    case 'bridge.unpair': {
      await engineBridge.unpair();
      void appendAuditEvent({ category: 'bridge', action: 'bridge.unpair', outcome: 'success' });
      return ok(await getState());
    }
    case 'bridge.connect': {
      await engineBridge.connect();
      void appendAuditEvent({ category: 'bridge', action: 'bridge.connect', outcome: 'success' });
      return ok(engineBridge.getStatus());
    }
    case 'bridge.disconnect': {
      engineBridge.disconnect();
      void appendAuditEvent({ category: 'bridge', action: 'bridge.disconnect', outcome: 'success' });
      return ok(engineBridge.getStatus());
    }
    case 'bridge.status': return ok(engineBridge.getStatus());
    default: return fail('未知扩展操作');
  }
}

export async function runBackground(): Promise<void> {
    recordServiceWorkerStart();
    browser.runtime.onMessage.addListener((input: unknown, sender: Browser.runtime.MessageSender, sendResponse) => {
      if (['bridge.status.changed', 'bridge.pairing.status.changed'].includes((input as { action?: string })?.action || '')) return undefined;
      void Promise.resolve().then(() => parseExtensionRequest(input)).then((request) => handleRequest(request, sender)).then(sendResponse).catch((error) => sendResponse(fail(error)));
      return true;
    });
    const storedState = await getState();
    const state = applyPolicyToState(storedState, (await getEnterprisePolicy()).policy);
    if (JSON.stringify(state.bridge) !== JSON.stringify(storedState.bridge) || JSON.stringify(state.floatingPanel) !== JSON.stringify(storedState.floatingPanel)) {
      await updateState(() => state);
    }
    await applyUserAgentRules(state.userAgentRules).catch(console.error);
    if (state.bridge.autoConnect && state.bridge.pairedEngine) await engineBridge.connect(state.bridge).catch(console.error);
}
