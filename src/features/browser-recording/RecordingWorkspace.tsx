import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Activity, AlertTriangle, ArrowDown, Braces, Check, ChevronRight, CircleStop, Copy, Fingerprint, Globe2,
  Bug, FileKey2, KeyRound, Link2, Navigation, Play, Radio, RefreshCw, Save, ShieldCheck, Sparkles, Trash2, Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { errorMessage, request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, BrowserPageCallable, BrowserPageCallableExecution, BrowserRecordingEvent,
  BrowserProfileInferenceCandidate, BrowserRecordingArgumentRole, BrowserRecordingSnapshot,
} from '@/types/models';
import type { CapturedCallableSample } from '@/features/deep-capture/callable-sample';
import { DeepCaptureWorkspace } from '@/features/deep-capture/DeepCaptureWorkspace';
import { cryptoEventLabel } from '@/features/browser-crypto/model';
import { cryptoAdapterLabel } from '@/features/browser-crypto/adapters/catalog';
import {
  BrowserTransformWorkspace,
  type BrowserTransformSuggestionSeed,
} from '@/features/browser-transform/BrowserTransformWorkspace';
import { createBrowserTransformProfileInput } from '@/features/browser-transform/profile-draft';

type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;
const DEEP_CAPTURE_AVAILABLE = !import.meta.env.FIREFOX;

interface RecordingWorkspaceProps {
  tab?: ActiveTabInfo;
  busy: boolean;
  run: RunTask;
  gatewayShared: boolean;
  onShareGateway: () => Promise<void>;
  initialMode?: 'gateway' | 'recording' | 'deep';
}

const KIND_LABELS: Record<BrowserRecordingEvent['kind'], string> = {
  interaction: '页面操作',
  fetch: 'Fetch',
  xhr: 'XHR',
  form: '表单',
  beacon: 'Beacon',
  worker: 'Worker',
  message: '消息通道',
  websocket: 'WebSocket',
  crypto: '密码调用',
  transform: '数据转换',
  navigation: '浏览器导航',
};

const ARGUMENT_LABELS: Record<BrowserRecordingArgumentRole, string> = {
  data: '明文输入',
  key: 'Key',
  iv: 'IV',
  algorithm: '算法',
  options: '选项',
  signature: '签名',
  salt: 'Salt',
  nonce: 'Nonce',
  aad: 'AAD',
  unknown: '参数',
};

function confidenceLabel(candidate: BrowserProfileInferenceCandidate): string {
  const level = candidate.confidence.level === 'high' ? '高' : candidate.confidence.level === 'medium' ? '中' : '低';
  return `${level}置信度 · ${candidate.confidence.score}`;
}

function eventIcon(kind: BrowserRecordingEvent['kind']) {
  if (kind === 'navigation') return <Navigation size={15} />;
  if (kind === 'interaction') return <Radio size={15} />;
  if (kind === 'crypto') return <Fingerprint size={15} />;
  if (kind === 'websocket' || kind === 'worker' || kind === 'message') return <Webhook size={15} />;
  if (kind === 'fetch' || kind === 'xhr' || kind === 'form' || kind === 'beacon') return <Globe2 size={15} />;
  return <Braces size={15} />;
}

function requestPath(url?: string): string {
  if (!url) return '';
  try { return new URL(url, 'https://recording.invalid').pathname; } catch { return url; }
}

function eventTitle(event: BrowserRecordingEvent): string {
  if (event.kind === 'navigation') return event.label || '页面跳转';
  if (event.kind === 'interaction') return event.label || event.operation;
  if (event.kind === 'transform') return event.label || event.operation;
  if (event.kind === 'fetch' || event.kind === 'xhr' || event.kind === 'form' || event.kind === 'beacon') {
    return `${event.method || 'GET'} ${requestPath(event.url) || '/'}${event.operation === 'response' ? ` · 响应${event.statusCode === undefined ? '' : ` ${event.statusCode}`}` : ''}`;
  }
  return event.kind === 'crypto' ? cryptoEventLabel(event) : event.operation;
}

