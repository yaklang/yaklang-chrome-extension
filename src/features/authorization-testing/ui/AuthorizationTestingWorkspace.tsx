import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, CircleCheck, Fingerprint, Link2,
  Play, RefreshCw, RotateCcw, ShieldAlert, Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage, request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, BridgeStatus, BrowserAuthorizationInstance, NetworkCaptureStatus,
} from '@/types/models';
import {
  runBrowserAuthorizationTask,
  type BrowserAuthorizationPair,
  type BrowserAuthorizationPairInspection,
  type BrowserAuthorizationRequest,
  type BrowserAuthorizationResult,
  type BrowserAuthorizationSide,
} from '../engine';
import { IdentitySlot } from './IdentitySlot';
import './authorization-testing-workspace.css';

interface AuthorizationTestingWorkspaceProps {
  bridge: BridgeStatus;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
  busy: boolean;
}

function origin(tab?: ActiveTabInfo): string {
  try {
    return tab ? new URL(tab.url).origin : '';
  } catch {
    return '';
  }
}

function requestLabel(item: BrowserAuthorizationRequest): string {
  try {
    const parsed = new URL(item.url);
    return `${item.method} ${parsed.pathname}${parsed.search}${item.statusCode ? ` · ${item.statusCode}` : ''}`;
  } catch {
    return `${item.method} ${item.url}`;
  }
}

function requestRoute(item: BrowserAuthorizationRequest): string {
  try {
    const parsed = new URL(item.url);
    const path = parsed.pathname.split('/').map((segment) => (
      /^\d+$/.test(segment) || /^[0-9a-f-]{16,}$/i.test(segment) ? ':value' : segment
    )).join('/');
    return `${item.method} ${parsed.origin}${path} ${[...parsed.searchParams.keys()].sort().join(',')}`;
  } catch {
    return `${item.method} ${item.url}`;
  }
}

function newestPair(left: BrowserAuthorizationRequest[], right: BrowserAuthorizationRequest[]) {
  for (const leftItem of left) {
    const rightItem = right.find((item) => requestRoute(item) === requestRoute(leftItem));
    if (rightItem) return { left: leftItem, right: rightItem };
  }
  return undefined;
}

function outcomeLabel(value: BrowserAuthorizationResult['cases'][number]['outcome']): string {
  if (value === 'success') return '成功';
  if (value === 'denied') return '明确拒绝';
  if (value === 'redirect') return '重定向';
  if (value === 'client-error') return '客户端错误';
  if (value === 'server-error') return '服务端错误';
  return '响应不可判定';
}

function verdictTone(value: BrowserAuthorizationResult['verdict']): 'warning' | 'success' | 'muted' {
  if (value === 'protected') return 'success';
  if (value === 'suspected' || value === 'possible') return 'warning';
  return 'muted';
}

