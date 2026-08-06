import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Braces, Bug, Check, ChevronDown, ChevronRight, CirclePause, Clock3, Code2, Copy,
  Crosshair, FileKey2, Fingerprint, Layers3, Play, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Trash2, Unplug, Variable, Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage, request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, BrowserDeepCaptureFrame, BrowserDeepCaptureMatcher, BrowserDeepCaptureStatus,
  BrowserPageCallable, BrowserPageCallableExecution,
  BrowserProfileInferenceCandidate, BrowserRecordingEvent,
} from '@/types/models';
import './deep-capture-workspace.css';
import { cryptoDeepCaptureMatcher } from '@/features/browser-crypto/model';
import { capturedCallableSample, type CapturedCallableSample } from './callable-sample';

type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface DeepCaptureWorkspaceProps {
  tab?: ActiveTabInfo;
  selectedEvent?: BrowserRecordingEvent;
  selectedCandidate?: BrowserProfileInferenceCandidate;
  autoArmRequest?: number;
  recoveryProfileId?: string;
  autoRecoveryRequest?: number;
  busy: boolean;
  run: RunTask;
  onPausedChange?: (paused: boolean) => void;
  onUseRecommendedCallable?: (
    candidate: BrowserProfileInferenceCandidate,
    callable: BrowserPageCallable,
    sample?: CapturedCallableSample,
  ) => void | Promise<void>;
  onRecoveryCaptured?: (profileId: string) => void | Promise<void>;
}

const STATUS_LABELS: Record<BrowserDeepCaptureStatus['state'], string> = {
  detached: '未附加',
  attached: '已附加',
  armed: '等待命中',
  paused: '现场已暂停',
  captured: '现场已释放',
  error: '需要处理',
};

function eventMatcher(
  event?: BrowserRecordingEvent,
  candidate?: BrowserProfileInferenceCandidate,
): BrowserDeepCaptureMatcher | undefined {
  if (!event) return undefined;
  const frameHints = candidate?.capturePlan?.matcherEventId === event.id
    ? candidate.capturePlan.frameHints
    : undefined;
  const crypto = cryptoDeepCaptureMatcher(event);
  if (crypto) return { ...crypto, frameHints };
  if (['fetch', 'xhr', 'form'].includes(event.kind) && event.url) {
    return { kind: 'request', urlPattern: event.url, frameHints };
  }
  if (['beacon', 'worker', 'message'].includes(event.kind) && event.wrapperHandleId) {
    return {
      kind: 'boundary',
      eventKind: event.kind as 'beacon' | 'worker' | 'message',
      operation: event.operation,
      wrapperHandleId: event.wrapperHandleId,
      scriptUrl: event.scriptUrl,
      frameHints,
    };
  }
  return undefined;
}

