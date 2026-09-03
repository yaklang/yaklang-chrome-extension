import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  AlertTriangle, ArrowRight, Check, CircleCheck, ExternalLink, Fingerprint,
  LockKeyhole, Play, RefreshCw, RotateCcw, ShieldAlert, Square, UserRoundPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authorizationShareGrantInput } from '@/features/grants/gateway-share';
import { errorMessage, request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, BridgeStatus, BrowserAuthorizationInstance, BrowserIsolationContext, BrowserIsolationInspection,
  ExtensionState, NetworkCaptureStatus,
} from '@/types/models';
import {
  runBrowserAuthorizationTask,
  type BrowserAuthorizationBaselineCandidate,
  type BrowserAuthorizationMode,
  type BrowserAuthorizationSide,
  type BrowserAuthorizationWorkspace,
} from '../engine';
import './authorization-testing-workspace.css';
import {
  authorizationIdentityOptionDisabledReason,
  normalizeAuthorizationIdentityTabSelection,
} from './identity-selection';
import {
  authorizationWorkspaceUIReducer,
  INITIAL_AUTHORIZATION_WORKSPACE_UI,
  persistedAuthorizationWorkspaceUI,
} from './workspace-reducer';
import {
  AuthorizationEvidenceWorkbench,
  compactDuration,
} from './AuthorizationEvidenceWorkbench';
import { IdentitySlot } from './IdentitySlot';

const SESSION_KEY = 'session.authorization-testing-workspace-ui.v1';

interface AuthorizationTestingWorkspaceProps {
  state: ExtensionState;
  setState: (state: ExtensionState) => void;
  tabs: ActiveTabInfo[];
  activeTab?: ActiveTabInfo;
  bridge: BridgeStatus;
  refreshTabs: () => Promise<void>;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
  busy: boolean;
}

function tabOrigin(tab?: ActiveTabInfo): string {
  try {
    return tab ? new URL(tab.url).origin : '';
  } catch {
    return '';
  }
}

function shortHost(tab?: ActiveTabInfo): string {
  try {
    return tab ? new URL(tab.url).host : '未选择页面';
  } catch {
    return '未选择页面';
  }
}