function eventSubtitle(event: BrowserRecordingEvent): string {
  if (event.kind === 'navigation') {
    const from = requestPath(event.navigation?.fromUrl);
    const to = requestPath(event.navigation?.toUrl || event.url);
    return from && to ? `${from} → ${to}` : to || '文档边界';
  }
  if (event.kind === 'fetch' || event.kind === 'xhr' || event.kind === 'form' || event.kind === 'beacon') {
    try {
      const host = event.url ? new URL(event.url, 'https://recording.invalid').host : KIND_LABELS[event.kind];
      return event.operation === 'response' ? `${host} · 线上响应读取` : host;
    } catch { return KIND_LABELS[event.kind]; }
  }
  if (event.kind === 'crypto' && event.crypto) {
    const keyLabel = event.crypto.key
      ? `${event.crypto.key.kind === 'public' ? '公钥' : event.crypto.key.kind === 'private' ? '私钥' : event.crypto.key.kind === 'secret' ? '对称密钥' : '密钥'}${event.crypto.key.bits ? ` ${event.crypto.key.bits} bit` : ''}`
      : undefined;
    const details = [cryptoAdapterLabel(event.crypto.adapterId), event.crypto.mode, keyLabel, event.crypto.padding, event.crypto.outputEncoding]
      .filter(Boolean).join(' · ');
    return details || event.scriptUrl || KIND_LABELS[event.kind];
  }
  if (event.kind === 'transform' && event.transform) {
    const category = {
      serializer: '序列化',
      canonicalization: '规范化',
      'request-builder': '请求准备',
      encoding: '编码',
      compression: '压缩 / 解压',
    }[event.transform.category];
    return [
      event.transform.adapterId,
      category,
      event.scriptUrl ? requestPath(event.scriptUrl) : undefined,
    ].filter(Boolean).join(' · ');
  }
  if (event.kind === 'worker' || event.kind === 'message') {
    return [event.direction === 'send' ? '发送' : event.direction === 'receive' ? '接收' : undefined, event.channelId?.slice(-12), event.dataType]
      .filter(Boolean).join(' · ') || KIND_LABELS[event.kind];
  }
  return event.scriptUrl || event.dataType || KIND_LABELS[event.kind];
}

function relativeTime(timestamp: number, startedAt?: number): string {
  if (!startedAt) return '';
  const elapsed = Math.max(0, timestamp - startedAt);
  if (elapsed < 1_000) return `+${Math.round(elapsed)} ms`;
  if (elapsed < 60_000) return `+${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 2 : 1)} s`;
  return `+${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1_000)}s`;
}

