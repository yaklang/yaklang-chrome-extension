import { browser, type Browser } from 'wxt/browser';
import {
  clearNetworkRequests, exportNetworkRequest, listNetworkRequests, networkCaptureStatus,
  rebindNetworkCapturesForGrant, startNetworkCapture, stopNetworkCapture, stopNetworkCapturesForGrant,
} from '@/features/network-capture/service';
import { capturedRequestEnginePayload } from '@/features/network-capture/workflows';
import { initializeBrowserRecordingService, stopBrowserRecordingsForGrant } from '@/features/browser-recording/service';
import { initializeDeepCaptureService, stopDeepCapturesForGrant } from '@/features/deep-capture/service';
import { initializeBrowserTransformService } from '@/features/browser-transform/service';
import { initializeFloatingPanelLifecycle } from '@/features/floating-panel/lifecycle';
import type { ExtensionRequest, ExtensionResponse } from '@/types/messages';
import { parseExtensionRequest } from '@/protocol/extension';
import type {
  BridgeGrantTarget, BrowserRequestAnalysisBundle, BrowserTarget, YakPocGenerateResult, YakitFuzzerOpenResult,
} from '@/types/models';
import { engineBridge } from '@/features/engine-bridge/service';
import { getFrameInventory } from '@/features/page-context/frames';
import { getActiveTab, getTab } from '@/platform/browser/targets';
import {
  actOnPageNode, capturePageContext, evalInPage, inspectPageNode, invokePageFunction,
} from '@/features/page-context/service';
import { getState, updateState } from '@/platform/storage/state';
import {
  reconcileUserAgentRuntime,
} from '@/features/identity/user-agent-service';
import { errorCode, ExtensionError } from '@/shared/errors';
import { appendAuditEvent, clearAuditEvents, listAuditEvents } from '@/features/diagnostics/audit';
import {
  clearAgentActions, getAgentRuntime, setAgentRuntimeState,
} from '@/features/agent-runtime/service';
import {
  configureGrantLifecycleHooks, currentActiveGrant, rebindGrantTargets,
  registerGrantLifecycleListeners, replaceActiveGrant, requireActiveGrant,
  restoreGrantLifecycle, revokeActiveGrant,
} from '@/features/grants/lifecycle';
import {
  applyPolicyToBridge, applyPolicyToState, assertGrantPolicy, getEnterprisePolicy,
} from '@/platform/policy/managed';
import {
  browserInstanceAccess, PAIRED_BROWSER_INSTANCE_ACCESS_ID,
} from '@/features/grants/capability-context';
import { createDiagnosticsBundle } from '@/features/diagnostics/export';
import { getRuntimeMetrics, recordServiceWorkerStart, resetRuntimeMetrics } from '@/features/diagnostics/metrics';
import {
  configureAuthorizationPageContextCapture,
  createBrowserIsolationProof,
  deleteFirefoxContainerIdentity,
  inspectBrowserIsolation,
  listFirefoxContainerIdentities,
  openFirefoxContainerIdentity,
  openIncognitoIdentity,
  resolveTabCookieStoreId,
} from '@/features/authorization-testing/isolation';
import { ok, fail } from './response';
import {
  requestTarget,
  requiredRequestTarget,
  senderBoundTabId,
  targetTabId,
} from './request-context';
import { dispatchBackgroundHandlers, type BackgroundRequestHandler } from './router';
import { handleProxyRequest } from './handlers/proxy';
import { handleCookieRequest } from './handlers/cookies';
import { handleUserAgentRequest } from './handlers/user-agent';
import { handleRecordingRequest } from './handlers/recording';
import { handleTransformRequest } from './handlers/transform';
import { resolveHandoff } from '@/features/handoff/service';

function originOf(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只能授权 HTTP(S) 标签页');
  return parsed.origin;
}

async function syncManagedInstanceBadge(managedInstance?: { badge: string }): Promise<void> {
  const badge = managedInstance?.badge || '';
  await browser.action.setBadgeText({ text: badge });
  if (badge) {
    const color = badge === 'A' ? '#F26215' : badge === 'B' ? '#2563EB' : badge === 'C' ? '#16A34A' : '#7C3AED';
    await browser.action.setBadgeBackgroundColor({ color });
  }
  await browser.action.setTitle({ title: badge ? `Yakit Browser Agent · 实例 ${badge}` : 'Yakit Browser Agent' });
}