function formatWorkspaceRemaining(expiresAt: number, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (remainingSeconds < 60) return `${remainingSeconds} 秒`;
  const minutes = Math.ceil(remainingSeconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function contextForTab(
  inspection: BrowserIsolationInspection | undefined,
  tabId: number | undefined,
): BrowserIsolationContext | undefined {
  return inspection?.contexts.find((context) => tabId && context.tabIds.includes(tabId));
}

function proofLabel(workspace?: BrowserAuthorizationWorkspace): string {
  if (!workspace) return '尚未验证';
  if (workspace.proof.level === 'strong') return '强隔离';
  if (workspace.proof.level === 'conditional') return '条件隔离';
  return '隔离不足';
}

function relationLabel(value: 'different' | 'same' | 'unknown'): string {
  if (value === 'different') return '不同';
  if (value === 'same') return '相同';
  return '待确认';
}

function authenticationStatusLabel(
  value: BrowserAuthorizationWorkspace['left']['authentication']['status'],
): string {
  if (value === 'authenticated') return '已识别登录态';
  if (value === 'unauthenticated') return '未检测到登录态';
  return '登录信号待识别';
}

function verdictCopy(
  verdict: NonNullable<BrowserAuthorizationWorkspace['execution']>['verdict'],
  mode: BrowserAuthorizationMode,
): {
  title: string;
  detail: string;
  tone: 'danger' | 'success' | 'warning' | 'muted';
} {
  switch (verdict) {
    case 'confirmed':
      return {
        title: mode === 'vertical' ? '已确认低权限操作生效' : '已确认跨身份数据访问',
        detail: mode === 'vertical'
          ? '低权限身份发起操作后出现了独立可验证的业务状态变化；是否违反策略仍需结合角色定义。'
          : '一个身份用自己的登录态取得了另一身份正常响应中的稳定业务数据；是否构成缺陷取决于两身份权限关系与业务策略。',
        tone: 'warning',
      };
    case 'likely':
      return {
        title: mode === 'vertical' ? '低权限操作可能被接受' : '观察到跨身份响应吻合',
        detail: mode === 'vertical'
          ? '低权限探测被服务端接受，但还缺少独立的操作后状态证据。'
          : '交叉响应与目标身份的正常响应精确吻合，但尚缺稳定归属字段与同权限策略证据。',
        tone: 'warning',
      };
    case 'protected':
      return {
        title: '当前样本受到保护',
        detail: mode === 'vertical'
          ? '正常控制成立，低权限身份执行目标高权限动作时被明确拒绝。'
          : '双方正常访问成立，两项交叉访问均未取得对方资源。',
        tone: 'success',
      };
    case 'invalid-controls':
      return { title: '对照样本无效', detail: '正常对照没有建立，不能据此判断授权边界。', tone: 'warning' };
    default:
      return { title: '证据不足', detail: '本轮结果不能形成稳定结论，请检查基线和响应语义。', tone: 'muted' };
  }
}

function confidenceLabel(
  confidence: NonNullable<BrowserAuthorizationWorkspace['execution']>['confidence'],
): string {
  if (confidence === 'high') return '高';
  if (confidence === 'medium') return '中';
  if (confidence === 'low') return '低';
  return '无';
}

function authorizationOutcomeLabel(value?: string): string {
  if (value === 'success') return '成功';
  if (value === 'denied') return '明确拒绝';
  if (value === 'redirect') return '重定向';
  if (value === 'client-error') return '客户端错误';
  if (value === 'server-error') return '服务端错误';
  if (value === 'opaque') return '响应不可读';
  if (value === 'completed') return '已完成';
  if (value === 'failed') return '失败';
  if (value === 'skipped') return '已跳过';
  return value || '未执行';
}

function candidateLabel(candidate: BrowserAuthorizationBaselineCandidate): string {
  const status = candidate.statusCode ? ` · ${candidate.statusCode}` : '';
  let target = candidate.path;
  try {
    const parsed = new URL(candidate.url);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    // The bounded path supplied by Yak remains the fallback.
  }
  return `${candidate.method} ${target}${status}`;
}

function authorizationCandidateRoute(candidate: BrowserAuthorizationBaselineCandidate): string {
  try {
    const parsed = new URL(candidate.url);
    const normalizedPath = parsed.pathname
      .split('/')
      .map((segment) => {
        if (/^[0-9]+$/.test(segment)) return ':number';
        if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':uuid';
        if (/^[0-9a-f]{16,}$/i.test(segment)) return ':opaque';
        return segment;
      })
      .join('/');
    return [
      candidate.method.toUpperCase(),
      normalizedPath,
      [...parsed.searchParams.keys()].sort().join(','),
      candidate.resourceType,
    ].join(' ');
  } catch {
    return `${candidate.method.toUpperCase()} ${candidate.path} ${candidate.resourceType}`;
  }
}

function newestComparableAuthorizationPair(
  left: BrowserAuthorizationBaselineCandidate[],
  right: BrowserAuthorizationBaselineCandidate[],
): { left: BrowserAuthorizationBaselineCandidate; right: BrowserAuthorizationBaselineCandidate } | undefined {
  const eligibleLeft = left.filter((item) => item.eligible);
  const eligibleRight = right.filter((item) => item.eligible);
  const pairs = eligibleLeft.flatMap((leftItem) => eligibleRight
    .filter((rightItem) => authorizationCandidateRoute(leftItem) === authorizationCandidateRoute(rightItem))
    .map((rightItem) => ({
      left: leftItem,
      right: rightItem,
      recency: Math.min(leftItem.startedAt, rightItem.startedAt),
    })));
  return pairs.sort((a, b) => b.recency - a.recency)[0];
}

export function AuthorizationTestingWorkspace({
  state,
  setState,
  tabs,
  activeTab,
  bridge,
  refreshTabs,
  run,
  busy,
}: AuthorizationTestingWorkspaceProps) {
  const eligibleTabs = useMemo(
    () => tabs.filter((item) => item.url.startsWith('http://') || item.url.startsWith('https://')),
    [tabs],
  );
  const [hydrated, setHydrated] = useState(false);
  const [ui, dispatch] = useReducer(
    authorizationWorkspaceUIReducer,
    INITIAL_AUTHORIZATION_WORKSPACE_UI,
  );
  const {
    mode,
    leftTabId,
    rightTabId,
    leftLabel,
    rightLabel,
    inspection,
    workspace,
    candidates,
    selected,
    capture,
    selectedPlanCandidateId,
    canaryPaths,
  } = ui;
  const [localError, setLocalError] = useState('');
  const [identityNotice, setIdentityNotice] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [browserInstances, setBrowserInstances] = useState<BrowserAuthorizationInstance[]>([]);
  const [targetDeviceId, setTargetDeviceId] = useState('');

  const leftTab = eligibleTabs.find((item) => item.id === leftTabId);
  const rightTab = eligibleTabs.find((item) => item.id === rightTabId);
  const leftContext = contextForTab(inspection, leftTabId);
  const rightContext = contextForTab(inspection, rightTabId);
  const leftIsolationContextId = leftContext?.contextId || leftTab?.isolationContextId;
  const rightIsolationContextId = rightContext?.contextId || rightTab?.isolationContextId;
  const identityContextsSeparated = Boolean(
    leftIsolationContextId
    && rightIsolationContextId
    && leftIsolationContextId !== rightIsolationContextId,
  );
  const sameOrigin = Boolean(leftTab && rightTab && tabOrigin(leftTab) === tabOrigin(rightTab));
  const capabilityReady = bridge.state === 'connected'
    && Boolean(bridge.capabilities?.includes('yakit.browser_authorization.task'));
  const instanceDiscoveryReady = bridge.state === 'connected'
    && Boolean(bridge.capabilities?.includes('yakit.browser_authorization.instances'));
  const targetBrowserInstance = browserInstances.find((instance) => instance.deviceId === targetDeviceId);

  const refreshInspection = useCallback(async () => {
    const next = await request('isolation.inspect', {
      tabIds: eligibleTabs.length > 0 ? eligibleTabs.map((item) => item.id) : undefined,
    });
    dispatch({ type: 'patch', value: { inspection: next } });
  }, [eligibleTabs]);

  const refreshBrowserInstances = useCallback(async () => {
    if (!instanceDiscoveryReady) {
      setBrowserInstances([]);
      setTargetDeviceId('');
      return [];
    }
    const result = await request('authorization.yakit.instances');
    setBrowserInstances(result.instances);
    setTargetDeviceId((current) => (
      result.instances.some((instance) => !instance.current && instance.deviceId === current)
        ? current
        : result.instances.find((instance) => !instance.current)?.deviceId || ''
    ));
    return result.instances;
  }, [instanceDiscoveryReady]);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await browser.storage.session.get(SESSION_KEY);
        dispatch({ type: 'hydrate', value: stored[SESSION_KEY] });
      } catch {
        // Session persistence is an ergonomic optimization.
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!hydrated || workspace) return;
    const normalized = normalizeAuthorizationIdentityTabSelection({
      eligibleTabIds: eligibleTabs.map((item) => item.id),
      activeTabId: activeTab?.id,
      leftTabId,
      rightTabId,
    });
    if (normalized.leftTabId !== leftTabId || normalized.rightTabId !== rightTabId) {
      dispatch({
        type: 'patch',
        value: {
          leftTabId: normalized.leftTabId,
          rightTabId: normalized.rightTabId,
        },
      });
    }
  }, [activeTab?.id, eligibleTabs, hydrated, leftTabId, rightTabId, workspace]);

  useEffect(() => {
    if (!hydrated) return;
    const value = persistedAuthorizationWorkspaceUI(ui);
    void browser.storage.session.set({ [SESSION_KEY]: value }).catch(() => undefined);
  }, [
    canaryPaths, candidates, hydrated, leftLabel, leftTabId, mode, rightLabel, rightTabId,
    selected, selectedPlanCandidateId, workspace,
  ]);

  useEffect(() => {
    void refreshInspection().catch((error) => setLocalError(errorMessage(error)));
  }, [refreshInspection]);

  useEffect(() => {
    void refreshBrowserInstances().catch((error) => setLocalError(errorMessage(error)));
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshBrowserInstances().catch((error) => setLocalError(errorMessage(error)));
      }
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [refreshBrowserInstances]);

  useEffect(() => {
    if (!hydrated || workspace || !leftTab || !rightTab) return;
    const reason = authorizationIdentityOptionDisabledReason({
      candidateTabId: rightTab.id,
      candidateIsolationContextId: rightIsolationContextId,
      otherTabId: leftTab.id,
      otherIsolationContextId: leftIsolationContextId,
      otherLabel: '身份 A',
    });
    if (!reason) return;
    dispatch({ type: 'patch', value: { rightTabId: undefined } });
    setIdentityNotice(
      leftTab.id === rightTab.id
        ? '身份 B 已清空：同一个页面不能同时代表两个身份'
        : '身份 B 已清空：该页面与身份 A 共享同一登录态',
    );
  }, [
    hydrated,
    leftIsolationContextId,
    leftTab?.id,
    rightIsolationContextId,
    rightTab?.id,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace) return;
    void Promise.all((['left', 'right'] as const).map(async (side) => {
      const target = workspace[side].target;
      const status = await request('network.capture.status', target);
      dispatch({ type: 'capture.update', side, status });
    })).catch(() => undefined);
  }, [workspace?.id]);

  useEffect(() => {
    const listener = (message: unknown) => {
      const input = message as { action?: string; payload?: { tabId?: number } };
      if (input?.action !== 'network.capture.changed') return;
      const side = input.payload?.tabId === workspace?.left.target.tabId
        ? 'left'
        : input.payload?.tabId === workspace?.right.target.tabId ? 'right' : undefined;
      if (!side || !workspace) return;
      void request('network.capture.status', workspace[side].target)
        .then((status) => dispatch({ type: 'capture.update', side, status }))
        .catch(() => undefined);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return undefined;
    setClock(Date.now());
    const timer = globalThis.setInterval(() => setClock(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, [workspace?.id]);

  const resetWorkspace = async () => {
    dispatch({ type: 'workspace.reset' });
    setLocalError('');
    await browser.storage.session.remove(SESSION_KEY).catch(() => undefined);
  };

  const assignIdentityTab = (side: BrowserAuthorizationSide, nextTabId: number | undefined) => {
    setLocalError('');
    setIdentityNotice('');
    dispatch({
      type: 'patch',
      value: side === 'left' ? { leftTabId: nextTabId } : { rightTabId: nextTabId },
    });
  };

  const openIncognitoSettings = () => run(async () => {
    await browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
  }, '已打开扩展详情，请开启“允许在无痕模式下运行”');

  const recheckIsolationCapability = () => run(async () => {
    await refreshTabs();
    await refreshInspection();
  }, '浏览器隔离能力已重新检测');

  const createIsolatedIdentity = () => run(async () => {
    if (!leftTab) throw new Error('请先选择身份 A 的页面');
    const result = inspection?.browser === 'firefox'
      ? await request('isolation.container.open', { url: leftTab.url, name: rightLabel || '账号 B' })
      : await request('isolation.incognito.open', { url: leftTab.url });
    await refreshTabs();
    dispatch({ type: 'patch', value: { rightTabId: result.tab.id } });
    await refreshInspection();
  }, inspection?.browser === 'firefox' ? '已创建独立 Container，请在新页面登录身份 B' : '已打开无痕身份页面，请在新页面登录身份 B');

  const prepareWorkspace = () => run(async () => {
    setLocalError('');
    if (!leftTab || !rightTab) throw new Error('请选择身份 A 和身份 B 的页面');
    if (leftTab.id === rightTab.id) throw new Error('A/B 身份不能使用同一个标签页');
    if (!sameOrigin) throw new Error('A/B 页面必须属于同一站点 Origin');
    if (!capabilityReady) throw new Error('当前 Yak 引擎不支持插件授权测试任务，请更新并重新连接引擎');

    const nextState = await request('grant.create', authorizationShareGrantInput(state, [leftTab, rightTab]));
    setState(nextState);
    const nextWorkspace = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.workspace.create',
      {
        mode,
        left: { tabId: leftTab.id, frameId: 0, accountLabel: leftLabel.trim() || '账号 A' },
        right: { tabId: rightTab.id, frameId: 0, accountLabel: rightLabel.trim() || '账号 B' },
      },
    );
    dispatch({ type: 'workspace.initialize', workspace: nextWorkspace });
    if (nextWorkspace.state === 'ready' || nextWorkspace.state === 'conditional') {
      const [leftStatus, rightStatus] = await Promise.all([
        request('network.capture.start', {
          ...nextWorkspace.left.target,
          captureHeaders: true,
          captureBody: true,
          maxEntries: 200,
          maxBodyBytes: 64 * 1024,
        }),
        request('network.capture.start', {
          ...nextWorkspace.right.target,
          captureHeaders: true,
          captureBody: true,
          maxEntries: 200,
          maxBodyBytes: 64 * 1024,
        }),
      ]);
      dispatch({ type: 'capture.replace', capture: { left: leftStatus, right: rightStatus } });
    }
  }, 'A/B 身份已验证，双方请求捕获已开始');

  const openCrossBrowserWorkspace = () => run(async () => {
    const sourceTab = leftTab || activeTab || eligibleTabs[0];
    if (!sourceTab) throw new Error('当前浏览器没有可用于测试的 HTTP(S) 页面');
    if (!instanceDiscoveryReady) throw new Error('当前 Yak 版本不支持读取在线实例，请更新引擎并重新连接插件');
    if (!bridge.capabilities?.includes('yakit.browser_authorization.open')) {
      throw new Error('当前 Yak 引擎不支持打开跨浏览器工作区');
    }
    const instances = await refreshBrowserInstances();
    const target = instances.find((instance) => (
      !instance.current && instance.deviceId === targetDeviceId
    )) || instances.find((instance) => !instance.current);
    if (!target) throw new Error('没有检测到另一个在线的 YTray 浏览器实例，请确认其插件已连接同一 Yak 引擎');
    setTargetDeviceId(target.deviceId);
    await request('authorization.yakit.open', {
      tabId: sourceTab.id,
      mode,
      targetDeviceId: target.deviceId,
    });
  }, '已将两个浏览器实例带入 Yakit');

  const refreshWorkspaceDocuments = async (): Promise<BrowserAuthorizationWorkspace> => {
    if (!workspace || !leftTab || !rightTab) throw new Error('请先建立 A/B 工作区');
    const nextState = await request('grant.refresh');
    setState(nextState);
    const grant = nextState.activeGrant;
    const leftTarget = grant?.targets.find((target) => (
      target.tabId === workspace.left.target.tabId
      && target.frameId === workspace.left.target.frameId
    ));
    const rightTarget = grant?.targets.find((target) => (
      target.tabId === workspace.right.target.tabId
      && target.frameId === workspace.right.target.frameId
    ));
    if (!leftTarget || !rightTarget) {
      throw new Error('当前共享会话已不再包含身份 A/B，请重新建立工作区');
    }
    const documentChanged = (
      leftTarget.documentId !== workspace.left.target.documentId
      || rightTarget.documentId !== workspace.right.target.documentId
    );
    if (!documentChanged && workspace.expiresAt > Date.now()) return workspace;

    const renewed = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.workspace.create',
      {
        mode: workspace.mode,
        left: {
          tabId: leftTab.id,
          frameId: 0,
          accountLabel: workspace.left.accountLabel || leftLabel.trim() || '账号 A',
        },
        right: {
          tabId: rightTab.id,
          frameId: 0,
          accountLabel: workspace.right.accountLabel || rightLabel.trim() || '账号 B',
        },
      },
    );
    dispatch({ type: 'workspace.initialize', workspace: renewed });
    const [leftStatus, rightStatus] = await Promise.all([
      request('network.capture.status', renewed.left.target),
      request('network.capture.status', renewed.right.target),
    ]);
    dispatch({ type: 'capture.replace', capture: { left: leftStatus, right: rightStatus } });
    return renewed;
  };

  const refreshCandidates = () => run(async () => {
    const currentWorkspace = await refreshWorkspaceDocuments();
    const [left, right] = await Promise.all([
      runBrowserAuthorizationTask<BrowserAuthorizationBaselineCandidate[]>(
        'authorization.baseline.candidates',
        { workspaceId: currentWorkspace.id, side: 'left', limit: 50 },
      ),
      runBrowserAuthorizationTask<BrowserAuthorizationBaselineCandidate[]>(
        'authorization.baseline.candidates',
        { workspaceId: currentWorkspace.id, side: 'right', limit: 50 },
      ),
    ]);
    dispatch({
      type: 'baselines.loaded',
      candidates: { left, right },
      selected: {
        left: left.some((item) => item.id === selected.left)
        ? selected.left
        : left.find((item) => item.eligible)?.id || '',
        right: right.some((item) => item.id === selected.right)
        ? selected.right
        : right.find((item) => item.eligible)?.id || '',
      },
    });
  }, mode === 'horizontal' ? '已读取双方请求，请确认它们属于同一业务动作' : '已读取低权限控制请求与高权限目标动作');

  const bindBaselines = () => run(async () => {
    if (!workspace || !selected.left || !selected.right) throw new Error('请为 A/B 双方各选择一条正常请求');
    let next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.baseline.bind',
      { workspaceId: workspace.id, side: 'left', networkRequestId: selected.left },
    );
    next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.baseline.bind',
      { workspaceId: workspace.id, side: 'right', networkRequestId: selected.right },
    );
    const suggested = next.mode === 'horizontal'
      ? next.baselinePair.resourceCandidates.find((item) => !item.requiresLogicalBinding)
      : next.baselinePair.operationCandidates.find((item) => item.eligible && !item.requiresDynamicRebuild);
    dispatch({
      type: 'baselines.bound',
      workspace: next,
      selectedPlanCandidateId: suggested?.id || '',
    });
  }, '双方正常请求已封存为授权基线');

  const autoAnalyzeBaselines = () => run(async () => {
    const currentWorkspace = await refreshWorkspaceDocuments();
    const [leftCandidates, rightCandidates] = await Promise.all([
      runBrowserAuthorizationTask<BrowserAuthorizationBaselineCandidate[]>(
        'authorization.baseline.candidates',
        { workspaceId: currentWorkspace.id, side: 'left', limit: 50 },
      ),
      runBrowserAuthorizationTask<BrowserAuthorizationBaselineCandidate[]>(
        'authorization.baseline.candidates',
        { workspaceId: currentWorkspace.id, side: 'right', limit: 50 },
      ),
    ]);
    const pair = mode === 'horizontal'
      ? newestComparableAuthorizationPair(leftCandidates, rightCandidates)
      : {
          left: leftCandidates.find((item) => item.eligible),
          right: rightCandidates.find((item) => item.eligible),
        };
    if (!pair?.left || !pair.right) {
      throw new Error(mode === 'horizontal'
        ? '还没有发现 A/B 双方可比较的同类操作。请分别执行一次相同业务动作后重试。'
        : '还没有同时发现低权限控制请求与高权限目标动作。请在 A/B 页面各执行一次后重试。');
    }
    dispatch({
      type: 'baselines.loaded',
      candidates: { left: leftCandidates, right: rightCandidates },
      selected: { left: pair.left.id, right: pair.right.id },
    });
    let next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.baseline.bind',
      { workspaceId: currentWorkspace.id, side: 'left', networkRequestId: pair.left.id },
    );
    next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.baseline.bind',
      { workspaceId: currentWorkspace.id, side: 'right', networkRequestId: pair.right.id },
    );
    const suggested = next.mode === 'horizontal'
      ? next.baselinePair.resourceCandidates.find((item) => !item.requiresLogicalBinding)
      : next.baselinePair.operationCandidates.find((item) => item.eligible && !item.requiresDynamicRebuild);
    dispatch({
      type: 'baselines.bound',
      workspace: next,
      selectedPlanCandidateId: suggested?.id || '',
    });
    if (next.baselinePair.state !== 'matched') {
      throw new Error(`最新两项操作不可比较：${next.baselinePair.reasons[0] || '业务路由或请求结构不同'}`);
    }
  }, mode === 'horizontal'
    ? '已自动找到并绑定双方最近一次同类业务操作'
    : '已自动绑定低权限控制请求与高权限目标动作');

  const createPlan = () => run(async () => {
    if (!workspace || !selectedPlanCandidateId) throw new Error('请选择测试目标');
    const next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.plan.create',
      {
        workspaceId: workspace.id,
        candidateId: selectedPlanCandidateId,
        canaryPaths: canaryPaths.split(',').map((item) => item.trim()).filter(Boolean),
      },
    );
    dispatch({ type: 'workspace.updated', workspace: next });
  }, '确定性测试计划已生成，请先审阅再执行');

  const executePlan = () => run(async () => {
    if (!workspace?.plan) throw new Error('请先生成测试计划');
    if (workspace.plan.state === 'blocked') throw new Error('当前计划被阻止，请根据原因补充证据');
    const sideEffect = workspace.plan.cases.some((item) => item.sideEffect);
    const approved = window.confirm(
      `${workspace.mode === 'vertical' ? '垂直' : '水平'}授权测试将发送 ${workspace.plan.requestBudget} 个真实请求`
      + `${sideEffect ? '，其中包含可能改变业务状态的请求' : ''}。仅应对你有权测试的目标继续。`,
    );
    if (!approved) return;
    const next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.plan.execute',
      {
        workspaceId: workspace.id,
        planId: workspace.plan.id,
        approveSideEffects: sideEffect,
      },
      120_000,
    );
    dispatch({ type: 'workspace.updated', workspace: next });
  }, '授权测试矩阵执行完成');

  const stopCapture = (side: BrowserAuthorizationSide) => run(async () => {
    if (!workspace) return;
    const status = await request('network.capture.stop', {
      tabId: workspace[side].target.tabId,
      frameId: workspace[side].target.frameId,
    });
    dispatch({ type: 'capture.update', side, status });
  }, `${side === 'left' ? leftLabel : rightLabel} 的请求捕获已停止`);

  const refreshWorkspace = () => run(async () => {
    if (!workspace) return;
    const currentWorkspace = await refreshWorkspaceDocuments();
    const next = await runBrowserAuthorizationTask<BrowserAuthorizationWorkspace>(
      'authorization.workspace.inspect',
      { workspaceId: currentWorkspace.id, revalidate: true },
    );
    dispatch({ type: 'workspace.updated', workspace: next });
  }, '工作区状态已复核');

  const planCandidates = workspace?.mode === 'horizontal'
    ? workspace.baselinePair.resourceCandidates
    : workspace?.baselinePair.operationCandidates;
  const executionCopy = workspace?.execution
    ? verdictCopy(workspace.execution.verdict, workspace.mode)
    : undefined;
  const incognitoAccessDenied = inspection?.browser === 'chromium'
    && inspection.capabilities.incognitoAccess === 'denied';
  const firefoxContainerUnavailable = inspection?.browser === 'firefox'
    && !inspection.capabilities.containerTabs;
  const identityStageReady = Boolean(
    leftTab && rightTab && sameOrigin && identityContextsSeparated && capabilityReady,
  );
  const prepareHint = !leftTab
    ? '先选择当前登录页作为身份 A'
    : !rightTab
      ? '还需要一个隔离登录的身份 B'
      : !sameOrigin
        ? 'A/B 页面必须属于同一站点'
        : !leftIsolationContextId || !rightIsolationContextId
          ? '正在确认两个页面的登录态边界'
          : !identityContextsSeparated
            ? 'A/B 页面仍然共享同一登录态'
            : !capabilityReady
              ? '请先连接支持授权测试的 Yak 引擎'
              : '两个身份页面已就绪';

  return <div className="section-view authorization-workspace">
    <div className="page-heading authorization-heading">
      <div>
        <span className="page-eyebrow">Browser-native authorization testing</span>
        <h1>授权测试工作区</h1>
        <p>从已经登录的两个页面建立身份隔离证明，录制双方正常请求，再由 Yak 生成并执行最小交叉矩阵。</p>
      </div>
      <div className="authorization-heading-actions">
        <span className={`authorization-engine-state ${capabilityReady ? 'ready' : ''}`}>
          <i />{capabilityReady ? '引擎可用' : '引擎能力不可用'}
        </span>
        {workspace && <span
          className="authorization-workspace-lifetime"
          title={`引擎实例 ${workspace.engineInstanceId} · 到期时间 ${new Date(workspace.expiresAt).toLocaleString()}`}
        >
          工作区剩余 {formatWorkspaceRemaining(workspace.expiresAt, clock)}
        </span>}
        {workspace && <Button variant="ghost" disabled={busy} onClick={() => void refreshWorkspace()}>
          <RefreshCw size={15} />复核状态
        </Button>}
        {workspace && bridge.capabilities?.includes('yakit.browser_authorization.open') && <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run(
            async () => { await request('authorization.yakit.open', { workspaceId: workspace.id }); },
            '已在 Yakit 打开完整证据工作区',
          )}
        >
          <ExternalLink size={15} />在 Yakit 深入分析
        </Button>}
        <Button variant="ghost" disabled={busy} onClick={() => void resetWorkspace()}>
          <RotateCcw size={15} />新建
        </Button>
      </div>
    </div>

    {localError && <div className="authorization-inline-error">
      <AlertTriangle size={16} />{localError}
      <Button size="sm" variant="ghost" onClick={() => setLocalError('')}>关闭</Button>
    </div>}

    <div className="authorization-flow-strip" aria-label="授权测试步骤">
      {[
        ['1', '身份与隔离', Boolean(workspace)],
        ['2', '正常请求', Boolean(workspace?.baselines.left && workspace?.baselines.right)],
        ['3', '确定性计划', Boolean(workspace?.plan)],
        ['4', '结果证据', Boolean(workspace?.execution)],
      ].map(([index, label, complete], position) => <div className={complete ? 'complete' : ''} key={String(label)}>
        <span>{complete ? <Check size={13} /> : index}</span><strong>{label}</strong>
        {position < 3 && <ArrowRight size={14} />}
      </div>)}
    </div>

    {!workspace && <section className="authorization-cross-browser">
      <span><UserRoundPlus size={18} /></span>
      <div>
        <strong>选择独立浏览器实例</strong>
        <small>{!instanceDiscoveryReady
          ? '当前 Yak 版本不能读取在线实例，请更新引擎后重连。'
          : browserInstances.length < 2
            ? '只检测到当前浏览器，请先用 YTray 启动并连接另一个实例。'
            : '当前页面作为资源所有者，所选浏览器作为独立对照账号。'}</small>
        <div className="authorization-cross-browser__instances">
          {browserInstances.map((instance) => <button
            key={instance.deviceId}
            type="button"
            disabled={instance.current}
            aria-pressed={!instance.current && instance.deviceId === targetDeviceId}
            className={instance.current ? 'is-current' : instance.deviceId === targetDeviceId ? 'is-selected' : ''}
            onClick={() => setTargetDeviceId(instance.deviceId)}
          >
            <b>{instance.badge}</b>
            <span>{instance.current ? '当前' : instance.deviceId === targetDeviceId ? '已选择' : '在线'}</span>
          </button>)}
          <button
            type="button"
            className="is-refresh"
            aria-label="刷新在线浏览器实例"
            onClick={() => void refreshBrowserInstances().catch((error) => setLocalError(errorMessage(error)))}
          ><RefreshCw size={13} /></button>
        </div>
      </div>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => void openCrossBrowserWorkspace()}
      >
        <ExternalLink size={15} />{targetBrowserInstance
          ? `用 ${targetBrowserInstance.badge} 在 Yakit 测试`
          : '选择实例并在 Yakit 测试'}
      </Button>
    </section>}

    {!workspace ? <section className="authorization-identity-stage">
      <div className="authorization-mode">
        <span>测试类型</span>
        <div role="radiogroup" aria-label="测试类型">
          <button type="button" role="radio" aria-checked={mode === 'horizontal'} className={mode === 'horizontal' ? 'active' : ''} onClick={() => dispatch({ type: 'patch', value: { mode: 'horizontal' } })}>
            <strong>水平越权</strong>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'vertical'} className={mode === 'vertical' ? 'active' : ''} onClick={() => dispatch({ type: 'patch', value: { mode: 'vertical' } })}>
            <strong>垂直越权</strong>
          </button>
        </div>
        <small className="authorization-mode-description">{mode === 'horizontal'
          ? '同权限不同账号，交换资源标识'
          : '低权限身份尝试高权限业务动作'}</small>
      </div>

      <div className="authorization-identity-guide" aria-label="准备两个身份">
        <span className={leftTab ? 'complete' : 'current'}><b>{leftTab ? <Check size={12} /> : '1'}</b>当前登录页作为 A</span>
        <ArrowRight size={14} />
        <span className={rightTab ? 'complete' : leftTab ? 'current' : ''}><b>{rightTab ? <Check size={12} /> : '2'}</b>隔离页面登录 B</span>
        <ArrowRight size={14} />
        <span className={identityStageReady ? 'complete' : ''}><b>{identityStageReady ? <Check size={12} /> : '3'}</b>验证并开始捕获</span>
      </div>

      <div className="authorization-identity-rail">
        <IdentitySlot
          side="A"
          title={mode === 'vertical' ? '低权限身份' : '身份 A'}
          label={leftLabel}
          setLabel={(value) => dispatch({ type: 'patch', value: { leftLabel: value } })}
          tabId={leftTabId}
          setTabId={(value) => assignIdentityTab('left', value)}
          tabs={eligibleTabs}
          context={leftContext}
          disabledReason={(item) => authorizationIdentityOptionDisabledReason({
            candidateTabId: item.id,
            candidateIsolationContextId: contextForTab(inspection, item.id)?.contextId || item.isolationContextId,
            otherTabId: rightTabId,
            otherIsolationContextId: rightIsolationContextId,
            otherLabel: '身份 B',
          })}
          emptyHint="选择你现在已经登录的页面，作为基准身份 A"
        />
        <div className="authorization-isolation-axis" aria-live="polite">
          <Fingerprint size={23} />
          <strong>{incognitoAccessDenied ? '需要无痕权限' : !leftTab ? '先准备身份 A' : !rightTab ? '再准备身份 B' : '浏览器隔离'}</strong>
          <span className={sameOrigin ? 'valid' : ''}>{sameOrigin ? '已是同一站点' : leftTab ? 'B 需打开同一站点' : '选择当前登录页'}</span>
          <span>{identityContextsSeparated ? '浏览上下文已分离' : rightTab ? '等待隔离验证' : 'A/B 不能共用登录态'}</span>
          {incognitoAccessDenied ? <div className="authorization-isolation-actions">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void openIncognitoSettings()}>
              <ExternalLink size={14} />开启无痕权限
            </Button>
            <button type="button" disabled={busy} onClick={() => void recheckIsolationCapability()}>已开启，重新检测</button>
          </div> : <Button
            size="sm"
            variant="secondary"
            disabled={busy || !leftTab || !inspection || firefoxContainerUnavailable}
            onClick={() => void createIsolatedIdentity()}
          >
            <UserRoundPlus size={14} />{!inspection
              ? '正在检测隔离能力'
              : inspection.browser === 'firefox'
                ? `${rightTab ? '重新创建' : '创建'} Container 身份 B`
                : `${rightTab ? '重新创建' : '创建'}无痕身份 B`}
          </Button>}
        </div>
        <IdentitySlot
          side="B"
          title={mode === 'vertical' ? '高权限身份' : '身份 B'}
          label={rightLabel}
          setLabel={(value) => dispatch({ type: 'patch', value: { rightLabel: value } })}
          tabId={rightTabId}
          setTabId={(value) => assignIdentityTab('right', value)}
          tabs={eligibleTabs}
          context={rightContext}
          disabledReason={(item) => authorizationIdentityOptionDisabledReason({
            candidateTabId: item.id,
            candidateIsolationContextId: contextForTab(inspection, item.id)?.contextId || item.isolationContextId,
            otherTabId: leftTabId,
            otherIsolationContextId: leftIsolationContextId,
            otherLabel: '身份 A',
          })}
          emptyHint={identityNotice || '在中间创建隔离页面，登录另一个账号后会自动选为身份 B'}
        />
      </div>

      <div className="authorization-prepare-bar">
        <div>
          <LockKeyhole size={18} />
          <span><strong>原始 Cookie、Storage 与请求值不会进入界面</strong><small>Yak 只接收短时上下文句柄、字段指纹和用户选择的真实请求。</small></span>
        </div>
        <div className="authorization-prepare-action">
          <small>{prepareHint}</small>
          <Button
            variant="primary"
            disabled={busy || !identityStageReady}
            onClick={() => void prepareWorkspace()}
          >
            <Fingerprint size={16} />验证身份并开始捕获
          </Button>
        </div>
      </div>
    </section> : <>
      <section className={`authorization-proof-band ${workspace.state}`}>
        <div>
          {workspace.proof.level === 'strong' ? <CircleCheck size={20} /> : <ShieldAlert size={20} />}
          <span><strong>{proofLabel(workspace)}</strong><small>{workspace.proof.reasons[0] || '身份隔离证明已建立'}</small></span>
        </div>
        <dl>
          <div><dt>Origin</dt><dd>{workspace.proof.sameOrigin ? '一致' : '不一致'}</dd></div>
          <div><dt>Cookie Store</dt><dd>{relationLabel(workspace.proof.cookieStoreRelation)}</dd></div>
          <div><dt>账号证据</dt><dd>{relationLabel(workspace.proof.accountEvidenceRelation)}</dd></div>
          <div><dt>请求认证</dt><dd>{relationLabel(workspace.proof.requestCredentialRelation)}</dd></div>
          <div><dt>刷新复核</dt><dd>{workspace.proof.refreshCheck === 'passed'
            ? '通过'
            : workspace.proof.refreshCheck === 'not-required' ? '无需' : '失败'}</dd></div>
        </dl>
      </section>

      {workspace.state === 'stale' || workspace.state === 'blocked' ? <section className="authorization-recovery">
        <ShieldAlert size={20} />
        <div><strong>{workspace.state === 'stale' ? '工作区已经失效' : '当前身份隔离不足'}</strong><p>{workspace.recovery?.message || workspace.staleReason || workspace.proof.reasons.join('；')}</p></div>
        <Button variant="primary" onClick={() => void resetWorkspace()}>重新选择身份</Button>
      </section> : <>
        <section className="authorization-baseline-stage">
          <div className="authorization-section-heading">
            <div><span>STEP 02</span><h2>执行目标动作，插件自动识别</h2><p>{mode === 'horizontal'
              ? '分别在 A/B 页面执行一次相同业务动作；插件会从最近请求中自动配对同一路由，不需要手工挑四项矩阵。'
              : '在 A 页面执行低权限正常动作，在 B 页面执行目标高权限动作；插件会自动封存最近样本。'}</p></div>
            <Button variant="primary" disabled={busy} onClick={() => void autoAnalyzeBaselines()}>
              <RefreshCw size={15} />自动分析最新操作
            </Button>
          </div>
          <div className="authorization-baseline-lanes">
            {(['left', 'right'] as const).map((side) => {
              const slot = workspace[side];
              const sideCandidates = candidates[side];
              const sideCapture = capture[side];
              return <div className="authorization-baseline-lane" key={side}>
                <header>
                  <span>{side === 'left' ? 'A' : 'B'}</span>
                  <div><strong>{slot.accountLabel || (side === 'left' ? leftLabel : rightLabel)}</strong><small>{authenticationStatusLabel(slot.authentication.status)} · {shortHost(side === 'left' ? leftTab : rightTab)}</small></div>
                  <span className={`authorization-capture-dot ${sideCapture?.active ? 'active' : ''}`}>
                    <i />{sideCapture?.active ? `${sideCapture.count} 条` : '已停止'}
                  </span>
                  {sideCapture?.active && <Button size="icon" variant="ghost" title="停止捕获" onClick={() => void stopCapture(side)}><Square size={14} /></Button>}
                </header>
                {sideCandidates.length === 0 ? <div className="authorization-candidate-empty">
                  <Play size={17} /><span>回到该页面执行一次业务动作，再点击上方“自动分析最新操作”。</span>
                </div> : <div className="authorization-candidate-list">
                  {sideCandidates.slice(0, 8).map((candidate) => <label className={`${selected[side] === candidate.id ? 'selected' : ''} ${candidate.eligible ? '' : 'disabled'}`} key={candidate.id}>
                    <input
                      type="radio"
                      name={`authorization-${side}-candidate`}
                      checked={selected[side] === candidate.id}
                      disabled={!candidate.eligible}
                      onChange={() => dispatch({
                        type: 'patch',
                        value: { selected: { ...selected, [side]: candidate.id } },
                      })}
                    />
                    <span><strong>{candidateLabel(candidate)}</strong><small>{candidate.eligible ? new URL(candidate.url).host : candidate.reasons[0]}</small></span>
                  </label>)}
                </div>}
              </div>;
            })}
          </div>
          <div className="authorization-baseline-confirm">
            <span>{selected.left && selected.right ? '如需调整，可在上方手动选择其他请求' : '自动识别失败时，可展开候选手动选择'}</span>
            <Button variant="secondary" disabled={busy || !selected.left || !selected.right} onClick={() => void bindBaselines()}>
              <Check size={15} />使用当前选择
            </Button>
          </div>
        </section>

        {workspace.baselinePair.state !== 'waiting' && <section className="authorization-plan-stage">
          <div className="authorization-section-heading">
            <div><span>STEP 03</span><h2>{mode === 'horizontal' ? '选择资源边界' : '选择高权限动作'}</h2><p>{workspace.baselinePair.reasons[0]}</p></div>
            <span className={`authorization-pair-state ${workspace.baselinePair.state}`}>{workspace.baselinePair.state === 'matched' ? '基线已匹配' : '基线不匹配'}</span>
          </div>
          {workspace.baselinePair.state === 'matched' && planCandidates && planCandidates.length > 0 ? <div className="authorization-plan-layout">
            <div className="authorization-plan-candidates">
              {planCandidates.map((candidate) => {
                const blocked = 'requiresLogicalBinding' in candidate
                  ? candidate.requiresLogicalBinding
                  : !candidate.eligible || candidate.requiresDynamicRebuild;
                const title = 'location' in candidate
                  ? `${candidate.location}.${candidate.path}`
                  : `${candidate.method} ${candidate.path}`;
                const meta = 'confidence' in candidate
                  ? `${candidate.source === 'logical' ? '明文逻辑字段' : '线上字段'} · ${candidate.confidence}`
                  : `${candidate.sideEffect ? '可能有副作用' : '只读候选'}${candidate.requiresDynamicRebuild ? ' · 需要动态重建' : ''}`;
                return <button
                  key={candidate.id}
                  className={selectedPlanCandidateId === candidate.id ? 'selected' : ''}
                  disabled={blocked}
                  onClick={() => dispatch({
                    type: 'patch',
                    value: { selectedPlanCandidateId: candidate.id },
                  })}
                >
                  <span className="authorization-radio-mark" />
                  <span><strong>{title}</strong><small>{meta}</small><em>{candidate.reasons[0]}</em></span>
                  {blocked && <span className="authorization-advanced-label">需明文网关</span>}
                </button>;
              })}
            </div>
            <div className="authorization-plan-review">
              <label><span>响应语义路径 <small>可选，逗号分隔</small></span><input value={canaryPaths} onChange={(event) => dispatch({ type: 'patch', value: { canaryPaths: event.target.value } })} placeholder="data.owner.id, data.account" /></label>
              {!workspace.plan ? <div className="authorization-plan-placeholder">
                <LockKeyhole size={19} /><strong>先编译，后发送</strong><p>Yak 会固定请求预算、交叉方向和只允许替换的字段，不由 UI 临时拼接请求。</p>
              </div> : <div className={`authorization-plan-summary ${workspace.plan.state}`}>
                <strong>{workspace.plan.state === 'blocked' ? '计划被阻止' : `${workspace.plan.requestBudget} 个真实请求`}</strong>
                <span>{workspace.plan.cases.map((item) => item.label).join(' → ')}</span>
                <small>{workspace.plan.reasons[0]}</small>
              </div>}
              <div className="authorization-plan-actions">
                <Button disabled={busy || !selectedPlanCandidateId} onClick={() => void createPlan()}>生成测试计划</Button>
                <Button variant="primary" disabled={busy || !workspace.plan || workspace.plan.state === 'blocked'} onClick={() => void executePlan()}>
                  <Play size={15} />审阅并执行
                </Button>
              </div>
            </div>
          </div> : workspace.baselinePair.state === 'matched' ? <div className="authorization-no-candidates">
            <ShieldAlert size={20} /><div><strong>没有可直接执行的确定性候选</strong><p>当前请求可能使用加密 Body、签名或动态字段。请先在“网络活动 → 明文网关”建立转换证据，再回到这里刷新工作区。</p></div>
            <a href="#network"><ExternalLink size={14} />打开明文网关</a>
          </div> : <div className="authorization-no-candidates">
            <AlertTriangle size={20} /><div><strong>A/B 不是同一类业务请求</strong><p>{workspace.baselinePair.reasons.join('；')}</p></div>
          </div>}
        </section>}

        {workspace.execution && executionCopy && <section className={`authorization-result ${executionCopy.tone}`}>
          <header>
            <div><Fingerprint size={23} /><span><strong>{executionCopy.title}</strong><small>{executionCopy.detail}</small></span></div>
            <div><strong>{confidenceLabel(workspace.execution.confidence)}</strong><small>证据置信度</small></div>
          </header>
          <div className="authorization-result-cases">
            {workspace.execution.cases.map((item, index) => <div key={item.id}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{item.label}</strong><small>{item.result ? `${item.result.status} ${item.result.statusText} · ${compactDuration(item.result.durationMs)}` : item.error || authorizationOutcomeLabel(item.state)}</small></div>
              <em className={item.result?.outcome || item.state}>{authorizationOutcomeLabel(item.result?.outcome || item.state)}</em>
            </div>)}
          </div>
          {workspace.execution.reasons.length > 0 && <p>{workspace.execution.reasons.join('；')}</p>}
          {workspace.execution.evidenceAvailable && <AuthorizationEvidenceWorkbench
            workspace={workspace}
            onWorkspaceChange={(next) => dispatch({ type: 'workspace.updated', workspace: next })}
          />}
        </section>}
      </>}
    </>}
  </div>;
}