function durationLabel(startedAt: number, endedAt: number): string {
  const duration = Math.max(0, endedAt - startedAt);
  if (duration < 1_000) return `${Math.round(duration)} ms`;
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)} s`;
}

function navigationPhaseLabel(event: BrowserRecordingEvent): string {
  const phase = event.navigation?.phase;
  if (phase === 'started') return '正在切换页面';
  if (phase === 'committed') return '新文档已提交';
  if (phase === 'completed') return '新页面已就绪';
  if (phase === 'restored') return '旧页面现场已恢复';
  if (phase === 'same-document') return '当前文档保持可用';
  if (phase === 'failed') return '跳转失败';
  return '浏览器文档边界';
}

function emptySnapshot(tabId: number): BrowserRecordingSnapshot {
  return {
    status: { active: false, target: { tabId, frameId: 0 }, documentAvailable: true, count: 0, droppedCount: 0 },
    events: [], traces: [], links: [], callables: [], profileCandidates: [],
  };
}

function shortSample(event?: BrowserRecordingEvent): string | undefined {
  const value = event?.inputPreview || event?.inputs.find((item) => item.preview)?.preview;
  return value?.trim() || undefined;
}

function eventAvailableInDocument(
  event: BrowserRecordingEvent | undefined,
  currentDocumentId: string | undefined,
  documentAvailable: boolean,
): boolean {
  return documentAvailable && Boolean(event) && (
    !event?.documentId || !currentDocumentId || event.documentId === currentDocumentId
  );
}

export function RecordingWorkspace({
  tab,
  busy,
  run,
  gatewayShared,
  onShareGateway,
  initialMode = 'recording',
}: RecordingWorkspaceProps) {
  const [workspaceMode, setWorkspaceMode] = useState<'gateway' | 'recording' | 'deep'>(initialMode);
  const [autoArmRequest, setAutoArmRequest] = useState(0);
  const [autoRecoveryRequest, setAutoRecoveryRequest] = useState(0);
  const [recoveryProfileId, setRecoveryProfileId] = useState('');
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const [deepPaused, setDeepPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<BrowserRecordingSnapshot>();
  const [captureValues, setCaptureValues] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState('');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [callableEditorOpen, setCallableEditorOpen] = useState(false);
  const [callableName, setCallableName] = useState('');
  const [selectedCallableId, setSelectedCallableId] = useState('');
  const [callableArguments, setCallableArguments] = useState('[]');
  const [callableResult, setCallableResult] = useState<BrowserPageCallableExecution>();
  const [gatewaySuggestion, setGatewaySuggestion] = useState<BrowserTransformSuggestionSeed>();

  const load = useCallback(async () => {
    const tabId = tab?.id;
    if (!tabId) {
      setSnapshot(undefined);
      return;
    }
    try {
      const target = { tabId, frameId: 0 };
      const status = await request('recording.status', target);
      const next = status.startedAt
        ? await request('recording.get', { ...target, limit: 500 })
        : emptySnapshot(tabId);
      setSnapshot(next);
      if (next.status.options) setCaptureValues(next.status.options.captureValues);
      setLoadError('');
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [tab?.id, tab?.url]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!snapshot?.status.active) return undefined;
    const timer = window.setInterval(() => void load(), 350);
    return () => window.clearInterval(timer);
  }, [load, snapshot?.status.active]);

  useEffect(() => {
    const listener = (message: unknown) => {
      const input = message as { action?: string; payload?: { tabId?: number } };
      if (input.action === 'recording.changed' && input.payload?.tabId === tab?.id) void load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [load, tab?.id]);

  useEffect(() => {
    const traces = snapshot?.traces || [];
    setSelectedTraceId((current) => traces.some((trace) => trace.id === current) ? current : traces[0]?.id || '');
  }, [snapshot?.traces]);

  const selectedTrace = snapshot?.traces.find((trace) => trace.id === selectedTraceId);
  const traceEvents = useMemo(() => selectedTrace
    ? selectedTrace.eventIds.map((id) => snapshot?.events.find((event) => event.id === id)).filter((event): event is BrowserRecordingEvent => Boolean(event))
    : [], [selectedTrace, snapshot?.events]);

  useEffect(() => {
    setSelectedEventId((current) => traceEvents.some((event) => event.id === current)
      ? current
      : traceEvents.find((event) => event.callableCapable)?.id || traceEvents.at(-1)?.id || '');
  }, [traceEvents]);

  const selectedEvent = snapshot?.events.find((event) => event.id === selectedEventId);
  const selectedCallable = snapshot?.callables.find((callable) => callable.id === selectedCallableId);
  const recordingTarget = tab ? { tabId: tab.id, frameId: 0 } : undefined;
  const documentAvailable = snapshot?.status.documentAvailable !== false;
  const callableTarget = snapshot?.status.startedAt && documentAvailable ? snapshot.status.target : undefined;

  useEffect(() => {
    if (!selectedEvent) return;
    setCallableName(`${eventTitle(selectedEvent)} 页面函数`);
    const sample = selectedEvent.inputPreview || selectedEvent.inputs.find((item) => item.preview)?.preview;
    setCallableArguments(JSON.stringify(sample === undefined ? [] : [sample], null, 2));
    setCallableEditorOpen(false);
    setCallableResult(undefined);
  }, [selectedEvent?.id, selectedEvent?.inputPreview]);

  useEffect(() => {
    const callables = snapshot?.callables || [];
    setSelectedCallableId((current) => callables.some((callable) => callable.id === current) ? current : callables.at(-1)?.id || '');
  }, [snapshot?.callables]);

  const start = () => run(async () => {
    if (!tab) throw new Error('请选择目标标签页');
    const next = await request('recording.start', {
      tabId: tab.id, captureValues, maxEntries: 500, maxValueBytes: 8_192,
    });
    setSnapshot(next);
    setSelectedTraceId('');
    setSelectedEventId('');
    setCallableResult(undefined);
  }, captureValues ? '录制已开始；短时样本仅保留在本次浏览器会话，页面跳转后会自动接续' : '录制已开始，将跨页面记录业务执行链');

  const stop = () => run(async () => {
    if (!recordingTarget) return;
    setSnapshot(await request('recording.stop', recordingTarget));
  }, '录制已停止，可以继续验证页面函数');

  const clear = () => run(async () => {
    if (!recordingTarget) return;
    setSnapshot(await request('recording.clear', recordingTarget));
    setCallableResult(undefined);
  }, '录制与录制型页面函数已清空');

  const createCallable = () => run(async () => {
    if (snapshot?.status.active) throw new Error('请先停止录制，再保存页面函数');
    if (!selectedEventAvailable || !callableTarget || !selectedEvent?.callHandleId) {
      throw new Error(selectedEvent ? '该调用属于另一个页面文档；返回对应页面现场后才能保存' : '当前事件没有可执行调用句柄');
    }
    const callable = await request('callable.create', {
      ...callableTarget, source: 'recording', callHandleId: selectedEvent.callHandleId, name: callableName,
    });
    setSnapshot((current) => current ? { ...current, callables: [...current.callables.filter((item) => item.id !== callable.id), callable] } : current);
    setSelectedCallableId(callable.id);
    setCallableEditorOpen(false);
    setCallableResult(undefined);
  }, '页面函数已创建');

  const executeCallable = () => run(async () => {
    if (!callableTarget || !selectedCallable) throw new Error(documentAvailable ? '请选择页面函数' : '页面已经导航，旧文档的页面函数不可再执行');
    let args: unknown;
    try { args = JSON.parse(callableArguments); } catch { throw new Error('调用参数必须是有效的 JSON 数组'); }
    if (!Array.isArray(args)) throw new Error('调用参数必须是 JSON 数组');
    setCallableResult(await request('callable.execute', { ...callableTarget, callableId: selectedCallable.id, args }));
  }, '页面函数验证完成');

  const deleteCallable = () => run(async () => {
    if (!callableTarget || !selectedCallable) return;
    const callables = await request('callable.delete', { ...callableTarget, callableId: selectedCallable.id });
    setSnapshot((current) => current ? { ...current, callables } : current);
    setCallableResult(undefined);
  }, '页面函数已删除');

  const active = Boolean(snapshot?.status.active);
  const hasRecording = Boolean(snapshot?.status.startedAt);
  const persistence = snapshot?.status.persistence;
  const persistenceLabel = persistence === 'persisted'
    ? '已持久化'
    : persistence === 'pending'
      ? '正在保存'
      : persistence === 'degraded'
        ? '保存失败 · 仅内存'
        : persistence === 'memory-only' ? '仅内存' : '尚未保存';
  const retentionDrops = (snapshot?.status.budgetDroppedCount || 0)
    + (snapshot?.status.previewDroppedCount || 0)
    + (snapshot?.status.retainedCallDroppedCount || 0);
  const persistenceTitle = [
    persistenceLabel,
    snapshot?.status.persistenceError,
    snapshot?.status.retainedBytes !== undefined
      ? `当前快照 ${(snapshot.status.retainedBytes / 1024).toFixed(1)} KiB`
      : undefined,
    snapshot?.status.globalRetainedBytes !== undefined
      ? `全部录制 ${(snapshot.status.globalRetainedBytes / 1024 / 1024).toFixed(2)} MiB / ${snapshot.status.globalSessionCount || 0} 个会话`
      : undefined,
    snapshot?.status.retainedCallBytes !== undefined
      ? `页面函数句柄 ${(snapshot.status.retainedCallBytes / 1024).toFixed(1)} KiB`
      : undefined,
  ].filter(Boolean).join(' · ');
  const currentDocumentId = snapshot?.status.target.documentId;
  const selectedEventAvailable = eventAvailableInDocument(selectedEvent, currentDocumentId, documentAvailable);
  const outgoingLinks = selectedEvent ? snapshot?.links.filter((link) => link.fromEventId === selectedEvent.id) || [] : [];
  const incomingLinks = selectedEvent ? snapshot?.links.filter((link) => link.toEventId === selectedEvent.id) || [] : [];
  const traceCandidates = snapshot?.profileCandidates.filter((candidate) => candidate.traceId === selectedTraceId) || [];
  const selectedCandidate = traceCandidates.find((candidate) => (
    candidate.sources.some((source) => source.eventId === selectedEventId) || candidate.request.eventId === selectedEventId
  )) || traceCandidates[0];
  const candidateSourceEvent = selectedCandidate
    ? snapshot?.events.find((event) => event.id === selectedCandidate.source.eventId)
    : undefined;
  const candidateAvailable = eventAvailableInDocument(candidateSourceEvent, currentDocumentId, documentAvailable);
  const canDeepCapture = DEEP_CAPTURE_AVAILABLE && selectedEventAvailable && Boolean(selectedEvent
    && ['crypto', 'fetch', 'xhr', 'form', 'beacon', 'worker', 'message'].includes(selectedEvent.kind)
    && (selectedEvent.url || selectedEvent.wrapperHandleId));

  const prepareCallableEditor = () => {
    if (!selectedEventAvailable) return;
    if (!active) {
      setCallableEditorOpen(true);
      return;
    }
    void run(async () => {
      if (!recordingTarget) throw new Error('目标标签页不可用');
      setSnapshot(await request('recording.stop', recordingTarget));
      setCallableEditorOpen(true);
    }, '录制已停止，请确认页面函数名称');
  };

  const continueInference = (candidate: BrowserProfileInferenceCandidate) => {
    setRecoveryProfileId('');
    setSelectedEventId(candidate.capturePlan?.matcherEventId
      || (candidate.sources.length > 1 ? candidate.request.eventId : candidate.source.eventId));
    setAutoArmRequest((current) => current + 1);
    setWorkspaceMode('deep');
  };

  const openRecovery = (profileId: string) => {
    setRecoveryProfileId(profileId);
    setAutoRecoveryRequest((current) => current + 1);
    setWorkspaceMode('deep');
  };

  const finishRecoveryCapture = () => {
    setRecoveryRevision((current) => current + 1);
    setRecoveryProfileId('');
    setWorkspaceMode('gateway');
  };

  const openSuggestedGateway = async (
    candidate: BrowserProfileInferenceCandidate,
    callable: BrowserPageCallable,
    capturedSample?: CapturedCallableSample,
  ) => {
    if (!tab) throw new Error('目标标签页已经关闭');
    const sourceEvent = snapshot?.events.find((item) => item.id === candidate.source.eventId);
    const boundaryEvent = snapshot?.events.find((item) => item.id === candidate.request.eventId);
    const profile = await request('transform.profile.save', createBrowserTransformProfileInput(
      tab,
      sourceEvent,
      callable,
      candidate,
    ));
    setSnapshot((current) => current ? {
      ...current,
      callables: [...current.callables.filter((item) => item.id !== callable.id), callable],
    } : current);
    setGatewaySuggestion((current) => ({
      revision: (current?.revision || 0) + 1,
      candidate,
      callable,
      profile,
      sampleBody: capturedSample?.body || shortSample(candidate.direction === 'response' ? boundaryEvent : sourceEvent),
      sampleLabel: capturedSample?.label || (candidate.direction === 'response' && boundaryEvent
        ? `${eventTitle(boundaryEvent)} · 线上响应`
        : sourceEvent ? `${eventTitle(sourceEvent)} · arg 0` : undefined),
    }));
    setWorkspaceMode('gateway');
  };

  const createSuggestedGateway = (candidate: BrowserProfileInferenceCandidate) => run(async () => {
    if (candidate.sources.length !== 1) {
      throw new Error('多调用请求需要先捕获上层业务函数，不能把相互依赖的低层调用拆开回放');
    }
    if (!candidateAvailable || !recordingTarget || !candidate.source.callHandleId) {
      throw new Error(candidateAvailable ? '推断候选没有可复用的页面调用句柄' : '该函数属于另一个页面文档，请返回对应页面现场后再生成');
    }
    let currentSnapshot = snapshot;
    if (currentSnapshot?.status.active) {
      currentSnapshot = await request('recording.stop', recordingTarget);
      setSnapshot(currentSnapshot);
    }
    if (!currentSnapshot) throw new Error('没有可用的录制现场');
    const target = currentSnapshot.status.target;
    if (!target) throw new Error('录制文档已经失效');
    let callable = currentSnapshot.callables.find((item) => item.provenance.eventId === candidate.source.eventId);
    if (!callable) {
      callable = await request('callable.create', {
        ...target,
        source: 'recording',
        callHandleId: candidate.source.callHandleId,
        name: `${candidate.source.crypto?.algorithm || candidate.source.crypto?.operation || candidate.source.operation} 页面函数`,
      });
    }
    await openSuggestedGateway(candidate, callable);
  }, '已根据录制证据生成并保存明文网关');

  return <section className="recording-section">
    <div className="recording-heading">
      <div className="recording-heading__identity"><span>浏览器现场</span><h2>{workspaceMode === 'gateway' ? '浏览器明文网关' : workspaceMode === 'recording' ? '操作与加解密录制' : '业务函数深度捕获'}</h2></div>
      <div className="recording-mode-switch" role="tablist" aria-label="浏览器现场模式">
        <button id="recording-mode-tab" type="button" role="tab" aria-controls="recording-mode-panel" aria-selected={workspaceMode === 'recording'} className={workspaceMode === 'recording' ? 'is-selected' : ''} disabled={deepPaused} onClick={() => setWorkspaceMode('recording')}><Radio size={14} />录制</button>
        {DEEP_CAPTURE_AVAILABLE && <button id="deep-mode-tab" type="button" role="tab" aria-controls="deep-mode-panel" aria-selected={workspaceMode === 'deep'} className={workspaceMode === 'deep' ? 'is-selected' : ''} onClick={() => setWorkspaceMode('deep')}><Bug size={14} />深度捕获</button>}
        <button id="gateway-mode-tab" type="button" role="tab" aria-controls="gateway-mode-panel" aria-selected={workspaceMode === 'gateway'} className={workspaceMode === 'gateway' ? 'is-selected' : ''} disabled={deepPaused} onClick={() => setWorkspaceMode('gateway')}><FileKey2 size={14} />明文网关</button>
      </div>
      <div className={`recording-heading__actions ${workspaceMode === 'recording' ? '' : 'is-inactive'}`} aria-hidden={workspaceMode !== 'recording'}>
        <span className={`recording-state ${active ? 'is-active' : ''}`} title={persistenceTitle}><i />{active ? `${snapshot?.status.count || 0} 个事件` : hasRecording ? '可分析' : '未录制'}</span>
        {active
          ? <Button variant="ghost" disabled={busy || workspaceMode !== 'recording'} onClick={() => void stop()}><CircleStop size={15} />停止</Button>
          : <Button variant="primary" disabled={busy || workspaceMode !== 'recording' || !tab?.url?.startsWith('http')} onClick={() => void start()}><Play size={15} />录制一次操作</Button>}
      </div>
    </div>

    <div id="recording-mode-panel" className="recording-mode-panel" role="tabpanel" aria-labelledby="recording-mode-tab" hidden={workspaceMode !== 'recording'}><div className="recording-controls">
      <label><Switch checked={captureValues} disabled={active || busy} onCheckedChange={setCaptureValues} /><span><strong>保留短时样本</strong><small>关闭时仅保留本次录制的关联指纹</small></span></label>
      <span className="recording-summary" title={persistenceTitle}>{snapshot?.traces.length || 0} 个 Trace · {snapshot?.links.length || 0} 条值关联 · {snapshot?.callables.length || 0} 个页面函数 · {persistenceLabel}{retentionDrops ? ` · ${retentionDrops} 项按预算丢弃` : ''}</span>
      <Button size="icon" variant="ghost" aria-label="刷新录制" title="刷新录制" disabled={!tab} onClick={() => void load()}><RefreshCw size={15} /></Button>
      <Button size="icon" variant="ghost" aria-label="清空录制" title="清空录制" disabled={!hasRecording || busy} onClick={() => void clear()}><Trash2 size={15} /></Button>
    </div>

    {active && snapshot?.status.navigation && (!documentAvailable || ['restored', 'failed'].includes(snapshot.status.navigation.phase))
      ? <div className={`recording-navigation is-${snapshot.status.navigation.phase}`} role="status">
        <Navigation size={17} />
        <div>
          <strong>{snapshot.status.navigation.phase === 'restored'
            ? '已恢复原页面现场'
            : snapshot.status.navigation.phase === 'failed'
              ? '页面跳转失败，录制仍然保留'
              : '录制仍在继续，正在连接新页面'}</strong>
          <span>{snapshot.status.navigation.phase === 'restored'
            ? '浏览器恢复了原文档，页面函数与录制 Hook 已重新可用。'
            : snapshot.status.navigation.phase === 'failed'
              ? '失败边界已经写入 Trace；如果旧页面仍在，观察器会自动恢复。'
              : '本次跳转已经写入业务 Trace，新文档可用后会自动接续观察器。'}</span>
          <code>{snapshot.status.navigation.toUrl || tab?.url}</code>
        </div>
      </div>
      : null}

    {loadError ? <div className="recording-error"><AlertTriangle size={15} />{loadError}<Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div>
      : !hasRecording ? <div className="recording-empty"><Activity size={23} /><strong>录制一次真实页面操作</strong><span>提交登录、查询或业务表单后，这里会按 Trace 还原页面输入、加解密调用与网络请求。</span></div>
        : <div className="recording-workbench">
          <aside className="recording-traces">
            <header><div><strong>录制时间线</strong><small>最早 ↓ 最新</small></div><span>{snapshot?.traces.length || 0}</span></header>
            <div>
              {snapshot?.traces.map((trace, index) => <button key={trace.id} className={trace.id === selectedTraceId ? 'is-selected' : ''} onClick={() => setSelectedTraceId(trace.id)}>
                <span className="recording-trace-index">{String(index + 1).padStart(2, '0')}</span>
                <span><strong>{trace.label}</strong><small>{trace.requestCount} 请求 · {trace.cryptoCount} 密码调用{trace.messageCount ? ` · ${trace.messageCount} 消息` : ''}{trace.navigationCount ? ` · ${trace.navigationCount} 跳转` : ''}</small></span>
                <time><span>{new Date(trace.startedAt).toLocaleTimeString()}</span><i>{durationLabel(trace.startedAt, trace.endedAt)}</i></time>
              </button>)}
            </div>
          </aside>

          <section className="recording-pipeline">
            <header><div><strong>业务执行链</strong><span>{selectedTrace ? `从上到下 · ${selectedTrace.eventIds.length} 个步骤` : '未选择 Trace'}</span></div>{selectedTrace?.linkedValueCount ? <i><Link2 size={12} />{selectedTrace.linkedValueCount} 条精确值关联</i> : null}</header>
            <div className="recording-pipeline__body">
              {!traceEvents.length ? <div className="recording-column-empty">当前 Trace 没有事件</div> : traceEvents.map((event, index) => {
                const linked = snapshot?.links.some((link) => link.fromEventId === event.id || link.toEventId === event.id);
                const callableAvailable = eventAvailableInDocument(event, currentDocumentId, documentAvailable);
                return <div className={`recording-pipeline-step ${event.kind === 'navigation' ? 'is-navigation' : ''}`} key={event.id}>
                  <span className="recording-step-rail" aria-hidden="true"><i>{String(index + 1).padStart(2, '0')}</i>{index < traceEvents.length - 1 ? <span><ArrowDown size={11} /></span> : null}</span>
                  <button data-event-id={event.id} className={`${event.id === selectedEventId ? 'is-selected' : ''} ${linked ? 'is-linked' : ''}`} onClick={() => setSelectedEventId(event.id)}>
                    <span className={`recording-event-icon kind-${event.kind}`}>{eventIcon(event.kind)}</span>
                    <span><small>{KIND_LABELS[event.kind]}</small><strong>{eventTitle(event)}</strong><em>{eventSubtitle(event)}</em>{event.kind === 'navigation' ? <b>{navigationPhaseLabel(event)}</b> : null}</span>
                    <span className="recording-event-meta">{event.callableCapable ? <i className={callableAvailable ? '' : 'is-history'}>{callableAvailable ? '当前可用' : '历史现场'}</i> : null}<time title={new Date(event.timestamp).toLocaleString()}>{relativeTime(event.timestamp, selectedTrace?.startedAt)}</time>{event.durationMs !== undefined ? <small>{event.durationMs.toFixed(1)} ms</small> : null}</span>
                  </button>
                </div>;
              })}
            </div>
          </section>

          <aside className="recording-inspector">
            {!selectedEvent ? <div className="recording-column-empty">选择一个 Pipeline 步骤</div> : <>
              <header><div><span>{KIND_LABELS[selectedEvent.kind]}</span><strong>{eventTitle(selectedEvent)}</strong><small title={selectedEvent.url || selectedEvent.scriptUrl}>{selectedEvent.url || selectedEvent.scriptUrl || '页面主世界'}</small></div>{selectedEvent.error ? <i className="is-error">ERROR</i> : <i>#{selectedEvent.sequence}</i>}</header>
              {selectedEvent.kind === 'navigation' && selectedEvent.navigation
                ? <dl className="recording-navigation-detail">
                  <div><dt>状态</dt><dd>{navigationPhaseLabel(selectedEvent)}</dd></div>
                  <div><dt>类型</dt><dd>{selectedEvent.navigation.sameDocument ? '同文档路由' : selectedEvent.navigation.kind === 'back-forward' ? '历史前进/后退' : selectedEvent.navigation.kind === 'reload' ? '重新加载' : '主文档切换'}</dd></div>
                  <div><dt>来源</dt><dd title={selectedEvent.navigation.fromUrl}>{requestPath(selectedEvent.navigation.fromUrl) || '未知页面'}</dd></div>
                  <div><dt>目标</dt><dd title={selectedEvent.navigation.toUrl}>{requestPath(selectedEvent.navigation.toUrl) || '/'}</dd></div>
                </dl>
                : <dl><div><dt>输入</dt><dd>{selectedEvent.byteLength === undefined ? `${selectedEvent.inputs.length} 个值` : `${selectedEvent.byteLength} B`}</dd></div><div><dt>输出</dt><dd>{selectedEvent.resultByteLength === undefined ? `${selectedEvent.outputs.length} 个值` : `${selectedEvent.resultByteLength} B`}</dd></div><div><dt>上游</dt><dd>{incomingLinks.length}</dd></div><div><dt>下游</dt><dd>{outgoingLinks.length}</dd></div></dl>}

              {selectedCandidate && <section className={`profile-inference is-${selectedCandidate.confidence.level}`}>
                <div className="profile-inference__heading">
                  <span className="profile-inference__mark"><Sparkles size={15} /></span>
                  <span><small>自动推断 Profile</small><strong>{selectedCandidate.summary}</strong></span>
                  <i><ShieldCheck size={12} />{confidenceLabel(selectedCandidate)}</i>
                </div>
                <div className="profile-inference__flow" aria-label="推断的数据流">
                  {selectedCandidate.flow.map((item, index) => <span key={`${item}-${index}`}>
                    <code>{item}</code>{index < selectedCandidate.flow.length - 1 ? <ChevronRight size={12} /> : null}
                  </span>)}
                </div>
                {selectedCandidate.sources.length > 1 && <div className="profile-inference__sources">
                  {selectedCandidate.sources.map((source, index) => <div key={source.eventId}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{source.crypto ? `${cryptoAdapterLabel(source.crypto.adapterId)} ${source.crypto.algorithm || source.operation}` : source.operation}</strong>
                    <small>{source.destination || '输出字段待确认'}</small>
                  </div>)}
                </div>}
                {selectedCandidate.sources.length === 1 && selectedCandidate.source.arguments.length > 0 && <dl className="profile-inference__arguments">
                  {selectedCandidate.source.arguments.slice(0, 5).map((argument) => <div key={argument.index}>
                    <dt>{selectedCandidate.direction === 'response' && argument.role === 'data' ? '密文输入' : ARGUMENT_LABELS[argument.role]} · arg {argument.index}</dt>
                    <dd>{argument.summary || `${argument.dataType}${argument.byteLength === undefined ? '' : ` · ${argument.byteLength} B`}`}</dd>
                  </div>)}
                </dl>}
                <details className="profile-inference__evidence">
                  <summary>{selectedCandidate.evidence.length} 项证据</summary>
                  <ol>{selectedCandidate.evidence.map((item) => <li key={item.id} data-strength={item.strength}><i />{item.label}</li>)}</ol>
                </details>
                {selectedCandidate.missing[0] && <div className="profile-inference__next"><span>{selectedCandidate.missing[0].label}</span>
                  {selectedCandidate.missing[0].action === 'capture-business-function' && DEEP_CAPTURE_AVAILABLE
                    ? <Button variant="primary" onClick={() => continueInference(selectedCandidate)}><Sparkles size={14} />{selectedCandidate.direction === 'response' ? '自动捕获完整解密流程' : '自动捕获完整加密流程'}</Button>
                    : null}
                </div>}
                {selectedCandidate.status === 'ready' && <div className="profile-inference__next is-ready"><span>{candidateAvailable ? (selectedCandidate.direction === 'response' ? '线上响应字段与页面解密调用已经精确关联，可直接生成响应明文网关。' : '页面调用与线上字段已经精确关联，只需确认明文来源和输出形态。') : '关联证据仍然保留；该页面函数属于另一个文档，返回对应页面现场后可以继续生成。'}</span><Button variant="primary" disabled={busy || !candidateAvailable} onClick={() => void createSuggestedGateway(selectedCandidate)}><FileKey2 size={14} />{candidateAvailable ? '生成明文网关' : '等待对应页面'}</Button></div>}
              </section>}

              {(selectedEvent.inputPreview || selectedEvent.outputPreview) && <div className="recording-values"><strong>短时样本</strong>{selectedEvent.inputPreview && <pre>{selectedEvent.inputPreview}</pre>}{selectedEvent.outputPreview && <pre>{selectedEvent.outputPreview}</pre>}</div>}
              {selectedEvent.kind !== 'navigation' ? <details className="recording-evidence"><summary>调用证据</summary><pre>{selectedEvent.stack || selectedEvent.scriptUrl || '没有可用调用栈'}</pre></details> : null}

              {canDeepCapture && !selectedCandidate && <section className="recording-deep-action">
                <div><Bug size={15} /><span><strong>捕获真实业务上下文</strong><small>{selectedEvent.kind === 'crypto'
                  ? '下次命中当前加密调用时暂停'
                  : selectedEvent.kind === 'worker' || selectedEvent.kind === 'message' || selectedEvent.kind === 'beacon'
                    ? '下次命中当前页面通信边界时暂停'
                    : '下次发出当前请求时暂停'}</small></span></div>
                <Button variant="primary" onClick={() => setWorkspaceMode('deep')}><Bug size={14} />深入当前调用</Button>
              </section>}

              {selectedEvent.callableCapable && selectedEvent.callHandleId && <section className="recording-recipe-action">
                <div><KeyRound size={15} /><span><strong>保存为页面函数</strong><small>{!selectedEventAvailable ? '该调用属于另一个页面文档，返回对应页面后可以恢复' : active ? '保存前会先停止录制，避免轮询继续改变调用现场' : '保留原函数、receiver 与固定参数，页面刷新后失效'}</small></span></div>
                {!callableEditorOpen ? <Button variant="primary" disabled={busy || !selectedEventAvailable} onClick={prepareCallableEditor}><Save size={14} />{active ? '停止录制并保存' : '保存页面函数'}</Button> : <div className="recording-recipe-editor">
                  <label><span>名称</span><input value={callableName} onChange={(event) => setCallableName(event.target.value)} /></label>
                  <div className="recording-recipe-editor__actions"><Button variant="ghost" onClick={() => setCallableEditorOpen(false)}>取消</Button><Button variant="primary" disabled={!callableName.trim() || busy} onClick={() => void createCallable()}><Check size={14} />创建</Button></div>
                </div>}
              </section>}

              {snapshot?.callables.length ? <section className="recording-recipes">
                <div className="recording-recipes__heading"><strong>验证页面函数</strong><select value={selectedCallableId} onChange={(event) => { setSelectedCallableId(event.target.value); setCallableResult(undefined); }}>{snapshot.callables.map((callable) => <option key={callable.id} value={callable.id}>{callable.name}</option>)}</select></div>
                {selectedCallable && <><div className="recording-recipe-meta"><span>{selectedCallable.operation}</span><i>{selectedCallable.kind === 'recorded-call' ? '录制调用' : selectedCallable.kind === 'request-transaction' ? '请求事务' : '业务闭包'} · {selectedCallable.inputSlots.length} 个参数</i></div><textarea rows={4} value={callableArguments} onChange={(event) => setCallableArguments(event.target.value)} placeholder={'["明文或结构化参数"]'} /><div className="recording-recipe-buttons"><Button variant="ghost" size="icon" aria-label="删除页面函数" title="删除页面函数" onClick={() => void deleteCallable()}><Trash2 size={14} /></Button><Button variant="primary" disabled={busy} onClick={() => void executeCallable()}><Play size={14} />运行验证</Button></div></>}
                {callableResult && <div className="recording-recipe-result"><div><strong>输出 · {callableResult.type}</strong><span>{callableResult.byteLength === undefined ? '' : `${callableResult.byteLength} B · `}{callableResult.durationMs.toFixed(1)} ms</span><Button size="icon" variant="ghost" aria-label="复制函数输出" title="复制函数输出" onClick={() => void navigator.clipboard.writeText(callableResult.preview)}><Copy size={14} /></Button></div><pre>{callableResult.preview}</pre></div>}
              </section> : null}
            </>}
          </aside>
        </div>}
    </div>
    {DEEP_CAPTURE_AVAILABLE && <div id="deep-mode-panel" className="recording-mode-panel" role="tabpanel" aria-labelledby="deep-mode-tab" hidden={workspaceMode !== 'deep'}>
      <DeepCaptureWorkspace
        tab={tab}
        selectedEvent={selectedEvent}
        selectedCandidate={selectedCandidate}
        autoArmRequest={autoArmRequest}
        recoveryProfileId={recoveryProfileId}
        autoRecoveryRequest={autoRecoveryRequest}
        busy={busy}
        run={run}
        onPausedChange={setDeepPaused}
        onUseRecommendedCallable={openSuggestedGateway}
        onRecoveryCaptured={finishRecoveryCapture}
      />
    </div>}
    <div id="gateway-mode-panel" className="recording-mode-panel" role="tabpanel" aria-labelledby="gateway-mode-tab" hidden={workspaceMode !== 'gateway'}>
      <BrowserTransformWorkspace
        tab={tab}
        selectedEvent={selectedEvent}
        busy={busy}
        run={run}
        gatewayShared={gatewayShared}
        onShareGateway={onShareGateway}
        onOpenCapture={() => { setRecoveryProfileId(''); setWorkspaceMode(DEEP_CAPTURE_AVAILABLE ? 'deep' : 'recording'); }}
        onOpenRecovery={DEEP_CAPTURE_AVAILABLE ? openRecovery : () => setWorkspaceMode('recording')}
        deepCaptureAvailable={DEEP_CAPTURE_AVAILABLE}
        recoveryRevision={recoveryRevision}
        suggestion={gatewaySuggestion}
      />
    </div>
  </section>;
}