async function createGrantTargets(inputs: Array<{ tabId: number; frameId: number }>): Promise<BridgeGrantTarget[]> {
  const unique = [...new Map(inputs.map((target) => [`${target.tabId}:${target.frameId}`, target])).values()];
  const tabIds = [...new Set(unique.map((target) => target.tabId))];
  const inventories = new Map(await Promise.all(tabIds.map(async (tabId) => [tabId, await getFrameInventory(tabId)] as const)));
  return Promise.all(unique.map(async (input) => {
    const tab = await getTab(input.tabId);
    if (!tab.isolationContextId) {
      throw new ExtensionError(
        'isolation_unavailable',
        `标签页 ${input.tabId} 无法确认身份隔离上下文，不能加入共享会话`,
      );
    }
    const frame = inventories.get(input.tabId)?.find((item) => item.frameId === input.frameId);
    if (!frame?.accessible || !frame.documentId || !frame.origin) {
      throw new ExtensionError('target_unavailable', `Frame ${input.frameId} 当前不可访问，不能加入共享会话`);
    }
    originOf(`${frame.origin}/`);
    return {
      tabId: input.tabId,
      frameId: frame.frameId,
      documentId: frame.documentId,
      isolationContextId: tab.isolationContextId,
      cookieStoreId: tab.cookieStoreId,
      origin: frame.origin,
      grantedUrl: frame.url,
      title: frame.isTop ? tab.title : `${tab.title} · ${frame.title || frame.name || `Frame ${frame.frameId}`}`,
    };
  }));
}

const domainHandlers: readonly BackgroundRequestHandler[] = [
  handleProxyRequest,
  handleCookieRequest,
  handleUserAgentRequest,
  handleRecordingRequest,
  handleTransformRequest,
];

const stopPairedBrowserTasks = () => Promise.all([
  stopNetworkCapturesForGrant(PAIRED_BROWSER_INSTANCE_ACCESS_ID),
  stopBrowserRecordingsForGrant(PAIRED_BROWSER_INSTANCE_ACCESS_ID),
  stopDeepCapturesForGrant(PAIRED_BROWSER_INSTANCE_ACCESS_ID),
]);