export function AuthorizationTestingWorkspace({ bridge, run, busy }: AuthorizationTestingWorkspaceProps) {
  const [instances, setInstances] = useState<BrowserAuthorizationInstance[]>([]);
  const [leftDeviceId, setLeftDeviceId] = useState('');
  const [rightDeviceId, setRightDeviceId] = useState('');
  const [leftTabId, setLeftTabId] = useState<number>();
  const [rightTabId, setRightTabId] = useState<number>();
  const [leftLabel, setLeftLabel] = useState('账号 A');
  const [rightLabel, setRightLabel] = useState('账号 B');
  const [capture, setCapture] = useState<Partial<Record<BrowserAuthorizationSide, NetworkCaptureStatus>>>({});
  const [requests, setRequests] = useState<Record<BrowserAuthorizationSide, BrowserAuthorizationRequest[]>>({ left: [], right: [] });
  const [selected, setSelected] = useState<Record<BrowserAuthorizationSide, string>>({ left: '', right: '' });
  const [inspection, setInspection] = useState<BrowserAuthorizationPairInspection>();
  const [selectorId, setSelectorId] = useState('');
  const [result, setResult] = useState<BrowserAuthorizationResult>();
  const [localError, setLocalError] = useState('');

  const leftInstance = instances.find((item) => item.deviceId === leftDeviceId);
  const rightInstance = instances.find((item) => item.deviceId === rightDeviceId);
  const leftTab = leftInstance?.tabs.find((item) => item.id === leftTabId);
  const rightTab = rightInstance?.tabs.find((item) => item.id === rightTabId);
  const sameOrigin = Boolean(leftTab && rightTab && origin(leftTab) === origin(rightTab));
  const capabilityReady = bridge.state === 'connected'
    && Boolean(bridge.capabilities?.includes('yakit.browser_authorization.task'));
  const discoveryReady = bridge.state === 'connected'
    && Boolean(bridge.capabilities?.includes('yakit.browser_authorization.instances'));
  const pairReady = Boolean(leftInstance && rightInstance && leftTab && rightTab
    && leftDeviceId !== rightDeviceId && sameOrigin && capabilityReady);
  const capturing = Boolean(capture.left?.active && capture.right?.active);

  const pair = useCallback((): BrowserAuthorizationPair => {
    if (!pairReady || !leftTabId || !rightTabId) throw new Error('请选择两个在线 YTray 浏览器中的同站点页面');
    return {
      left: { deviceId: leftDeviceId, tabId: leftTabId },
      right: { deviceId: rightDeviceId, tabId: rightTabId },
    };
  }, [leftDeviceId, leftTabId, pairReady, rightDeviceId, rightTabId]);

  const refreshInstances = useCallback(async () => {
    if (!discoveryReady) {
      setInstances([]);
      return;
    }
    const response = await request('authorization.yakit.instances');
    const next = Array.isArray(response.instances) ? response.instances : [];
    setInstances(next);
    const left = next.find((item) => item.current);
    const right = next.find((item) => !item.current);
    setLeftDeviceId((current) => next.some((item) => item.deviceId === current) ? current : left?.deviceId || '');
    setRightDeviceId((current) => next.some((item) => item.deviceId === current && !item.current) ? current : right?.deviceId || '');
  }, [discoveryReady]);

  useEffect(() => {
    void refreshInstances().catch((error) => setLocalError(errorMessage(error)));
    const visible = () => document.visibilityState === 'visible'
      && void refreshInstances().catch((error) => setLocalError(errorMessage(error)));
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [refreshInstances]);

  useEffect(() => {
    setLeftTabId((current) => leftInstance?.tabs.some((tab) => tab.id === current)
      ? current : leftInstance?.tabs.find((tab) => tab.active)?.id || leftInstance?.tabs[0]?.id);
  }, [leftInstance]);

  useEffect(() => {
    setRightTabId((current) => rightInstance?.tabs.some((tab) => tab.id === current)
      ? current : rightInstance?.tabs.find((tab) => tab.active)?.id || rightInstance?.tabs[0]?.id);
  }, [rightInstance]);

  const task = <T,>(schema: Parameters<typeof runBrowserAuthorizationTask>[0], extra: Record<string, unknown> = {}, timeoutMs?: number) => (
    runBrowserAuthorizationTask<T>(schema, { ...pair(), ...extra }, timeoutMs)
  );

  const startCapture = () => run(async () => {
    setLocalError('');
    const left = await task<NetworkCaptureStatus>('authorization.capture.start', { side: 'left' });
    try {
      const right = await task<NetworkCaptureStatus>('authorization.capture.start', { side: 'right' });
      setCapture({ left, right });
      setRequests({ left: [], right: [] });
      setInspection(undefined);
      setResult(undefined);
    } catch (error) {
      await task('authorization.capture.stop', { side: 'left' }).catch(() => undefined);
      throw error;
    }
  }, 'A/B 请求捕获已开始');

  const stopCapture = (side: BrowserAuthorizationSide) => run(async () => {
    const status = await task<NetworkCaptureStatus>('authorization.capture.stop', { side });
    setCapture((current) => ({ ...current, [side]: status }));
  }, `${side === 'left' ? leftLabel : rightLabel} 的捕获已停止`);

  const inspect = async (leftRequestId: string, rightRequestId: string) => {
    const next = await task<BrowserAuthorizationPairInspection>('authorization.pair.inspect', {
      leftRequestId, rightRequestId,
    });
    setInspection(next);
    setSelectorId((current) => next.selectors.some((item) => item.id === current)
      ? current : next.selectors[0]?.id || '');
    setResult(undefined);
  };

  const readRequests = () => run(async () => {
    setLocalError('');
    const [left, right] = await Promise.all([
      task<BrowserAuthorizationRequest[]>('authorization.requests', { side: 'left', limit: 50 }),
      task<BrowserAuthorizationRequest[]>('authorization.requests', { side: 'right', limit: 50 }),
    ]);
    setRequests({ left, right });
    const found = newestPair(left, right);
    if (!found) throw new Error('没有找到 A/B 最近一次同类请求，请分别执行相同业务动作后重试');
    setSelected({ left: found.left.id, right: found.right.id });
    await inspect(found.left.id, found.right.id);
  }, '已找到 A/B 最近一次同类请求');

  const inspectSelected = () => run(async () => {
    if (!selected.left || !selected.right) throw new Error('请为 A/B 各选择一条请求');
    await inspect(selected.left, selected.right);
  }, '已重新分析可交换资源字段');

  const execute = () => run(async () => {
    if (!selected.left || !selected.right || !selectorId || !inspection) throw new Error('请先读取并确认请求与资源字段');
    const approved = window.confirm(
      `${inspection.method} ${inspection.route} 将发送最多 4 个真实请求`
      + `${inspection.sideEffect ? '，该方法可能改变业务状态' : ''}。仅对你有权测试的目标继续。`,
    );
    if (!approved) return;
    const next = await task<BrowserAuthorizationResult>('authorization.execute', {
      leftRequestId: selected.left,
      rightRequestId: selected.right,
      selectorId,
      approveSideEffect: inspection.sideEffect,
    }, 120_000);
    setResult(next);
  }, 'A/B 交叉测试完成');

  const reset = () => run(async () => {
    await Promise.allSettled((['left', 'right'] as const).map(async (side) => (
      task('authorization.capture.stop', { side })
    )));
    setCapture({});
    setRequests({ left: [], right: [] });
    setSelected({ left: '', right: '' });
    setInspection(undefined);
    setSelectorId('');
    setResult(undefined);
    setLocalError('');
  });

  const assignRightInstance = (deviceId: string) => {
    const instance = instances.find((item) => item.deviceId === deviceId);
    setRightDeviceId(deviceId);
    setRightTabId(instance?.tabs.find((tab) => tab.active)?.id || instance?.tabs[0]?.id);
  };

  return <div className="section-view authorization-workspace">
    <div className="page-heading authorization-heading">
      <div>
        <span className="page-eyebrow">本地确定性测试</span>
        <h1>越权测试</h1>
        <p>在两个 YTray 浏览器中执行同一业务动作，插件捕获请求，Yak 只交换资源字段并重放 A/B 对照。</p>
      </div>
      <div className="authorization-heading-actions">
        <span className={`authorization-engine-state ${capabilityReady ? 'ready' : ''}`}><i />{capabilityReady ? '引擎可用' : '引擎能力不可用'}</span>
        <Button variant="ghost" disabled={busy} onClick={() => void reset()}><RotateCcw size={15} />重置</Button>
      </div>
    </div>

    {localError && <div className="authorization-inline-error">
      <AlertTriangle size={16} />{localError}
      <Button size="sm" variant="ghost" onClick={() => setLocalError('')}>关闭</Button>
    </div>}

    <div className="authorization-flow-strip" aria-label="越权测试步骤">
      {[
        ['1', 'A/B 页面', capturing],
        ['2', '同类请求', Boolean(inspection)],
        ['3', '交叉结果', Boolean(result)],
      ].map(([index, label, complete], position) => <div className={complete ? 'complete' : ''} key={String(label)}>
        <span>{complete ? <Check size={13} /> : index}</span><strong>{label}</strong>
        {position < 2 && <ArrowRight size={14} />}
      </div>)}
    </div>

    <section className="authorization-identity-stage">
      <div className="authorization-identity-guide" aria-label="准备两个身份">
        <span className={leftTab ? 'complete' : 'current'}><b>{leftTab ? <Check size={12} /> : '1'}</b>A 登录资源账号</span>
        <ArrowRight size={14} />
        <span className={rightTab ? 'complete' : leftTab ? 'current' : ''}><b>{rightTab ? <Check size={12} /> : '2'}</b>B 登录对照账号</span>
        <ArrowRight size={14} />
        <span className={pairReady ? 'complete' : ''}><b>{pairReady ? <Check size={12} /> : '3'}</b>开始捕获</span>
      </div>
      <div className="authorization-identity-rail">
        <IdentitySlot side="A" title="身份 A" label={leftLabel} setLabel={setLeftLabel}
          instance={leftInstance} instances={instances} tabId={leftTabId} setTabId={setLeftTabId} />
        <div className="authorization-isolation-axis">
          <Fingerprint size={23} />
          <strong>{leftInstance && rightInstance ? '独立 YTray 实例' : '等待 A/B 实例'}</strong>
          <span className={sameOrigin ? 'valid' : ''}>{sameOrigin ? '当前页面属于同一站点' : 'A/B 请选择同一站点页面'}</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshInstances()}><RefreshCw size={14} />刷新实例</Button>
        </div>
        <IdentitySlot side="B" title="身份 B" label={rightLabel} setLabel={setRightLabel}
          instance={rightInstance} instances={instances} setInstanceId={assignRightInstance}
          tabId={rightTabId} setTabId={setRightTabId} />
      </div>
      <div className="authorization-prepare-bar">
        <div><Link2 size={18} /><span><strong>不调用 AI，不保存身份工作区</strong><small>登录跳转后直接读取当前页面；请求凭据只在本机重放。</small></span></div>
        <div className="authorization-prepare-action">
          <small>{pairReady ? 'A/B 已就绪' : discoveryReady ? '请完成 A/B 页面选择' : '请更新并连接 Yak 引擎'}</small>
          <Button variant="primary" disabled={busy || !pairReady || capturing} onClick={() => void startCapture()}><Play size={15} />开始捕获</Button>
        </div>
      </div>
    </section>

    {capturing && <section className="authorization-baseline-stage">
      <div className="authorization-section-heading">
        <div><span>STEP 02</span><h2>分别执行一次相同业务动作</h2><p>完成后读取双方最近请求。自动匹配失败时，可在下方手工选择。</p></div>
        <Button variant="primary" disabled={busy} onClick={() => void readRequests()}><RefreshCw size={15} />读取并分析</Button>
      </div>
      <div className="authorization-baseline-lanes">
        {(['left', 'right'] as const).map((side) => <div className="authorization-baseline-lane" key={side}>
          <header>
            <span>{side === 'left' ? leftInstance?.badge || 'A' : rightInstance?.badge || 'B'}</span>
            <div><strong>{side === 'left' ? leftLabel : rightLabel}</strong><small>{side === 'left' ? leftTab?.title : rightTab?.title}</small></div>
            <span className="authorization-capture-dot active"><i />{capture[side]?.count || 0} 条</span>
            <Button size="icon" variant="ghost" title="停止捕获" onClick={() => void stopCapture(side)}><Square size={14} /></Button>
          </header>
          <select value={selected[side]} onChange={(event) => {
            setSelected((current) => ({ ...current, [side]: event.target.value }));
            setInspection(undefined);
            setResult(undefined);
          }}>
            <option value="">{requests[side].length ? '选择一条请求' : '执行动作后点击读取'}</option>
            {requests[side].map((item) => <option value={item.id} key={item.id}>{requestLabel(item)}</option>)}
          </select>
        </div>)}
      </div>
      <div className="authorization-baseline-confirm">
        <span>{inspection ? `${inspection.method} ${inspection.route}` : 'A/B 请求应当属于同一个接口与业务动作'}</span>
        <Button variant="secondary" disabled={busy || !selected.left || !selected.right} onClick={() => void inspectSelected()}><Check size={15} />分析当前选择</Button>
      </div>
    </section>}

    {inspection && <section className="authorization-plan-stage">
      <div className="authorization-section-heading">
        <div><span>STEP 03</span><h2>选择要交换的资源字段</h2><p>只交换一个非认证字段；Cookie、Token、CSRF、签名字段不会作为候选。</p></div>
      </div>
      <div className="authorization-plan-layout">
        <div className="authorization-plan-candidates">
          {inspection.selectors.map((selector) => <button key={selector.id} className={selectorId === selector.id ? 'selected' : ''} onClick={() => setSelectorId(selector.id)}>
            <span className="authorization-radio-mark" />
            <span><strong>{selector.label}</strong><small>{selector.location} · {selector.path}</small></span>
          </button>)}
        </div>
        <div className="authorization-plan-review">
          <div className="authorization-plan-summary ready">
            <strong>最多 4 个真实请求</strong>
            <span>A 正常 → B 正常 → A 访问 B → B 访问 A</span>
            <small>{inspection.sideEffect ? '当前方法可能改变业务状态，执行前会再次确认。' : '当前方法为只读请求。'}</small>
          </div>
          {inspection.limitations.length > 0 && <div className="authorization-no-candidates"><AlertTriangle size={18} /><div><strong>请求限制</strong><p>{inspection.limitations.join('；')}</p></div></div>}
          <div className="authorization-plan-actions"><Button variant="primary" disabled={busy || !selectorId || Boolean(inspection.blockedReason)} onClick={() => void execute()}><Play size={15} />确认并执行</Button></div>
        </div>
      </div>
    </section>}

    {result && <section className={`authorization-result ${verdictTone(result.verdict)}`}>
      <header>
        <div>{result.verdict === 'protected' ? <CircleCheck size={23} /> : <ShieldAlert size={23} />}<span><strong>{result.summary}</strong><small>确定性结果 · {result.selector.label}</small></span></div>
      </header>
      <div className="authorization-result-cases">
        {result.cases.map((item, index) => <div key={item.id}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{item.label}</strong><small>{item.status} {item.statusText} · {item.durationMs.toFixed(0)} ms · {item.bodyBytes} B</small></div>
          <em className={item.outcome}>{item.matchesTarget ? '匹配目标响应' : outcomeLabel(item.outcome)}</em>
        </div>)}
      </div>
    </section>}
  </div>;
}