function compactUrl(value: string): string {
  if (!value) return '内联脚本';
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function jsonPreview(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const RISK_LABELS: Record<'network' | 'dom' | 'navigation' | 'storage', string> = {
  network: '包含网络发送',
  dom: '读取或修改 DOM',
  navigation: '可能触发导航',
  storage: '访问页面存储',
};

const FRAME_SOURCE_LABELS: Record<BrowserDeepCaptureFrame['sourceKind'], string> = {
  page: '页面函数',
  'extension-hook': '插件 Hook',
  library: '依赖库',
};

export function DeepCaptureWorkspace({
  tab,
  selectedEvent,
  selectedCandidate,
  autoArmRequest = 0,
  recoveryProfileId = '',
  autoRecoveryRequest = 0,
  busy,
  run,
  onPausedChange,
  onUseRecommendedCallable,
  onRecoveryCaptured,
}: DeepCaptureWorkspaceProps) {
  const suggestedMatcher = useMemo(() => eventMatcher(selectedEvent, selectedCandidate), [selectedCandidate, selectedEvent]);
  const [matcherKind, setMatcherKind] = useState<'crypto' | 'boundary' | 'request'>(suggestedMatcher?.kind || 'request');
  const [adapterId, setAdapterId] = useState(suggestedMatcher?.kind === 'crypto' ? suggestedMatcher.adapterId : '');
  const [operation, setOperation] = useState(suggestedMatcher?.kind === 'crypto' || suggestedMatcher?.kind === 'boundary' ? suggestedMatcher.operation : '');
  const [wrapperHandleId, setWrapperHandleId] = useState(suggestedMatcher?.kind === 'crypto' || suggestedMatcher?.kind === 'boundary' ? suggestedMatcher.wrapperHandleId : '');
  const [boundaryEventKind, setBoundaryEventKind] = useState<'beacon' | 'worker' | 'message'>(
    suggestedMatcher?.kind === 'boundary' ? suggestedMatcher.eventKind : 'worker',
  );
  const [scriptUrl, setScriptUrl] = useState(suggestedMatcher?.kind === 'crypto' || suggestedMatcher?.kind === 'boundary' ? suggestedMatcher.scriptUrl || '' : '');
  const [urlPattern, setUrlPattern] = useState(suggestedMatcher?.kind === 'request' ? suggestedMatcher.urlPattern : '');
  const [status, setStatus] = useState<BrowserDeepCaptureStatus>();
  const [callables, setCallables] = useState<BrowserPageCallable[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState('');
  const [callableName, setCallableName] = useState('');
  const [functionExpression, setFunctionExpression] = useState('');
  const [selectedCallableId, setSelectedCallableId] = useState('');
  const [callableArgs, setCallableArgs] = useState('["test"]');
  const [execution, setExecution] = useState<BrowserPageCallableExecution>();
  const [loadError, setLoadError] = useState('');
  const [manualCaptureOpen, setManualCaptureOpen] = useState(true);
  const [expressionEditorOpen, setExpressionEditorOpen] = useState(false);
  const [expandedVariableKey, setExpandedVariableKey] = useState('');
  const statusRef = useRef<BrowserDeepCaptureStatus | undefined>(undefined);
  const handledAutoArmRequest = useRef(0);
  const handledAutoRecoveryRequest = useRef(0);
  const handledAutoCapturePause = useRef(0);
  const automaticFlowRequested = useRef(false);

  const target = status?.target || (tab ? { tabId: tab.id, frameId: 0 } : undefined);
  const paused = status?.state === 'paused' && Boolean(status.pause);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { onPausedChange?.(paused); }, [onPausedChange, paused]);
  useEffect(() => () => { onPausedChange?.(false); }, [onPausedChange]);

  useEffect(() => {
    if (!suggestedMatcher || paused || status?.state === 'armed') return;
    setMatcherKind(suggestedMatcher.kind);
    if (suggestedMatcher.kind === 'crypto') {
      setAdapterId(suggestedMatcher.adapterId);
      setOperation(suggestedMatcher.operation);
      setWrapperHandleId(suggestedMatcher.wrapperHandleId);
      setScriptUrl(suggestedMatcher.scriptUrl || '');
    } else if (suggestedMatcher.kind === 'boundary') {
      setAdapterId('');
      setBoundaryEventKind(suggestedMatcher.eventKind);
      setOperation(suggestedMatcher.operation);
      setWrapperHandleId(suggestedMatcher.wrapperHandleId);
      setScriptUrl(suggestedMatcher.scriptUrl || '');
    } else {
      setAdapterId('');
      setOperation('');
      setWrapperHandleId('');
      setUrlPattern(suggestedMatcher.urlPattern);
    }
  }, [paused, status?.state, suggestedMatcher]);

  const load = useCallback(async () => {
    if (!tab) {
      setStatus(undefined);
      setCallables([]);
      return;
    }
    try {
      const nextStatus = await request('deep.capture.status', { tabId: tab.id, frameId: 0 });
      setStatus(nextStatus);
      const nextCallables = await request('callable.list', { tabId: tab.id, frameId: 0 }).catch(() => []);
      setCallables(nextCallables);
      setLoadError('');
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!autoArmRequest || handledAutoArmRequest.current >= autoArmRequest || !tab || !suggestedMatcher || !status || busy) return;
    handledAutoArmRequest.current = autoArmRequest;
    if (status.state === 'armed' || status.state === 'paused') return;
    setMatcherKind(suggestedMatcher.kind);
    if (suggestedMatcher.kind === 'crypto') {
      setAdapterId(suggestedMatcher.adapterId);
      setOperation(suggestedMatcher.operation);
      setWrapperHandleId(suggestedMatcher.wrapperHandleId);
      setScriptUrl(suggestedMatcher.scriptUrl || '');
    } else if (suggestedMatcher.kind === 'boundary') {
      setBoundaryEventKind(suggestedMatcher.eventKind);
      setOperation(suggestedMatcher.operation);
      setWrapperHandleId(suggestedMatcher.wrapperHandleId);
      setScriptUrl(suggestedMatcher.scriptUrl || '');
    } else {
      setUrlPattern(suggestedMatcher.urlPattern);
    }
    void run(async () => {
      setExecution(undefined);
      const next = await request('deep.capture.start', { tabId: tab.id, frameId: 0, matcher: suggestedMatcher });
      automaticFlowRequested.current = true;
      setStatus(next);
    }, '自动分析已武装，请在目标页面重复刚才的操作');
  }, [autoArmRequest, busy, run, status, suggestedMatcher, tab]);

  useEffect(() => {
    if (!autoRecoveryRequest || handledAutoRecoveryRequest.current >= autoRecoveryRequest
      || !recoveryProfileId || !tab || !status || busy) return;
    if (status.state === 'paused') return;
    handledAutoRecoveryRequest.current = autoRecoveryRequest;
    void run(async () => {
      setExecution(undefined);
      automaticFlowRequested.current = true;
      const next = await request('transform.recovery.start', { id: recoveryProfileId });
      setStatus(next);
      if (next.matcher?.kind === 'request') {
        setMatcherKind('request');
        setUrlPattern(next.matcher.urlPattern);
      }
    }, '恢复捕获已武装，请在目标页面重复一次原业务操作');
  }, [autoRecoveryRequest, busy, recoveryProfileId, run, status, tab]);

  useEffect(() => {
    if (!tab || !['armed', 'paused', 'attached'].includes(status?.state || '')) return undefined;
    const interval = window.setInterval(() => void request('deep.capture.status', { tabId: tab.id, frameId: 0 })
      .then(setStatus).catch((error) => setLoadError(errorMessage(error))), status?.state === 'armed' ? 450 : 1_200);
    return () => window.clearInterval(interval);
  }, [status?.state, tab]);

  useEffect(() => {
    if (!paused || !target) return undefined;
    const keepalive = window.setInterval(() => void request('deep.capture.keepalive', target)
      .then(setStatus).catch((error) => setLoadError(errorMessage(error))), 10_000);
    return () => window.clearInterval(keepalive);
  }, [paused, target?.documentId, target?.frameId, target?.tabId]);

  useEffect(() => () => {
    const current = statusRef.current;
    if (current && current.state !== 'detached') void request('deep.capture.detach', current.target).catch(() => undefined);
  }, [tab?.id]);

  const frames = status?.pause?.frames || [];
  useEffect(() => {
    setSelectedFrameId((current) => frames.some((frame) => frame.id === current)
      ? current
      : status?.pause?.automaticCapture?.frameId || status?.pause?.recommendedFrameId
        || frames.find((frame) => frame.sourceKind === 'page')?.id || frames[0]?.id || '');
  }, [frames, status?.pause?.automaticCapture?.frameId, status?.pause?.recommendedFrameId]);

  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);
  useEffect(() => {
    if (!selectedFrame) return;
    const functionName = selectedFrame.sourceKind === 'page' && selectedFrame.functionName !== '(anonymous)'
      ? selectedFrame.functionName : '';
    setFunctionExpression('');
    setCallableName(functionName ? `${functionName} 业务封装` : '页面业务封装');
    setExpandedVariableKey('');
  }, [selectedFrame?.id, selectedFrame?.sourceKind, selectedFrame?.functionInspection?.resolved, selectedFrame?.functionInspection?.riskFlags.join(':')]);

  useEffect(() => {
    setSelectedCallableId((current) => callables.some((callable) => callable.id === current)
      ? current
      : callables.at(-1)?.id || '');
  }, [callables]);

  const arm = () => run(async () => {
    if (!tab) throw new Error('请选择目标标签页');
    const frameHints = suggestedMatcher?.kind === matcherKind ? suggestedMatcher.frameHints : undefined;
    const matcher: BrowserDeepCaptureMatcher = matcherKind === 'crypto'
      ? {
        kind: 'crypto',
        adapterId: adapterId.trim(),
        operation: operation.trim(),
        wrapperHandleId: wrapperHandleId.trim(),
        scriptUrl: scriptUrl.trim() || undefined,
        frameHints,
      }
      : matcherKind === 'boundary'
        ? {
          kind: 'boundary',
          eventKind: boundaryEventKind,
          operation: operation.trim(),
          wrapperHandleId: wrapperHandleId.trim(),
          scriptUrl: scriptUrl.trim() || undefined,
          frameHints,
        }
        : { kind: 'request', urlPattern: urlPattern.trim(), frameHints };
    setExecution(undefined);
    automaticFlowRequested.current = false;
    setStatus(await request('deep.capture.start', { tabId: tab.id, frameId: 0, matcher }));
  }, '深度捕获已武装，请在目标页面重现一次操作');

  const resume = () => run(async () => {
    if (!target) return;
    setStatus(await request('deep.capture.resume', target));
  }, '页面已恢复，调试会话已结束');

  const detach = () => run(async () => {
    if (!target) return;
    setStatus(await request('deep.capture.detach', target));
  }, '深度捕获已结束');

  const createCallable = (strategy: 'selected-frame' | 'expression') => run(async () => {
    if (!target || !selectedFrame) throw new Error('请选择业务调用帧');
    const callable = strategy === 'expression'
      ? await request('callable.create', {
        ...target, source: 'deep-capture', strategy, callFrameId: selectedFrame.id, name: callableName, functionExpression,
      })
      : await request('callable.create', {
        ...target, source: 'deep-capture', strategy, callFrameId: selectedFrame.id, name: callableName,
      });
    setCallables((current) => [...current.filter((item) => item.id !== callable.id), callable]);
    setSelectedCallableId(callable.id);
    setStatus(await request('deep.capture.status', target));
  }, '业务函数已捕获，页面已恢复');

  const captureRecovery = (strategy: 'selected-frame' | 'request-transaction') => run(async () => {
    if (!recoveryProfileId || !target || !selectedFrame) throw new Error('恢复计划或页面调用帧已经失效');
    await request('transform.recovery.capture', {
      id: recoveryProfileId,
      ...target,
      callFrameId: selectedFrame.id,
      strategy,
    });
    setCallables(await request('callable.list', target).catch(() => []));
    setStatus(await request('deep.capture.status', target));
    await onRecoveryCaptured?.(recoveryProfileId);
  }, '新页面函数已捕获；请使用本地回放验证后再确认启用');

  const recordedRecommendation = selectedCandidate?.status === 'ready'
    && Boolean(selectedCandidate.source.callHandleId)
    ? selectedCandidate : undefined;

  useEffect(() => {
    if (!paused) return;
    setManualCaptureOpen(Boolean(
      !automaticFlowRequested.current
      ||
      recordedRecommendation
      || status?.pause?.automaticCapture?.state !== 'ready',
    ));
  }, [paused, recordedRecommendation?.source.eventId, status?.pause?.automaticCapture?.state]);

  useEffect(() => {
    setExpressionEditorOpen(false);
  }, [selectedFrame?.id]);

  useEffect(() => {
    const pause = status?.pause;
    const automatic = pause?.automaticCapture;
    const inferenceCapture = selectedCandidate?.status === 'capture-required';
    const recoveryCapture = Boolean(recoveryProfileId);
    if (!automaticFlowRequested.current || !paused || !pause || pause.collecting || !target || !tab
      || (!inferenceCapture && !recoveryCapture)
      || automatic?.state !== 'ready' || !automatic.frameId || handledAutoCapturePause.current === pause.pausedAt) return;
    const capturedPause = pause;
    const capturedFrameId = automatic.frameId;
    const captureStrategy = automatic.strategy || 'selected-frame';
    handledAutoCapturePause.current = pause.pausedAt;
    automaticFlowRequested.current = false;
    void run(async () => {
      const frame = capturedPause.frames.find((item) => item.id === capturedFrameId);
      if (recoveryProfileId) {
        await request('transform.recovery.capture', {
          id: recoveryProfileId,
          ...target,
          callFrameId: capturedFrameId,
          strategy: captureStrategy,
        });
        setCallables(await request('callable.list', target).catch(() => []));
        setStatus(await request('deep.capture.status', target));
        await onRecoveryCaptured?.(recoveryProfileId);
        return;
      }
      if (!selectedCandidate) throw new Error('自动推断候选已经失效');
      const callableName = frame?.functionName && frame.functionName !== '(anonymous)'
        ? `${frame.functionName} ${captureStrategy === 'request-transaction' ? '请求事务' : '业务封装'}`
        : undefined;
      const callable = captureStrategy === 'request-transaction'
        ? await request('callable.create', {
          ...target,
          source: 'deep-capture',
          strategy: 'request-transaction',
          callFrameId: capturedFrameId,
          candidateId: selectedCandidate.id,
          ...(callableName ? { name: callableName } : {}),
        })
        : await request('callable.create', {
          ...target,
          source: 'deep-capture',
          strategy: 'selected-frame',
          callFrameId: capturedFrameId,
          candidateId: selectedCandidate.id,
          ...(callableName ? { name: callableName } : {}),
        });
      setCallables((current) => [...current.filter((item) => item.id !== callable.id), callable]);
      setSelectedCallableId(callable.id);
      setStatus(await request('deep.capture.status', target));
      await onUseRecommendedCallable?.(
        selectedCandidate,
        callable,
        captureStrategy === 'request-transaction' ? undefined : capturedCallableSample(frame),
      );
    }, recoveryProfileId
      ? '新页面函数已捕获，旧网关继续停用；请完成本地回放验证'
      : captureStrategy === 'request-transaction'
        ? '页面请求事务与明文网关已自动保存，真实发送将在回放时被截获'
        : '完整业务加密流程与明文网关已自动保存');
  }, [
    onRecoveryCaptured,
    onUseRecommendedCallable,
    paused,
    recoveryProfileId,
    run,
    selectedCandidate,
    status?.pause,
    tab,
    target,
  ]);

  const useRecordedRecommendation = () => run(async () => {
    if (!target || !recordedRecommendation?.source.callHandleId) throw new Error('推荐调用已经失效');
    setStatus(await request('deep.capture.resume', target));
    let callable = callables.find((item) => item.provenance.eventId === recordedRecommendation.source.eventId);
    if (!callable) {
      callable = await request('callable.create', {
        ...target,
        source: 'recording',
        callHandleId: recordedRecommendation.source.callHandleId,
        name: `${recordedRecommendation.source.crypto?.algorithm || recordedRecommendation.source.crypto?.operation || recordedRecommendation.source.operation} 页面函数`,
      });
    }
    const selected = callable;
    setCallables((current) => [...current.filter((item) => item.id !== selected.id), selected]);
    setSelectedCallableId(selected.id);
    await onUseRecommendedCallable?.(recordedRecommendation, selected);
  }, '已使用录制调用生成并保存明文网关');

  const executeCallable = () => run(async () => {
    if (!target || !selectedCallableId) throw new Error('请选择页面函数');
    const args = JSON.parse(callableArgs) as unknown;
    if (!Array.isArray(args)) throw new Error('调用参数必须是 JSON 数组');
    setExecution(await request('callable.execute', { ...target, callableId: selectedCallableId, args }));
  }, '页面函数验证完成');

  const deleteCallable = () => run(async () => {
    if (!target || !selectedCallableId) return;
    setCallables(await request('callable.delete', { ...target, callableId: selectedCallableId }));
    setExecution(undefined);
  }, '页面函数已删除');

  const stages = [
    { label: '目标', done: Boolean(suggestedMatcher || operation || urlPattern), current: status?.state === 'detached' },
    { label: '等待命中', done: ['paused', 'captured'].includes(status?.state || ''), current: status?.state === 'armed' },
    { label: '暂停现场', done: status?.state === 'captured' || callables.length > 0, current: paused },
    { label: '页面函数', done: callables.length > 0, current: status?.state === 'captured' && callables.length === 0 },
    { label: '验证', done: Boolean(execution), current: callables.length > 0 && !execution },
  ];
  const automaticCapture = status?.pause?.automaticCapture;
  const selectedCaptureReady = selectedFrame?.sourceKind === 'page'
    && selectedFrame.functionInspection?.resolved
    && !selectedFrame.functionInspection.riskFlags.length;
  const recoveryCaptureStrategy = selectedFrame?.functionInspection?.riskFlags.length
    ? 'request-transaction' as const
    : 'selected-frame' as const;
  const recoverySelectionReady = selectedFrame?.sourceKind === 'page'
    && selectedFrame.functionInspection?.resolved
    && !selectedFrame.functionInspection.riskFlags.includes('storage');
  const workerTargets = status?.workerTargets || [];
  const attachedWorkerCount = workerTargets.filter((target) => target.state === 'attached').length;
  const workerScriptCount = workerTargets.reduce((total, target) => total + target.scriptCount, 0);
  const boundarySummary = status?.boundary?.workers === 'unavailable'
    ? ' · Worker 证据不可用'
    : workerTargets.length
      ? ` · Worker/SW ${attachedWorkerCount}/${workerTargets.length}`
      : '';
  const boundaryTitle = status?.workerTargetError
    || `主文档可捕获；Source Map 只记录来源元数据；Worker/Service Worker 仅记录同源目标与脚本证据（${workerTargets.length} 个目标，${workerScriptCount} 个脚本），不会伪装成页面函数；WASM 仅展示外围 JS 与可读作用域证据`;

  return <div className="deep-capture">
    <div className="deep-capture__command">
      <div className="deep-capture__identity">
        <span className={`deep-status-dot state-${status?.state || 'detached'}`}><i /></span>
        <div><strong>深度捕获</strong><small title={boundaryTitle}>{STATUS_LABELS[status?.state || 'detached']}{status?.matcher && status.matcher.kind !== 'request' ? ` · ${status.matcher.operation}` : ''} · 主文档{boundarySummary}</small></div>
      </div>
      <ol className="deep-stage-strip">
        {stages.map((stage, index) => <li key={stage.label} className={`${stage.done ? 'is-done' : ''} ${stage.current ? 'is-current' : ''}`}>
          <span>{stage.done ? <Check size={11} /> : index + 1}</span><em>{stage.label}</em>{index < stages.length - 1 && <ChevronRight size={12} />}
        </li>)}
      </ol>
      <div className="deep-capture__command-actions">
        <Button size="icon" variant="ghost" title="刷新深度捕获" aria-label="刷新深度捕获" disabled={!tab} onClick={() => void load()}><RefreshCw size={15} /></Button>
        {status && status.state !== 'detached' && <Button size="icon" variant="ghost" title="结束并释放调试会话" aria-label="结束并释放调试会话" disabled={busy} onClick={() => void detach()}><Unplug size={15} /></Button>}
      </div>
    </div>

    {loadError && <div className="deep-message is-error"><AlertTriangle size={15} /><span>{loadError}</span></div>}
    {status?.error && <div className="deep-message is-warning"><ShieldAlert size={15} /><span>{status.error}</span></div>}
    {status?.workerTargetError && <div className="deep-message is-warning"><ShieldAlert size={15} /><span>{status.workerTargetError}；主文档捕获仍可继续</span></div>}

    {!paused ? <>
      <section className="deep-arm-panel">
        <div className="deep-arm-panel__mode" role="group" aria-label="捕获目标类型">
          <button className={matcherKind === 'crypto' ? 'is-selected' : ''} disabled={!adapterId || !wrapperHandleId} title={adapterId && wrapperHandleId ? '捕获选中的录制调用' : '请先在录制中选择一个密码调用'} onClick={() => setMatcherKind('crypto')}><Fingerprint size={15} /><span>加密调用</span></button>
          <button className={matcherKind === 'boundary' ? 'is-selected' : ''} disabled={Boolean(adapterId) || !wrapperHandleId} title={!adapterId && wrapperHandleId ? '捕获选中的页面通信边界' : '请先在录制中选择 Beacon、Worker 或 MessagePort 调用'} onClick={() => setMatcherKind('boundary')}><Webhook size={15} /><span>消息边界</span></button>
          <button className={matcherKind === 'request' ? 'is-selected' : ''} onClick={() => setMatcherKind('request')}><Crosshair size={15} /><span>目标请求</span></button>
        </div>
        <div className="deep-arm-panel__fields">
          {matcherKind === 'crypto' ? <>
            <label><span>密码调用</span><input value={adapterId && operation ? `${adapterId} · ${operation}` : ''} readOnly placeholder="请从录制结果选择密码调用" /></label>
            <label><span>脚本过滤</span><input value={scriptUrl} onChange={(event) => setScriptUrl(event.target.value)} placeholder="可选" /></label>
          </> : matcherKind === 'boundary' ? <>
            <label><span>通信边界</span><input value={`${boundaryEventKind} · ${operation}`} readOnly placeholder="请从录制结果选择消息调用" /></label>
            <label><span>脚本过滤</span><input value={scriptUrl} onChange={(event) => setScriptUrl(event.target.value)} placeholder="可选" /></label>
          </> : <label className="is-wide"><span>URL 片段</span><input value={urlPattern} onChange={(event) => setUrlPattern(event.target.value)} placeholder="/api/login" /></label>}
        </div>
        <Button variant="primary" disabled={busy || !tab || (matcherKind === 'crypto'
          ? !adapterId.trim() || !operation.trim() || !wrapperHandleId.trim()
          : matcherKind === 'boundary' ? !operation.trim() || !wrapperHandleId.trim() : !urlPattern.trim())} onClick={() => void arm()}><Bug size={15} />武装下一次命中</Button>
      </section>

      {status?.state === 'armed' && <div className="deep-waiting"><span><CirclePause size={17} /></span><div><strong>等待目标页面命中</strong><small>{status.matcher?.kind === 'request' ? status.matcher.urlPattern : status.matcher?.operation}</small></div><i /></div>}

      <section className="deep-adapter-lab">
        <div className="deep-adapter-list">
          <header><div><Layers3 size={15} /><strong>当前文档页面函数</strong></div><span>{callables.length}</span></header>
          {!callables.length ? <div className="deep-column-empty"><Code2 size={20} /><span>尚未捕获业务函数</span></div> : callables.map((callable) => <button key={callable.id} className={callable.id === selectedCallableId ? 'is-selected' : ''} onClick={() => { setSelectedCallableId(callable.id); setExecution(undefined); }}>
            <span><strong>{callable.name}</strong><small>{callable.kind === 'request-transaction' ? '请求事务' : callable.provenance.functionName || callable.operation} · {compactUrl(callable.provenance.sourceUrl || '')}{callable.provenance.lineNumber ? `:${callable.provenance.lineNumber}` : ''}</small></span><ChevronRight size={14} />
          </button>)}
        </div>
        <div className="deep-adapter-runner">
          <header><div><Play size={15} /><strong>调用验证</strong></div>{execution && <span>{execution.durationMs.toFixed(1)} ms</span>}</header>
          <label><span>参数 · JSON 数组</span><textarea rows={5} value={callableArgs} onChange={(event) => setCallableArgs(event.target.value)} spellCheck={false} /></label>
          <div className="deep-adapter-runner__actions"><Button size="icon" variant="ghost" title="删除页面函数" aria-label="删除页面函数" disabled={!selectedCallableId || busy} onClick={() => void deleteCallable()}><Trash2 size={14} /></Button><Button variant="primary" disabled={!selectedCallableId || busy} onClick={() => void executeCallable()}><Play size={14} />运行</Button></div>
          {execution && <div className="deep-execution-result"><div><strong>{execution.type}</strong><span>{execution.callableId.slice(0, 8)}</span></div><pre>{jsonPreview(execution.value)}</pre></div>}
        </div>
      </section>
    </> : <section className="deep-paused-workbench">
      <div className="deep-paused-banner"><div><CirclePause size={16} /><strong>页面已暂停</strong><span>剩余 {Math.max(0, Math.ceil(((status?.pause?.deadline || Date.now()) - Date.now()) / 1_000))} 秒</span></div><Button variant="ghost" disabled={busy} onClick={() => void resume()}><Play size={14} />恢复并结束调试</Button></div>
      {recordedRecommendation && <section className="deep-recorded-recommendation">
        <span><Sparkles size={17} /></span>
        <div><small>推荐方案</small><strong>直接复用已录制的 {recordedRecommendation.source.crypto?.algorithm || recordedRecommendation.source.crypto?.operation || recordedRecommendation.source.operation}</strong><p>已证明输出进入 {recordedRecommendation.request.destination}。原函数、receiver 与固定参数已由页面调用句柄保留，不需要填写函数表达式。</p><div><i>无额外网络调用</i><i>使用真实页面环境</i><i>自动生成 Profile</i></div></div>
        <Button variant="primary" disabled={busy} onClick={() => void useRecordedRecommendation()}><FileKey2 size={14} />使用推荐方案</Button>
      </section>}
      {!recordedRecommendation && automaticCapture && <section className={`deep-auto-resolution is-${automaticCapture.state}`} role="status">
        <span>{automaticCapture.state === 'ready' ? <Sparkles size={17} /> : automaticCapture.state === 'ambiguous' ? <Layers3 size={17} /> : <ShieldAlert size={17} />}</span>
        <div>
          <small>{automaticCapture.state === 'ready' ? '自动业务边界' : automaticCapture.state === 'ambiguous' ? '需要确认' : automaticCapture.state === 'blocked' ? '安全阻止' : '需要高级定位'}</small>
          <strong>{automaticCapture.state === 'ready'
            ? recoveryProfileId
              ? automaticCapture.strategy === 'request-transaction'
                ? '已重新定位页面发送流程，正在建立待验证绑定'
                : '已重新定位页面业务函数，正在建立待验证绑定'
              : automaticCapture.strategy === 'request-transaction'
                ? `已定位页面发送流程${selectedCandidate?.capturePlan?.transaction?.prerequisites.length ? ` · ${selectedCandidate.capturePlan.transaction.prerequisites.length} 个在线前置请求` : ''}，正在建立截获式回放`
                : '已定位完整页面业务函数，正在保存并生成明文网关'
            : automaticCapture.state === 'ambiguous'
              ? '多个页面函数同样接近真实加密边界'
              : automaticCapture.state === 'blocked'
                ? '最接近的函数不能作为安全转换函数'
                : '当前栈帧无法唯一还原为函数对象'}</strong>
          <p>{automaticCapture.reason}</p>
        </div>
        {automaticCapture.state === 'ready' && <i><span />自动处理中</i>}
      </section>}
      <details className="deep-manual-capture" open={manualCaptureOpen} onToggle={(event) => setManualCaptureOpen(event.currentTarget.open)}>
        <summary><span><Braces size={14} /><strong>{recordedRecommendation || automaticCapture?.state === 'ready' ? '高级：检查调用栈与其他候选' : '确认页面业务边界'}</strong></span><em>{automaticCapture?.state === 'ambiguous' ? '请选择实际组装报文的函数' : '插件已排除 Hook、依赖与明显副作用'}</em></summary>
      <div className="deep-paused-grid">
        <aside className="deep-stack">
          <header><Bug size={14} /><strong>调用栈</strong><span>{frames.length}</span></header>
          <div>{frames.map((frame) => <button key={frame.id} className={`${frame.id === selectedFrameId ? 'is-selected' : ''} ${frame.sourceKind !== 'page' ? 'is-library' : ''} source-${frame.sourceKind}`} onClick={() => setSelectedFrameId(frame.id)}>
            <span className="deep-frame-index">{frame.index}</span><span><strong>{frame.functionName}</strong><small>{compactUrl(frame.url)}:{frame.lineNumber}</small></span><span className="deep-frame-badges">{status?.pause?.recommendedFrameId === frame.id ? <em className="is-clean" title={frame.businessReasons?.join(' · ')}>推荐 · {frame.businessScore}</em> : null}<em className={`source-${frame.sourceKind}`}>{FRAME_SOURCE_LABELS[frame.sourceKind]}</em>{frame.functionInspection?.riskFlags.length ? <em className="has-risk" title={frame.functionInspection.riskFlags.map((risk) => RISK_LABELS[risk]).join('、')}>有副作用</em> : frame.functionInspection?.resolved && frame.sourceKind === 'page' ? <em className="is-clean">可评估</em> : null}</span>
          </button>)}</div>
        </aside>
        <section className="deep-scopes">
          <header><Variable size={14} /><strong>作用域</strong><span>{selectedFrame?.scopes.reduce((count, scope) => count + scope.variables.length, 0) || 0}</span></header>
          <div>{selectedFrame?.scopes.map((scope, scopeIndex) => <section key={`${scope.type}:${scopeIndex}`}>
            <h4><span>{scope.type}</span><small>{scope.name || `${scope.variables.length} 个变量`}</small></h4>
            {scope.variables.map((variable) => {
              const variableKey = `${selectedFrame.id}:${scopeIndex}:${variable.name}`;
              const expanded = expandedVariableKey === variableKey;
              const detail = variable.detail || variable.preview;
              return <div className={`deep-scope-variable ${expanded ? 'is-expanded' : ''}`} key={`${scopeIndex}:${variable.name}`}>
                <button type="button" aria-expanded={expanded} onClick={() => setExpandedVariableKey(expanded ? '' : variableKey)}>
                  <code>{variable.name}</code><span>{variable.preview}</span><em>{variable.subtype || variable.type}</em><ChevronDown size={12} />
                </button>
                {expanded && <div className="deep-scope-variable__detail"><header><span>{variable.type === 'function' ? '函数源码' : '值预览'}{variable.detailTruncated ? ' · 已截断' : ''}</span><div><Button size="icon" variant="ghost" aria-label={`复制 ${variable.name}`} title="复制内容" onClick={() => void navigator.clipboard.writeText(detail)}><Copy size={12} /></Button>{variable.type === 'function' && validIdentifier(variable.name) && <Button size="sm" variant="ghost" onClick={() => { setFunctionExpression(variable.name); setCallableName(`${variable.name} 业务封装`); setExpressionEditorOpen(true); }}>高级引用</Button>}</div></header><pre>{detail}</pre></div>}
              </div>;
            })}
          </section>) || <div className="deep-column-empty">没有可读作用域</div>}</div>
        </section>
        <aside className="deep-adapter-editor">
          <header><Braces size={14} /><strong>函数评估</strong></header>
          <div className="deep-frame-summary"><strong>{selectedFrame?.functionName || '未选择调用帧'}</strong><small>{selectedFrame ? `${compactUrl(selectedFrame.url)}:${selectedFrame.lineNumber}:${selectedFrame.columnNumber}` : ''}</small>{selectedFrame?.sourceMapUrl && <small title={selectedFrame.sourceMapUrl}>Source Map 元数据 · {compactUrl(selectedFrame.sourceMapUrl)}</small>}<span>{selectedFrame?.thisPreview || ''}</span></div>
          {selectedFrame?.sourceKind === 'extension-hook' ? <div className="deep-function-assessment is-hook"><Bug size={15} /><span><strong>这是插件注入的观测帧</strong><small>它只负责记录或设置断点，不是页面业务代码。请选择调用栈中标记为“页面函数”的下游帧。</small></span></div> : selectedFrame?.functionInspection?.resolved ? <div className={`deep-function-assessment ${selectedFrame.functionInspection.riskFlags.length ? 'has-risk' : 'is-clean'}`}>
            {selectedFrame.functionInspection.riskFlags.length ? <><ShieldAlert size={15} /><span><strong>已阻止注册为可回放函数</strong><small>{selectedFrame.functionInspection.riskFlags.map((risk) => RISK_LABELS[risk]).join(' · ')}。直接调用可能改变页面或发送真实请求。</small></span></> : <><Check size={15} /><span><strong>函数对象已自动解析</strong><small>{selectedFrame.functionInspection.parameterCount || 0} 个参数 · {selectedFrame.functionInspection.resolution === 'receiver-method' ? '页面方法' : selectedFrame.functionInspection.resolution === 'scope-binding' ? '闭包绑定' : '当前栈帧'} · 未发现明显副作用</small></span></>}
          </div> : <div className="deep-function-assessment has-risk"><AlertTriangle size={15} /><span><strong>无法唯一解析当前函数</strong><small>{selectedFrame?.functionInspection?.candidateCount ? `发现 ${selectedFrame.functionInspection.candidateCount} 个同分候选；` : ''}请选择其他业务栈帧，或在高级模式中指定闭包变量。</small></span></div>}
          <div className="deep-adapter-editor__primary">{recoveryProfileId
            ? <Button variant="primary" disabled={busy || !recoverySelectionReady} onClick={() => void captureRecovery(recoveryCaptureStrategy)}><RotateCcw size={14} />{recoveryCaptureStrategy === 'request-transaction' ? '按所选函数恢复请求事务' : '用所选函数恢复绑定'}</Button>
            : <Button variant="primary" disabled={busy || !selectedCaptureReady || !callableName.trim()} onClick={() => void createCallable('selected-frame')}><Sparkles size={14} />捕获所选业务函数</Button>}<small>{recoveryProfileId
              ? recoverySelectionReady ? '新绑定会保持停用，直到本地回放验证和用户确认都完成' : '选择唯一可解析且不访问页面存储的业务函数'
              : selectedCaptureReady ? '函数引用、receiver、来源位置与参数数量由暂停现场自动保存' : '只有唯一解析且无明显副作用的页面函数可以保存'}</small></div>
          {!recoveryProfileId && <details className="deep-expression-editor" open={expressionEditorOpen} onToggle={(event) => setExpressionEditorOpen(event.currentTarget.open)}>
            <summary>高级：函数引用表达式</summary>
            <p>仅用于匿名闭包或特殊打包产物。表达式必须在所选暂停帧中返回 Function，且仍会经过副作用门控。</p>
            <label><span>页面函数名称</span><input value={callableName} onChange={(event) => setCallableName(event.target.value)} /></label>
            <label><span>函数引用</span><textarea rows={5} value={functionExpression} onChange={(event) => setFunctionExpression(event.target.value)} spellCheck={false} placeholder="buildLoginEnvelope" /></label>
            <div className="deep-adapter-editor__actions"><Button variant="ghost" disabled={busy || !selectedFrame || selectedFrame.sourceKind !== 'page' || Boolean(selectedFrame.functionInspection?.riskFlags.length) || !callableName.trim() || !functionExpression.trim()} onClick={() => void createCallable('expression')}><Code2 size={14} />验证表达式并捕获</Button></div>
          </details>}
        </aside>
      </div>
      </details>
    </section>}
  </div>;
}