async function handleRequest(request: ExtensionRequest, sender: Browser.runtime.MessageSender): Promise<ExtensionResponse> {
  const domainResponse = await dispatchBackgroundHandlers(request, sender, domainHandlers);
  if (domainResponse !== undefined) return domainResponse;

  switch (request.action) {
    case 'state.get': {
      await currentActiveGrant();
      return ok(await getState());
    }
    case 'tab.active': {
      const boundTabId = senderBoundTabId(sender);
      return ok(boundTabId ? await getTab(boundTabId) : await getActiveTab());
    }
    case 'tab.get': return ok(await getTab(targetTabId(request.payload.tabId, sender)));
    case 'tab.list': return ok((await inspectBrowserIsolation()).tabs);
    case 'frame.list': return ok(await getFrameInventory(targetTabId(request.payload.tabId, sender)!));
    case 'isolation.inspect': return ok(await inspectBrowserIsolation(request.payload.tabIds));
    case 'isolation.proof.create': return ok(await createBrowserIsolationProof(
      request.payload.leftTabId,
      request.payload.rightTabId,
    ));
    case 'isolation.incognito.open': return ok(await openIncognitoIdentity(request.payload.url));
    case 'isolation.container.open': return ok(await openFirefoxContainerIdentity(request.payload));
    case 'isolation.container.list': return ok(await listFirefoxContainerIdentities());
    case 'isolation.container.remove': return ok(await deleteFirefoxContainerIdentity(
      request.payload.cookieStoreId,
    ));
    case 'authorization.engine.task': {
      const encodedBytes = new TextEncoder().encode(JSON.stringify(request.payload.payload)).byteLength;
      if (encodedBytes > 256 * 1024) {
        throw new ExtensionError('payload_too_large', '授权测试任务参数不能超过 256 KiB');
      }
      return ok(await engineBridge.requestEngine(
        'yakit.browser_authorization.task',
        { schema: request.payload.schema, payload: request.payload.payload },
        request.payload.timeoutMs,
      ));
    }
    case 'authorization.yakit.open':
      return ok(await engineBridge.requestEngine(
        'yakit.browser_authorization.open',
        { workspaceId: request.payload.workspaceId },
      ));
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
      const { state } = await replaceActiveGrant({
        id: crypto.randomUUID(),
        taskId: input.taskId || `manual-${crypto.randomUUID()}`,
        targets,
        scopes: [...new Set(input.scopes)],
        createdAt: now,
        expiresAt: now + durationMinutes * 60_000,
      });
      void appendAuditEvent({
        category: 'grant', action: 'grant.create', outcome: 'success', taskId: state.activeGrant?.taskId,
        targetTabId: state.activeGrant?.targets[0]?.tabId,
        summary: `${state.activeGrant?.targets.length || 0} 个标签页，${state.activeGrant?.scopes.length || 0} 项能力`,
      });
      return ok(state);
    }
    case 'grant.refresh': {
      if (senderBoundTabId(sender) !== undefined) {
        throw new ExtensionError('permission_denied', '只有扩展工作区可以续接共享会话');
      }
      const grant = await requireActiveGrant();
      const targets = await createGrantTargets(
        grant.targets.map((target) => ({ tabId: target.tabId, frameId: target.frameId })),
      );
      for (const target of targets) {
        const previous = grant.targets.find((item) => (
          item.tabId === target.tabId && item.frameId === target.frameId
        ));
        if (!previous) {
          throw new ExtensionError('target_denied', '续接结果包含未授权的页面');
        }
        if (
          previous.isolationContextId !== target.isolationContextId
          || previous.cookieStoreId !== target.cookieStoreId
        ) {
          throw new ExtensionError('isolation_stale', '页面的身份隔离上下文已经变化，请重新选择身份');
        }
        if (previous.origin !== target.origin) {
          throw new ExtensionError('origin_changed', '页面已经跨来源导航，请重新选择身份');
        }
      }
      const state = await rebindGrantTargets(grant.id, targets);
      await rebindNetworkCapturesForGrant(grant.id, targets);
      const refreshedDocuments = targets.filter((target) => {
        const previous = grant.targets.find((item) => (
          item.tabId === target.tabId && item.frameId === target.frameId
        ));
        return previous?.documentId !== target.documentId;
      }).length;
      void appendAuditEvent({
        category: 'grant',
        action: 'grant.refresh',
        outcome: 'success',
        taskId: grant.taskId,
        targetTabId: targets[0]?.tabId,
        summary: refreshedDocuments > 0
          ? `已受控续接 ${refreshedDocuments} 个同源页面文档`
          : '共享会话文档仍然有效',
      });
      return ok(state);
    }
    case 'grant.revoke': {
      const { state } = await revokeActiveGrant();
      return ok(state);
    }
    case 'handoff.resolve': {
      const input = request.payload;
      const { state, handoff } = await resolveHandoff(input.id, input.outcome);
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
      const grant = (await getState()).activeGrant;
      const grantTarget = grant?.targets.find((item) => (
        item.tabId === target.tabId
        && item.frameId === target.frameId
        && (!item.documentId || !target.documentId || item.documentId === target.documentId)
      ));
      const owner: Parameters<typeof startNetworkCapture>[2] = grant && grantTarget
        ? { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt }
        : undefined;
      const status = await startNetworkCapture(target, input, owner);
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
    case 'audit.list': return ok(await listAuditEvents(request.payload.limit));
    case 'audit.clear': {
      await clearAuditEvents();
      return ok();
    }
    case 'agent.runtime.get': return ok(await getAgentRuntime());
    case 'agent.pause': {
      const grant = await browserInstanceAccess('browser.tabs.read');
      engineBridge.cancelActiveRequests();
      await stopPairedBrowserTasks();
      const runtime = await setAgentRuntimeState('paused', grant);
      void appendAuditEvent({ category: 'grant', action: 'agent.pause', outcome: 'success', taskId: grant.taskId });
      return ok(runtime);
    }
    case 'agent.resume': {
      const grant = await browserInstanceAccess('browser.tabs.read');
      const runtime = await setAgentRuntimeState('running', grant);
      void appendAuditEvent({ category: 'grant', action: 'agent.resume', outcome: 'success', taskId: grant.taskId });
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
      await syncManagedInstanceBadge(state.bridge.managedInstance);
      if (config.autoConnect && config.pairedEngine) await engineBridge.connect(config);
      else engineBridge.disconnect();
      return ok(state);
    }
    case 'bridge.managed-instance.bind': {
      const senderURL = sender.url ? new URL(sender.url) : undefined;
      const bootstrapURL = new URL(browser.runtime.getURL('/ytray-bootstrap.html'));
      if (senderURL?.origin !== bootstrapURL.origin || senderURL.pathname !== bootstrapURL.pathname) {
        throw new ExtensionError('forbidden', '浏览器实例身份只能由受管启动页设置');
      }
      const state = await updateState((current) => ({
        ...current,
        bridge: { ...current.bridge, managedInstance: request.payload },
      }));
      await syncManagedInstanceBadge(state.bridge.managedInstance);
      if (state.bridge.autoConnect && state.bridge.pairedEngine) {
        engineBridge.disconnect();
        await stopPairedBrowserTasks();
        await engineBridge.connect(state.bridge);
      }
      return ok(engineBridge.getStatus());
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
      await stopPairedBrowserTasks();
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
      await stopPairedBrowserTasks();
      void appendAuditEvent({ category: 'bridge', action: 'bridge.disconnect', outcome: 'success' });
      return ok(engineBridge.getStatus());
    }
    case 'bridge.status': return ok(engineBridge.getStatus());
    default: return fail('未知扩展操作');
  }
}

let backgroundStarted = false;

async function restoreBackgroundState(): Promise<void> {
  const storedState = await restoreGrantLifecycle();
  const policy = (await getEnterprisePolicy()).policy;
  const state = applyPolicyToState(storedState, policy);
  if (JSON.stringify(state.bridge) !== JSON.stringify(storedState.bridge)
    || JSON.stringify(state.floatingPanel) !== JSON.stringify(storedState.floatingPanel)) {
    await updateState((current) => applyPolicyToState(current, policy));
  }
  try {
    await reconcileUserAgentRuntime();
  } catch (error) {
    console.error('User-Agent runtime restoration failed', error);
    void appendAuditEvent({
      category: 'settings',
      action: 'ua.runtime.restore',
      outcome: 'error',
      errorCode: errorCode(error),
      summary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    });
  }
  const currentState = await getState();
  await syncManagedInstanceBadge(currentState.bridge.managedInstance);
  if (currentState.bridge.autoConnect && currentState.bridge.pairedEngine) {
    await engineBridge.connect(currentState.bridge).catch(console.error);
  }
}

export function runBackground(): void {
  if (backgroundStarted) return;
  backgroundStarted = true;

  configureGrantLifecycleHooks({
    emitHandoffChanged: (handoff) => engineBridge.emitEvent('browser.handoff.changed', handoff),
  });
  registerGrantLifecycleListeners();

  browser.runtime.onMessage.addListener((
    input: unknown,
    sender: Browser.runtime.MessageSender,
    sendResponse,
  ) => {
    if ([
      'bridge.status.changed',
      'bridge.pairing.status.changed',
      'network.capture.changed',
      'deep.capture.changed',
    ].includes((input as { action?: string })?.action || '')) return undefined;
    void Promise.resolve()
      .then(() => parseExtensionRequest(input))
      .then((request) => handleRequest(request, sender))
      .then(sendResponse)
      .catch((error) => sendResponse(fail(error)));
    return true;
  });

  configureAuthorizationPageContextCapture(capturePageContext);
  recordServiceWorkerStart();
  initializeBrowserRecordingService();
  initializeFloatingPanelLifecycle();
  try {
    initializeDeepCaptureService();
  } catch (error) {
    console.error('Deep Capture initialization failed', error);
  }
  try {
    initializeBrowserTransformService();
  } catch (error) {
    console.error('Browser Transform initialization failed', error);
  }
  void restoreBackgroundState().catch((error) => {
    console.error('Background state restoration failed', error);
  });
}
