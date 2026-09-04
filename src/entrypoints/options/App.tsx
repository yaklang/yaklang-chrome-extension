import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { browser, type Browser } from 'wxt/browser';
import {
  Activity, AlertTriangle, Bot, Braces, Check, ChevronRight, CircleGauge, CloudDownload, Cookie, Copy,
  Database, Download, Eye, FileKey2, Fingerprint, History, KeyRound, MousePointer2, Network, Play, Power, Radio,
  RefreshCw, Route, Save, Search, Send, Server, ShieldCheck, Square, Trash2, Upload, UserRoundCog, X,
} from 'lucide-react';
import { ProductBrand, YakitMark } from '@/components/brand/Brand';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AUDIT_CATEGORY_LABELS, AUDIT_OUTCOME_LABELS, HANDOFF_REASON_LABELS, waitingHandoff,
} from '@/features/handoff/presentation';
import { cookieKey, cookieRemovalInput } from '@/features/cookies/presentation';
import { AutoSwitchView } from '@/features/proxy/ui/AutoSwitchView';
import { ProxyProfilesView } from '@/features/proxy/ui/ProxyProfilesView';
import { RuleSourcesView } from '@/features/proxy/ui/RuleSourcesView';
import { RecordingWorkspace } from '@/features/browser-recording/RecordingWorkspace';
import { AuthorizationTestingWorkspace } from '@/features/authorization-testing/ui/AuthorizationTestingWorkspace';
import { AGENT_RUNTIME_STORAGE_KEY, AUDIT_STORAGE_KEY, isStateStorageChange } from '@/protocol/storage';
import type {
  ActiveTabInfo, AgentRuntime, AuditEvent, BridgePairingStatus, BridgeStatus, BrowserCookie, BrowserRequestAnalysisBundle, CookieInput, CookieTransferFormat, EnterprisePolicyStatus, ExtensionState, HumanHandoff,
  NetworkCaptureStatus, NetworkRequestExport, NetworkRequestRecord, PageContext, PageEvalResult,
  PageFrameSummary, PageNodeDetails, PageNodeSummary,
  UserAgentProfile, UserAgentProfileInput, YakPocGenerateResult,
} from '@/types/models';
import { errorMessage, request } from '@/platform/messaging/runtime';
import { APPEARANCE_STORAGE_KEY, getAppearance, setThemePreference, type ThemePreference } from '@/platform/storage/appearance';
import './App.css';

type Section = 'overview' | 'authorization' | 'network' | 'gateway' | 'proxies' | 'rules' | 'sources' | 'cookies' | 'user-agent' | 'context' | 'engine' | 'activity';
const FIREFOX_AMO_BUILD = import.meta.env.FIREFOX && import.meta.env.MODE === 'store';

const NAVIGATION: Array<{ label?: string; items: Array<{ id: Section; label: string; icon: ReactNode }> }> = [
  {
    items: [{ id: 'overview', label: '概览', icon: <CircleGauge size={17} /> }],
  },
  {
    label: '安全测试',
    items: [{ id: 'authorization', label: '越权测试', icon: <Fingerprint size={17} /> }],
  },
  {
    label: '请求与改写',
    items: [
      { id: 'network', label: '请求捕获', icon: <Activity size={17} /> },
      { id: 'gateway', label: '明文网关', icon: <FileKey2 size={17} /> },
    ],
  },
  {
    label: '代理',
    items: [
      { id: 'proxies', label: '代理设置', icon: <Network size={17} /> },
      { id: 'rules', label: '分流规则', icon: <Route size={17} /> },
      { id: 'sources', label: '规则订阅', icon: <CloudDownload size={17} /> },
    ],
  },
  {
    label: '浏览器工具',
    items: [
      { id: 'context', label: '页面上下文', icon: <KeyRound size={17} /> },
      { id: 'cookies', label: 'Cookie 管理', icon: <Cookie size={17} /> },
      { id: 'user-agent', label: 'User-Agent', icon: <UserRoundCog size={17} /> },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'engine', label: '引擎连接', icon: <Server size={17} /> },
      { id: 'activity', label: '操作记录', icon: <History size={17} /> },
    ],
  },
];
const SECTIONS = NAVIGATION.flatMap((group) => group.items);

const CONTEXT_SECTION_LABELS: Record<PageContext['diff']['changedSections'][number], string> = {
  capture_options: '采集范围',
  document: '文档',
  authentication: '认证',
  forms: '表单',
  interactive: '可操作元素',
  storage: 'Storage',
  cookies: 'Cookie',
};

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state"><Database size={22} /><span>{children}</span></div>;
}

function App() {
  const initialHash = location.hash.slice(1) as Section;
  const [section, setSection] = useState<Section>(SECTIONS.some((item) => item.id === initialHash) ? initialHash : 'overview');
  const [state, setState] = useState<ExtensionState>();
  const [tab, setTab] = useState<ActiveTabInfo>();
  const [tabs, setTabs] = useState<ActiveTabInfo[]>([]);
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'disconnected', message: '未连接引擎' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [theme, setTheme] = useState<ThemePreference>('system');

  const load = useCallback(async () => {
    const requestedTabId = Number(new URLSearchParams(location.search).get('tabId'));
    const [nextState, nextTab, nextTabs, nextBridge] = await Promise.all([
      request('state.get'),
      Number.isSafeInteger(requestedTabId) && requestedTabId > 0
        ? request('tab.get', { tabId: requestedTabId }).catch(() => request('tab.active').catch(() => undefined))
        : request('tab.active').catch(() => undefined),
      request('tab.list'),
      request('bridge.status'),
    ]);
    setState(nextState);
    setTab(nextTab);
    setTabs(nextTabs);
    setBridge(nextBridge);
  }, []);

  const refreshTabs = useCallback(async () => {
    const nextTabs = await request('tab.list');
    setTabs(nextTabs);
    setTab((current) => current ? nextTabs.find((item) => item.id === current.id) : current);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => void refreshTabs().catch(() => undefined), 80);
    };
    const onCreated = () => scheduleRefresh();
    const onUpdated = (_tabId: number, change: Browser.tabs.OnUpdatedInfo) => {
      if (change.url !== undefined || change.title !== undefined || change.status === 'complete') scheduleRefresh();
    };
    const onRemoved = () => scheduleRefresh();
    browser.tabs.onCreated.addListener(onCreated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    return () => {
      if (timer) globalThis.clearTimeout(timer);
      browser.tabs.onCreated.removeListener(onCreated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [refreshTabs]);
  useEffect(() => {
    const listener = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) void request('state.get').then(setState).catch(() => undefined);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);
  useEffect(() => {
    const listener = (message: unknown) => {
      const input = message as { action?: string; payload?: BridgeStatus };
      if (input?.action === 'bridge.status.changed' && input.payload) setBridge(input.payload);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
  useEffect(() => {
    void getAppearance().then((appearance) => setTheme(appearance.theme));
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' || !(APPEARANCE_STORAGE_KEY in changes)) return;
      const next = (changes[APPEARANCE_STORAGE_KEY] as { newValue?: { theme?: ThemePreference } })?.newValue;
      setTheme(next?.theme && ['system', 'light', 'dark'].includes(next.theme) ? next.theme : 'system');
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const value = location.hash.slice(1) as Section;
      if (SECTIONS.some((item) => item.id === value)) setSection(value);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (next: Section) => {
    setSection(next);
    history.replaceState(null, '', `#${next}`);
  };

  const selectTab = async (tabId: number) => {
    const next = await request('tab.get', { tabId });
    setTab(next);
    const url = new URL(location.href);
    url.searchParams.set('tabId', String(tabId));
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await task();
      if (success) setNotice({ kind: 'ok', text: success });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div className="workspace-loading"><RefreshCw className="spin" size={19} /> 正在初始化 Yakit Browser Agent</div>;
  const handoff = waitingHandoff(state.handoff);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><ProductBrand /></div>
        <nav>{NAVIGATION.map((group, index) => <div className={`sidebar-group ${index === 0 ? 'is-primary' : ''}`} key={group.label || 'overview'}>{group.label && <span className="sidebar-group__label">{group.label}</span>}{group.items.map((item) => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => navigate(item.id)}>{item.icon}<span>{item.label}</span><ChevronRight size={14} /></button>)}</div>)}</nav>
        <div className="sidebar-theme">
          <span>外观</span>
          <select aria-label="界面主题" value={theme} onChange={(event) => { const next = event.target.value as ThemePreference; setTheme(next); void setThemePreference(next); }}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="sidebar-status"><span className="sidebar-yakit-mark"><YakitMark /><i className={`connection-dot ${bridge.state}`} /></span><div><strong>{bridge.state === 'connected' ? '引擎在线' : '引擎离线'}</strong><span>{state.bridge.transport === 'native' ? state.bridge.nativeHost : state.bridge.endpoint}</span></div></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          {section === 'authorization' ? <div className="topbar-workspace-context">
            <Fingerprint size={16} />
            <div><strong>授权测试</strong><small>A/B 页面在工作区内选择</small></div>
          </div> : <div className="topbar-tab">
            <span className="topbar-tab__favicon">{tab?.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Radio size={13} />}</span>
            <select className="target-tab-select" aria-label="目标标签页" value={tab?.id || ''} onChange={(event) => void selectTab(Number(event.target.value))}><option value="" disabled>选择目标标签页</option>{tabs.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
          </div>}
          <div className="topbar-actions"><span className={`permission-state ${bridge.state === 'connected' ? 'enabled' : ''}`}><ShieldCheck size={14} />{bridge.state === 'connected' ? '实例已连接' : '实例离线'}</span><Button size="icon" variant="ghost" title="刷新状态" onClick={() => void load()}><RefreshCw size={17} /></Button></div>
        </header>

        {handoff && <HandoffBanner handoff={handoff} setState={setState} run={run} busy={busy} />}

        <div className="content-area">
          {section === 'overview' && <Overview state={state} bridge={bridge} tab={tab} navigate={navigate} run={run} busy={busy} />}
          {section === 'authorization' && <AuthorizationTestingWorkspace bridge={bridge} run={run} busy={busy} />}
          {section === 'proxies' && <ProxyProfilesView state={state} setState={setState} run={run} busy={busy} tab={tab} />}
          {section === 'rules' && <AutoSwitchView state={state} setState={setState} tab={tab} run={run} busy={busy} />}
          {section === 'sources' && <RuleSourcesView state={state} setState={setState} tab={tab} run={run} busy={busy} />}
          {section === 'cookies' && <CookieEditor key={tab?.id || 0} tab={tab} run={run} busy={busy} />}
          {section === 'user-agent' && <UserAgents state={state} setState={setState} tab={tab} run={run} busy={busy} />}
          {section === 'network' && <NetworkActivity key={tab?.id || 0} tab={tab} bridge={bridge} run={run} busy={busy} />}
          {section === 'gateway' && <GatewayWorkspace key={tab?.id || 0} tab={tab} bridge={bridge} run={run} busy={busy} />}
          {section === 'context' && <ContextTool key={tab?.id || 0} tab={tab} run={run} busy={busy} />}
          {section === 'engine' && <EngineSettings state={state} setState={setState} bridge={bridge} setBridge={setBridge} tabs={tabs} run={run} busy={busy} />}
          {section === 'activity' && <ActivityLog run={run} busy={busy} />}
        </div>
        {notice && <div className={`toast ${notice.kind}`}>{notice.kind === 'ok' ? <Check size={15} /> : <X size={15} />}{notice.text}</div>}
      </main>
    </div>
  );
}

function HandoffBanner({ handoff, setState, run, busy }: { handoff: HumanHandoff; setState: (state: ExtensionState) => void; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const resolve = (outcome: 'completed' | 'cancelled') => run(
    async () => setState(await request('handoff.resolve', { id: handoff.id, outcome })),
    outcome === 'completed' ? '已通知 Agent 继续执行' : '人工接管已取消',
  );
  return <section className="handoff-banner" aria-live="assertive">
    <AlertTriangle size={20} />
    <div className="handoff-banner__copy">
      <span>{HANDOFF_REASON_LABELS[handoff.reason]}</span>
      <strong>{handoff.message}</strong>
      <small title={handoff.target.grantedUrl}>{handoff.target.title} · {handoff.target.origin}</small>
    </div>
    <div className="handoff-banner__actions">
      <Button variant="primary" disabled={busy} onClick={() => void resolve('completed')}><Check size={15} />操作已完成</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void resolve('cancelled')}><X size={15} />取消任务</Button>
    </div>
  </section>;
}

function ActivityLog({ run, busy }: { run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [runtime, setRuntime] = useState<AgentRuntime>({ state: 'idle', updatedAt: Date.now(), actions: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadEvents = useCallback(async () => {
    try {
      setLoadError('');
      setEvents(await request('audit.list', { limit: 200 }));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  const loadRuntime = useCallback(() => request('agent.runtime.get').then(setRuntime), []);
  useEffect(() => {
    void Promise.all([loadEvents(), loadRuntime()]);
    const listener = (changes: Record<string, unknown>) => {
      if (AUDIT_STORAGE_KEY in changes) void loadEvents();
      if (AGENT_RUNTIME_STORAGE_KEY in changes) void loadRuntime();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [loadEvents, loadRuntime]);

  const runtimeLabel = {
    idle: '无活动任务', running: 'Agent 运行中', paused: '已暂停', waiting_for_human: '等待用户',
    revoked: '授权已撤销', expired: '授权已过期',
  }[runtime.state];
  const downloadDiagnostics = () => run(async () => {
    const bundle = await request('diagnostics.export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `yakit-browser-agent-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, '脱敏诊断包已导出');

  return <div className="section-view activity-view">
    <div className="page-heading"><div><h1>Agent 操作时间线</h1><p>实时动作保存在浏览器 session；长期审计只保存脱敏摘要，不记录参数、页面内容、Cookie 或执行结果。</p></div><div className="activity-heading-actions"><span className={`agent-runtime-state ${runtime.state}`}><Activity size={15} />{runtimeLabel}</span><Button variant="ghost" disabled={busy} onClick={() => void downloadDiagnostics()}><Download size={15} />导出诊断</Button></div></div>
    <section className="agent-runtime-band">
      <div className="agent-runtime-summary"><div><span>浏览器实例</span><strong>{runtime.taskId ? '已接入 Agent' : '等待调用'}</strong><small>{runtime.grantId ? '配对级访问' : '尚无能力调用'}</small></div><div><span>最近更新</span><strong>{new Date(runtime.updatedAt).toLocaleTimeString()}</strong><small>{runtime.actions.length} 条 session 动作</small></div><div className="agent-runtime-controls">{runtime.state === 'running' || runtime.state === 'waiting_for_human' ? <Button disabled={busy} onClick={() => void run(async () => setRuntime(await request('agent.pause')), 'Agent 已暂停')}><Square size={15} />暂停</Button> : runtime.state === 'paused' ? <Button variant="primary" disabled={busy} onClick={() => void run(async () => setRuntime(await request('agent.resume')), 'Agent 已恢复')}><Play size={15} />恢复</Button> : null}<Button variant="ghost" disabled={busy || runtime.actions.length === 0} onClick={() => void run(async () => setRuntime(await request('agent.actions.clear')), 'Session 时间线已清空')}><Trash2 size={15} />清空</Button></div></div>
      {runtime.actions.length === 0 ? <div className="agent-actions-empty">当前 session 尚无 Agent 能力调用。</div> : <div className="agent-action-list" role="list">{[...runtime.actions].reverse().slice(0, 50).map((action) => <div key={action.id} className="agent-action-row" role="listitem"><span className={`action-state ${action.state}`} /> <time>{new Date(action.startedAt).toLocaleTimeString()}</time><code title={action.method}>{action.method}</code><span>{action.targetTabId ? `Tab ${action.targetTabId}` : '扩展本机'}</span><strong className={action.state}>{action.state}</strong><span>{action.durationMs === undefined ? '进行中' : `${action.durationMs} ms`}</span></div>)}</div>}
    </section>
    <div className="activity-subheading"><div><h2>持久化脱敏审计</h2><p>最近 500 条授权、Bridge、接管与能力结果。</p></div><Button variant="ghost" disabled={busy || events.length === 0} onClick={() => void run(async () => { await request('audit.clear'); setEvents([]); }, '操作记录已清空')}><Trash2 size={15} />清空审计</Button></div>
    {loading ? <div className="activity-loading"><RefreshCw className="spin" size={16} />正在读取记录</div> : loadError ? <div className="activity-loading error"><AlertTriangle size={16} />{loadError}<Button size="sm" variant="ghost" onClick={() => void loadEvents()}>重试</Button></div> : events.length === 0 ? <Empty>还没有操作记录。</Empty> : <div className="activity-table" role="table" aria-label="扩展操作记录">
      <div className="activity-table__head" role="row"><span>时间</span><span>类型</span><span>动作</span><span>目标 / 摘要</span><span>结果</span><span>耗时</span></div>
      {events.map((event) => <div className="activity-table__row" role="row" key={event.id}>
        <time dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString()}</time>
        <span>{AUDIT_CATEGORY_LABELS[event.category]}</span>
        <code title={event.action}>{event.action}</code>
        <span title={event.summary}>{event.summary || (event.targetTabId ? `标签页 ${event.targetTabId}` : event.taskId ? `任务 ${event.taskId}` : '扩展本机')}</span>
        <span className={`audit-outcome ${event.outcome}`} title={event.errorCode}>{AUDIT_OUTCOME_LABELS[event.outcome]}</span>
        <span>{event.durationMs === undefined ? '—' : `${event.durationMs} ms`}</span>
      </div>)}
    </div>}
  </div>;
}

function Overview({ state, bridge, tab, navigate, run, busy }: { state: ExtensionState; bridge: BridgeStatus; tab?: ActiveTabInfo; navigate: (value: Section) => void; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const activeProxy = state.proxyProfiles.find((profile) => profile.id === state.activeProxyId)?.name || (state.activeProxyId === 'auto' ? '自动切换' : '未知');
  const [runtime, setRuntime] = useState<AgentRuntime>({ state: 'idle', updatedAt: Date.now(), actions: [] });
  const [network, setNetwork] = useState<NetworkCaptureStatus>();
  const [loginContext, setLoginContext] = useState<PageContext>();
  useEffect(() => {
    void request('agent.runtime.get').then(setRuntime).catch(() => undefined);
    if (tab) void request('network.capture.status', { tabId: tab.id }).then(setNetwork).catch(() => setNetwork(undefined));
    const listener = (changes: Record<string, unknown>) => {
      if (AGENT_RUNTIME_STORAGE_KEY in changes) void request('agent.runtime.get').then(setRuntime).catch(() => undefined);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [tab?.id]);
  const site = tab?.url ? new URL(tab.url) : undefined;
  const latestAction = [...runtime.actions].reverse()[0];
  const captureLoginEnvironment = () => run(async () => {
    if (!tab) throw new Error('请先选择 HTTP(S) 标签页');
    setLoginContext(await request('context.capture', {
      tabId: tab.id, includeDom: true, includeStorage: true, includeCookies: true,
    }));
  }, '登录环境已采集');
  const startCapture = () => run(async () => {
    if (!tab) throw new Error('请先选择 HTTP(S) 标签页');
    setNetwork(await request('network.capture.start', { tabId: tab.id, captureHeaders: false, captureBody: false }));
    navigate('network');
  }, '网络元数据捕获已启动');
  return <div className="section-view overview-view">
    <div className="page-heading"><div><h1>运行概览</h1><p>{tab?.title || '选择一个 HTTP(S) 标签页，建立浏览器现场。'}</p></div><span className={`large-status ${bridge.state}`}><Radio size={16} />{bridge.state === 'connected' ? `Yak ${bridge.engineVersion || '引擎'} 在线` : 'Yak 引擎离线'}</span></div>
    <div className="task-command-bar">
      <div className="task-site-identity"><KeyRound size={18} /><span><strong>{loginContext?.authentication.status === 'authenticated' ? '检测到登录环境' : loginContext?.authentication.status === 'unauthenticated' ? '未检测到登录态' : '登录环境待采集'}</strong><small>{site ? `${site.protocol.replace(':', '').toUpperCase()} · ${site.origin}` : '当前页面不可访问'}</small></span></div>
      <div className="task-quick-actions"><Button disabled={busy || !tab} onClick={() => void captureLoginEnvironment()}><Braces size={15} />采集登录环境</Button><Button disabled={busy || !tab || network?.active} onClick={() => void startCapture()}><Activity size={15} />{network?.active ? '正在捕获' : '抓取请求'}</Button><Button variant="primary" onClick={() => navigate('engine')}><Bot size={15} />管理 Agent 连接</Button></div>
    </div>
    <div className="task-status-grid">
      <section><span>浏览器现场</span><strong>{loginContext ? `${loginContext.document?.forms.length || 0} 表单 / ${loginContext.document?.interactive.length || 0} 节点` : '尚未采集'}</strong><small>{loginContext?.authentication.evidence[0] || 'Cookie、Storage 与认证信号仅在用户点击后读取'}</small><button onClick={() => navigate('context')}>打开上下文<ChevronRight size={15} /></button></section>
      <section><span>代理与流量</span><strong>{activeProxy}</strong><small>{network?.active ? `${network.count} 条请求，${network.droppedCount} 条丢弃` : `${state.proxyRules.filter((rule) => rule.enabled).length} 条手动规则 · ${state.proxyRuleSources.filter((source) => source.enabled).length} 个订阅源`}</small><button onClick={() => navigate(network?.active ? 'network' : 'rules')}>查看流量策略<ChevronRight size={15} /></button></section>
      <section><span>Agent 连接</span><strong>{bridge.state === 'connected' ? `实例在线 · ${runtime.state}` : '实例离线'}</strong><small>{bridge.state === 'connected' ? '当前浏览器内的 HTTP(S) 页面可直接被引用' : '配对并连接 Yakit 后即可使用，无需逐页授权'}</small><button onClick={() => navigate('activity')}>查看动作时间线<ChevronRight size={15} /></button></section>
      <section className={state.handoff?.state === 'waiting_for_user' ? 'needs-attention' : ''}><span>需要用户处理</span><strong>{state.handoff?.state === 'waiting_for_user' ? HANDOFF_REASON_LABELS[state.handoff.reason] : runtime.state === 'paused' ? 'Agent 已暂停' : '没有待办步骤'}</strong><small>{state.handoff?.state === 'waiting_for_user' ? state.handoff.message : latestAction ? `最近 ${latestAction.method} · ${latestAction.state}` : '二维码、MFA 与 CAPTCHA 会在这里出现'}</small><button onClick={() => navigate('activity')}>会话控制<ChevronRight size={15} /></button></section>
    </div>
    <div className="task-workflow-list">
      <button onClick={() => navigate('cookies')}><Cookie size={18} /><span><strong>检查 Cookie 与登录线索</strong><small>直接检查原始值，导出默认脱敏。</small></span><ChevronRight size={16} /></button>
      <button onClick={() => navigate('network')}><Send size={18} /><span><strong>请求转到 Yakit</strong><small>选择捕获记录后打开 Web Fuzzer、生成 Yak PoC 或准备 AI 分析。</small></span><ChevronRight size={16} /></button>
      <button onClick={() => navigate('context')}><Braces size={18} /><span><strong>观测签名与加解密</strong><small>短时观测 WebCrypto、CryptoJS、JSEncrypt、WebSocket 和请求调用栈。</small></span><ChevronRight size={16} /></button>
    </div>
  </div>;
}


function CookieEditor({ tab, run, busy }: { tab?: ActiveTabInfo; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const [url, setUrl] = useState(tab?.url || '');
  const [cookies, setCookies] = useState<BrowserCookie[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'session' | 'persistent' | 'httpOnly' | 'partitioned'>('all');
  const [sort, setSort] = useState<'name' | 'domain' | 'expires' | 'size'>('name');
  const [group, setGroup] = useState<'none' | 'domain' | 'path'>('domain');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transferFormat, setTransferFormat] = useState<CookieTransferFormat>('json');
  const [includeExportValues, setIncludeExportValues] = useState(false);
  const [importText, setImportText] = useState('');
  const [transferStatus, setTransferStatus] = useState('');
  const [draft, setDraft] = useState<Omit<CookieInput, 'url'>>({
    name: '', value: '', path: '/', secure: url.startsWith('https:'), httpOnly: false, sameSite: 'unspecified',
  });
  const keyOf = cookieKey;
  const reload = () => run(async () => {
    if (!tab?.id) throw new Error('请选择目标标签页');
    setCookies(await request('cookie.list', { url, tabId: tab.id }));
    setSelected(new Set());
  });
  const editCookie = (cookie: BrowserCookie) => {
    setDraft({
      name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? undefined : cookie.domain,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite as CookieInput['sameSite'], expirationDate: cookie.expirationDate,
      storeId: cookie.storeId, firstPartyDomain: cookie.firstPartyDomain, partitionKey: cookie.partitionKey,
    });
  };
  const visibleCookies = cookies.filter((cookie) => {
    const needle = query.trim().toLowerCase();
    const queryMatch = !needle || [cookie.name, cookie.domain, cookie.path].some((value) => value.toLowerCase().includes(needle));
    const filterMatch = filter === 'all' || (filter === 'session' && cookie.session) || (filter === 'persistent' && !cookie.session)
      || (filter === 'httpOnly' && cookie.httpOnly) || (filter === 'partitioned' && Boolean(cookie.partitionKey));
    return queryMatch && filterMatch;
  }).sort((left, right) => {
    if (sort === 'domain') return `${left.domain}${left.path}${left.name}`.localeCompare(`${right.domain}${right.path}${right.name}`);
    if (sort === 'expires') return (left.expirationDate || Number.MAX_SAFE_INTEGER) - (right.expirationDate || Number.MAX_SAFE_INTEGER);
    if (sort === 'size') return right.value.length - left.value.length;
    return left.name.localeCompare(right.name);
  });
  const groupedCookies = new Map<string, BrowserCookie[]>();
  for (const cookie of visibleCookies) {
    const key = group === 'domain' ? cookie.domain : group === 'path' ? cookie.path : '全部 Cookie';
    groupedCookies.set(key, [...(groupedCookies.get(key) || []), cookie]);
  }
  const removeInputs = (items: BrowserCookie[]) => items.map(cookieRemovalInput);
  const downloadExport = async () => {
    if (!tab?.id) throw new Error('请选择目标标签页');
    const text = await request('cookie.export', {
      url,
      tabId: tab.id,
      format: transferFormat,
      includeValues: includeExportValues,
    });
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `cookies-${new URL(url).hostname}.${transferFormat === 'json' ? 'json' : 'txt'}`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  };
  useEffect(() => { if (url.startsWith('http')) void reload(); }, []);
  return <div className="section-view">
    <div className="page-heading"><div><h1>Cookie Editor</h1><p>HttpOnly、Cookie Store、CHIPS 分区与多格式交换。</p></div><button disabled={busy || !url} onClick={() => void reload()}><RefreshCw size={16} />刷新</button></div>
    <div className="url-bar"><input value={url} onChange={(event) => setUrl(event.target.value)} /><span>{cookies.length} cookies</span></div>
    <div className="cookie-toolbar"><div className="network-search"><Search size={14} /><input aria-label="搜索 Cookie" placeholder="搜索名称、Domain 或 Path" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select aria-label="Cookie 筛选" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部</option><option value="session">Session</option><option value="persistent">持久</option><option value="httpOnly">HttpOnly</option><option value="partitioned">Partitioned</option></select><select aria-label="Cookie 排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="name">按名称</option><option value="domain">按 Domain</option><option value="expires">按过期时间</option><option value="size">按值大小</option></select><select aria-label="Cookie 分组" value={group} onChange={(event) => setGroup(event.target.value as typeof group)}><option value="domain">Domain 分组</option><option value="path">Path 分组</option><option value="none">不分组</option></select><Button variant="danger" disabled={busy || selected.size === 0} onClick={() => void run(async () => { if (!tab?.id) throw new Error('请选择目标标签页'); const result = await request('cookie.removeMany', { cookies: removeInputs(cookies.filter((cookie) => selected.has(keyOf(cookie)))) }); setTransferStatus(`删除 ${result.removed}，失败 ${result.failed}`); setCookies(await request('cookie.list', { url, tabId: tab.id })); setSelected(new Set()); }, '已执行批量删除')}><Trash2 size={14} />删除 {selected.size || ''}</Button></div>
    <div className="cookie-layout"><div className="cookie-table"><div className="table-head cookie-columns"><input aria-label="选择全部可见 Cookie" type="checkbox" checked={visibleCookies.length > 0 && visibleCookies.every((cookie) => selected.has(keyOf(cookie)))} onChange={(event) => setSelected(event.target.checked ? new Set(visibleCookies.map(keyOf)) : new Set())} /><span>名称</span><span>值</span><span>Domain / Path</span><span>属性</span><span /></div>{visibleCookies.length === 0 ? <Empty>没有符合条件的 Cookie。</Empty> : [...groupedCookies].map(([groupName, items]) => <div className="cookie-group" key={groupName}><div className="cookie-group__heading"><strong>{groupName}</strong><span>{items.length}</span></div>{items.map((cookie) => {
        const cookieKey = keyOf(cookie);
        return <div className="table-row cookie-columns" key={cookieKey}><input aria-label={`选择 ${cookie.name}`} type="checkbox" checked={selected.has(cookieKey)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(cookieKey); else next.delete(cookieKey); return next; })} /><button className="cookie-name-button" title="编辑 Cookie" onClick={() => editCookie(cookie)}><strong>{cookie.name}</strong></button><code className="cookie-value" title={cookie.value}>{cookie.value}</code><span><small>{cookie.domain}</small><small>{cookie.path}</small></span><span className="tag-list">{cookie.httpOnly && <i>HttpOnly</i>}{cookie.secure && <i>Secure</i>}{cookie.partitionKey && <i>Partitioned</i>}{cookie.sameSite && <i>{cookie.sameSite}</i>}{cookie.priority && <i>{cookie.priority}</i>}{cookie.sameParty && <i>SameParty</i>}</span><button className="icon-button danger" title="删除 Cookie" onClick={() => void run(async () => { if (!tab?.id) throw new Error('请选择目标标签页'); await request('cookie.remove', removeInputs([cookie])[0]); setCookies(await request('cookie.list', { url, tabId: tab.id })); }, 'Cookie 已删除')}><Trash2 size={15} /></button></div>;
      })}</div>)}</div>
      <div className="rule-editor cookie-editor-pane"><h2>写入 Cookie</h2><Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field><Field label="值"><textarea rows={4} value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} /></Field><Field label="Domain" hint="留空创建 HostOnly Cookie"><input value={draft.domain || ''} onChange={(event) => setDraft({ ...draft, domain: event.target.value || undefined })} /></Field><Field label="Path"><input value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></Field><Field label="过期时间"><input type="datetime-local" value={draft.expirationDate ? new Date(draft.expirationDate * 1_000).toISOString().slice(0, 16) : ''} onChange={(event) => setDraft({ ...draft, expirationDate: event.target.value ? new Date(event.target.value).getTime() / 1_000 : undefined })} /></Field><Field label="SameSite"><select value={draft.sameSite} onChange={(event) => setDraft({ ...draft, sameSite: event.target.value as CookieInput['sameSite'] })}><option value="unspecified">Unspecified</option><option value="lax">Lax</option><option value="strict">Strict</option><option value="no_restriction">None</option></select></Field><Field label="Partition top-level site"><input placeholder="https://top.example" value={draft.partitionKey?.topLevelSite || ''} onChange={(event) => setDraft({ ...draft, partitionKey: event.target.value ? { ...draft.partitionKey, topLevelSite: event.target.value } : undefined })} /></Field><label className="check-row"><input type="checkbox" checked={draft.secure} onChange={(event) => setDraft({ ...draft, secure: event.target.checked })} />Secure</label><label className="check-row"><input type="checkbox" checked={draft.httpOnly} onChange={(event) => setDraft({ ...draft, httpOnly: event.target.checked })} />HttpOnly</label><label className="check-row"><input type="checkbox" disabled={!draft.partitionKey} checked={draft.partitionKey?.hasCrossSiteAncestor || false} onChange={(event) => setDraft({ ...draft, partitionKey: { ...draft.partitionKey, hasCrossSiteAncestor: event.target.checked } })} />Cross-site ancestor</label><button className="primary-button" disabled={busy || !url || !draft.name || !tab?.id} onClick={() => void run(async () => { if (!tab?.id) throw new Error('请选择目标标签页'); await request('cookie.set', { url, tabId: tab.id, ...draft }); setCookies(await request('cookie.list', { url, tabId: tab.id })); }, 'Cookie 已写入')}><Save size={16} />保存 Cookie</button><div className="cookie-transfer"><h2>导入 / 导出</h2><div><select value={transferFormat} onChange={(event) => setTransferFormat(event.target.value as CookieTransferFormat)}><option value="json">JSON</option><option value="netscape">Netscape</option><option value="set-cookie">Set-Cookie</option></select><label className="check-row"><input type="checkbox" checked={includeExportValues} onChange={(event) => setIncludeExportValues(event.target.checked)} />导出原始值</label></div><textarea rows={6} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴 Cookie 数据" /><div className="editor-actions"><Button variant="primary" disabled={busy || !importText.trim() || !tab?.id} onClick={() => void run(async () => { if (!tab?.id) throw new Error('请选择目标标签页'); const result = await request('cookie.import', { url, tabId: tab.id, format: transferFormat, text: importText }); setTransferStatus(`导入 ${result.imported}，失败 ${result.failed}${result.warnings.length ? `；${result.warnings.join('；')}` : ''}`); setCookies(await request('cookie.list', { url, tabId: tab.id })); }, 'Cookie 导入完成')}><Upload size={14} />导入</Button><Button variant="ghost" disabled={busy || cookies.length === 0} onClick={() => void run(downloadExport, includeExportValues ? 'Cookie 已导出（包含值）' : 'Cookie 已脱敏导出')}><Download size={14} />导出</Button></div>{transferStatus && <p className="transfer-status">{transferStatus}</p>}</div></div>
    </div>
  </div>;
}

function UserAgents({ state, setState, tab, run, busy }: { state: ExtensionState; setState: (state: ExtensionState) => void; tab?: ActiveTabInfo; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const [profiles, setProfiles] = useState<UserAgentProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('chrome-windows');
  const [draft, setDraft] = useState<UserAgentProfileInput>({ name: '', userAgent: '' });
  const url = tab?.url?.startsWith('http') ? tab.url : '';
  let hostname = '';
  try { hostname = url ? new URL(url).hostname : ''; } catch { hostname = ''; }
  const currentAssignment = state.userAgentAssignments.find((assignment) => assignment.hostname === hostname);
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const selectedProfile = profileMap.get(selectedProfileId);
  const effectiveProfile = currentAssignment ? profileMap.get(currentAssignment.profileId) : undefined;

  const loadProfiles = useCallback(async () => {
    const next = await request('ua.catalog');
    setProfiles(next);
    const current = state.userAgentAssignments.find((assignment) => assignment.hostname === hostname);
    if (current && next.some((profile) => profile.id === current.profileId)) setSelectedProfileId(current.profileId);
  }, [hostname, state.userAgentAssignments]);
  useEffect(() => { void loadProfiles(); }, [loadProfiles, state.customUserAgentProfiles]);

  const applyAndReload = () => run(async () => {
    if (!tab || !url || !selectedProfile) throw new Error('请选择可访问的目标页面和 User-Agent 预设');
    setState(await request('ua.site.apply', { url, profileId: selectedProfile.id }));
    await browser.tabs.reload(tab.id);
  }, `${selectedProfile?.name || 'User-Agent'} 已应用并刷新页面`);
  const resetAndReload = () => run(async () => {
    if (!tab || !url) throw new Error('请选择可访问的目标页面');
    setState(await request('ua.site.reset', { url }));
    await browser.tabs.reload(tab.id);
  }, '已恢复浏览器默认 User-Agent 并刷新页面');
  const saveProfile = () => run(async () => {
    const saved = await request('ua.profile.save', draft);
    const next = await request('ua.catalog');
    setProfiles(next);
    setSelectedProfileId(saved.id);
    setDraft({ name: '', userAgent: '' });
  }, '自定义 User-Agent 预设已保存');

  return <div className="section-view ua-view">
    <div className="page-heading"><div><span className="page-eyebrow">常用工具</span><h1>User-Agent 快速切换</h1><p>为单个 hostname 修改真实网络请求头；不伪装 Navigator、Client Hints、屏幕或 TLS 指纹。</p></div></div>
    <section className="ua-current-site">
      <div><span>当前目标</span><strong>{hostname || '当前标签页不可配置'}</strong><small>{effectiveProfile ? `正在使用 ${effectiveProfile.name}` : '使用浏览器默认 User-Agent'}</small></div>
      <select aria-label="当前站点 User-Agent" disabled={!hostname || busy} value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.builtin ? '' : ' · 自定义'}</option>)}</select>
      <div className="editor-actions"><Button variant="ghost" disabled={!currentAssignment || busy} onClick={() => void resetAndReload()}>恢复默认</Button><Button variant="primary" disabled={!hostname || !selectedProfile || busy} onClick={() => void applyAndReload()}><RefreshCw size={14} />应用并刷新</Button></div>
    </section>
    <div className="ua-management">
      <section className="ua-assignments"><div className="context-section-heading"><div><h2>站点绑定</h2><span>每个 hostname 只保留一个生效预设</span></div></div>{state.userAgentAssignments.length === 0 ? <Empty>还没有站点 User-Agent 绑定。</Empty> : <div className="ua-assignment-list">{[...state.userAgentAssignments].sort((left, right) => left.hostname.localeCompare(right.hostname)).map((assignment) => { const profile = profileMap.get(assignment.profileId); return <div key={assignment.id}><span><strong>{assignment.hostname}</strong><small>{profile?.name || '预设已删除'}</small></span><code title={profile?.userAgent}>{profile?.userAgent || assignment.profileId}</code><Button size="icon" variant="ghost" title="恢复该站点默认 UA" aria-label={`移除 ${assignment.hostname} 的 UA 绑定`} onClick={() => void run(async () => setState(await request('ua.site.reset', { url: `https://${assignment.hostname}/` })), '站点 UA 绑定已移除')}><Trash2 size={14} /></Button></div>; })}</div>}
      </section>
      <aside className="ua-profile-editor"><div className="context-section-heading"><div><h2>{draft.id ? '编辑自定义预设' : '自定义预设'}</h2><span>保存后可在 Popup 和当前站点中复用</span></div></div><Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 API Client" /></Field><Field label="User-Agent"><textarea rows={5} value={draft.userAgent} onChange={(event) => setDraft({ ...draft, userAgent: event.target.value })} placeholder="Custom-Agent/1.0" /></Field><div className="editor-actions">{draft.id && <Button variant="ghost" onClick={() => setDraft({ name: '', userAgent: '' })}>取消编辑</Button>}<Button variant="primary" disabled={busy || !draft.name.trim() || !draft.userAgent.trim()} onClick={() => void saveProfile()}><Save size={14} />保存预设</Button></div><div className="custom-ua-list">{profiles.filter((profile) => !profile.builtin).map((profile) => <div key={profile.id}><button onClick={() => setDraft({ id: profile.id, name: profile.name, userAgent: profile.userAgent })}><strong>{profile.name}</strong><small>{profile.userAgent}</small></button><Button size="icon" variant="ghost" title="删除自定义预设" aria-label={`删除 ${profile.name}`} onClick={() => void run(async () => { setState(await request('ua.profile.delete', { id: profile.id })); await loadProfiles(); }, '自定义 UA 预设已删除')}><Trash2 size={14} /></Button></div>)}</div></aside>
    </div>
  </div>;
}

function networkLabel(record: NetworkRequestRecord): { host: string; path: string } {
  try {
    const parsed = new URL(record.url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: record.url, path: '' };
  }
}

function NetworkActivity({
  tab,
  bridge,
  run,
  busy,
}: {
  tab?: ActiveTabInfo;
  bridge: BridgeStatus;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
  busy: boolean;
}) {
  const [status, setStatus] = useState<NetworkCaptureStatus>();
  const [records, setRecords] = useState<NetworkRequestRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [exported, setExported] = useState<NetworkRequestExport>();
  const [previewError, setPreviewError] = useState('');
  const [generatedPoc, setGeneratedPoc] = useState<YakPocGenerateResult>();
  const [analysisBundle, setAnalysisBundle] = useState<BrowserRequestAnalysisBundle>();
  const [loadError, setLoadError] = useState('');
  const [captureHeaders, setCaptureHeaders] = useState(false);
  const [captureBody, setCaptureBody] = useState(false);
  const [query, setQuery] = useState('');
  const load = useCallback(async () => {
    if (!tab) return;
    try {
      setLoadError('');
      const nextStatus = await request('network.capture.status', { tabId: tab.id });
      setStatus(nextStatus);
      if (nextStatus.options) {
        setCaptureHeaders(nextStatus.options.captureHeaders);
        setCaptureBody(nextStatus.options.captureBody);
      }
      const nextRecords = nextStatus.active
        ? await request('network.capture.list', { ...nextStatus.target, limit: 200 })
        : [];
      setRecords(nextRecords);
      setSelectedId((current) => nextRecords.some((record) => record.id === current) ? current : nextRecords[0]?.id || '');
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [tab]);

  useEffect(() => {
    void load();
    const listener = (message: unknown) => {
      const input = message as { action?: string; payload?: { tabId?: number } };
      if (input?.action === 'network.capture.changed' && input.payload?.tabId === tab?.id) void load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [load, tab?.id]);

  const selected = records.find((record) => record.id === selectedId);
  useEffect(() => {
    setExported(undefined);
    setPreviewError('');
    setGeneratedPoc(undefined);
    setAnalysisBundle(undefined);
    if (!selected || !status?.active || !selected.requestHeadersCaptured) return;
    void request('network.capture.export', { ...status.target, id: selected.id })
      .then(setExported)
      .catch((error) => setPreviewError(errorMessage(error)));
  }, [selected, status]);

  const visibleRecords = records.filter((record) => {
    const needle = query.trim().toLowerCase();
    return !needle || record.url.toLowerCase().includes(needle) || record.method.toLowerCase().includes(needle)
      || String(record.statusCode || '').includes(needle);
  });
  const canSendToYakit = bridge.state === 'connected' && Boolean(bridge.capabilities?.includes('yakit.web_fuzzer.open'));
  const canGeneratePoc = bridge.state === 'connected' && Boolean(bridge.capabilities?.includes('yakit.poc.generate'));
  const canPrepareAnalysis = bridge.state === 'connected' && Boolean(bridge.capabilities?.includes('yakit.browser_request.prepare_analysis'));
  const captureTarget = status?.active ? status.target : tab ? { tabId: tab.id } : undefined;
  const persistenceHint = status?.persistence === 'degraded'
    ? `会话存储失败，当前记录仅保留在内存中${status.persistenceError ? `：${status.persistenceError}` : ''}`
    : status?.persistence === 'memory-only'
      ? '当前浏览器不提供会话存储，记录仅保留在内存中'
      : status?.persistence === 'pending'
        ? '最新记录正在写入浏览器会话存储'
        : status?.persistence === 'persisted' ? '记录已写入浏览器会话存储' : undefined;
  const persistenceSuffix = status?.persistence === 'degraded' || status?.persistence === 'memory-only' ? ' · 仅内存' : '';

  const start = () => run(async () => {
    if (!tab) throw new Error('请选择目标标签页');
    const next = await request('network.capture.start', {
      tabId: tab.id, captureHeaders, captureBody, maxEntries: 100, maxBodyBytes: 32 * 1024,
    });
    setStatus(next);
    setRecords([]);
    setSelectedId('');
  }, captureHeaders || captureBody ? '网络捕获已开始，敏感字段仅保存在本次浏览器会话' : '网络元数据捕获已开始');

  return <div className="section-view network-view">
    <div className="page-heading"><div><h1>网络活动</h1><p>HTTP 请求、表单导航、实时通信与前端加密调用。</p></div><div className="network-heading-actions">
      <span className={`capture-state ${status?.active ? 'active' : ''}`} title={persistenceHint}><i />{status?.active ? `${status.count} 条请求${persistenceSuffix}` : '未捕获'}</span>
      {status?.active ? <Button variant="ghost" disabled={busy || !captureTarget} onClick={() => void run(async () => { setStatus(await request('network.capture.stop', captureTarget!)); setRecords([]); setSelectedId(''); }, '网络捕获已停止')}><Square size={14} />停止</Button> : <Button variant="primary" disabled={busy || !tab?.url?.startsWith('http')} onClick={() => void start()}><Play size={14} />开始捕获</Button>}
    </div></div>

    <div className="network-control-bar">
      <label><Switch checked={captureHeaders} disabled={status?.active || busy} onCheckedChange={setCaptureHeaders} /><span><strong>请求头与 Cookie</strong><small>生成可重放请求所必需</small></span></label>
      <label><Switch checked={captureBody} disabled={status?.active || busy} onCheckedChange={setCaptureBody} /><span><strong>请求体</strong><small>每条最多保留 32 KiB</small></span></label>
      <div className="network-search"><Search size={14} /><input aria-label="筛选网络请求" placeholder="筛选 URL、方法或状态码" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <Button size="icon" variant="ghost" title="刷新网络记录" aria-label="刷新网络记录" onClick={() => void load()}><RefreshCw size={15} /></Button>
      <Button size="icon" variant="ghost" title="清空网络记录" aria-label="清空网络记录" disabled={!status?.active || records.length === 0 || busy} onClick={() => void run(async () => { const next = await request('network.capture.clear', status!.target); setStatus(next); setRecords([]); setSelectedId(''); }, '网络记录已清空')}><Trash2 size={15} /></Button>
    </div>

    {loadError ? <div className="network-error"><AlertTriangle size={15} />{loadError}<Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button></div> : <div className="network-layout">
      <div className="network-timeline">
        <div className="network-table-head"><span>方法</span><span>状态</span><span>目标</span><span>类型</span><span>耗时</span></div>
        {visibleRecords.length === 0 ? <Empty>{status?.active ? '等待目标页面发出 Fetch/XHR 请求。' : '开始捕获后，网络请求会显示在这里。'}</Empty> : visibleRecords.map((record) => {
          const label = networkLabel(record);
          return <button className={`network-row ${selectedId === record.id ? 'selected' : ''}`} key={record.id} onClick={() => setSelectedId(record.id)}>
            <strong className={`method method-${record.method.toLowerCase()}`}>{record.method}</strong>
            <span className={record.error || (record.statusCode || 0) >= 400 ? 'status-error' : 'status-good'}>{record.error ? 'ERR' : record.statusCode || '...'}</span>
            <span className="network-target"><strong>{label.path || '/'}</strong><small>{label.host}</small></span>
            <span>{record.resourceType}</span>
            <span>{record.durationMs === undefined ? '—' : `${record.durationMs} ms`}</span>
          </button>;
        })}
      </div>

      <aside className="network-inspector">
        {!selected ? <Empty>选择一条请求查看详情。</Empty> : <>
          <div className="network-inspector__heading"><div><span>{selected.method}</span><strong>{networkLabel(selected).path || '/'}</strong><small title={selected.url}>{selected.url}</small></div><span className={selected.error || (selected.statusCode || 0) >= 400 ? 'status-error' : 'status-good'}>{selected.error || selected.statusLine || selected.statusCode || 'Pending'}</span></div>
          <dl className="network-meta"><div><dt>来源</dt><dd>{selected.resourceType}</dd></div><div><dt>文档</dt><dd>{selected.documentId ? selected.documentId.slice(0, 12) : `frame ${selected.frameId}`}</dd></div><div><dt>大小</dt><dd>{selected.responseSize === undefined ? '未知' : `${selected.responseSize} B`}</dd></div><div><dt>耗时</dt><dd>{selected.durationMs === undefined ? '进行中' : `${selected.durationMs} ms`}</dd></div></dl>
          <div className="network-packet-heading"><strong>原始请求</strong><div><Button size="icon" variant="ghost" title="复制原始请求" aria-label="复制原始请求" disabled={!exported} onClick={() => void run(async () => { await navigator.clipboard.writeText(exported!.rawRequest); }, '原始请求已复制')}><Copy size={14} /></Button><Button size="sm" variant="ghost" disabled={!exported || !canGeneratePoc || busy} title={!canGeneratePoc ? '当前 Yak 引擎不支持 PoC 生成' : undefined} onClick={() => void run(async () => { setGeneratedPoc(await request('network.capture.poc', { ...status!.target, id: selected.id })); }, 'Yak PoC 已生成')}><Braces size={14} />PoC</Button><Button size="sm" variant="ghost" disabled={!exported || !canPrepareAnalysis || busy} title={!canPrepareAnalysis ? '当前 Yak 引擎不支持分析上下文' : undefined} onClick={() => void run(async () => { setAnalysisBundle(await request('network.capture.analysis', { ...status!.target, id: selected.id })); }, 'AI 分析上下文已生成')}><Bot size={14} />分析</Button><Button size="sm" variant="primary" disabled={!exported || !canSendToYakit || busy} title={!canSendToYakit ? '连接支持 Web Fuzzer 的 Yak 引擎后可用' : undefined} onClick={() => void run(async () => { await request('network.capture.send', { ...status!.target, id: selected.id }); }, '已在 Yakit 中打开 Web Fuzzer')}><Send size={14} />Yakit</Button></div></div>
          {exported ? <><pre className="network-packet">{exported.rawRequest}</pre>{exported.limitations.length > 0 && <div className="network-limitations"><AlertTriangle size={14} />{exported.limitations.join('；')}</div>}</> : <div className="network-preview-empty"><ShieldCheck size={16} /><span>{previewError || '该请求只保存了元数据。重新开始捕获并启用“请求头与 Cookie”后可生成重放包。'}</span></div>}
          {generatedPoc && <div className="network-artifact"><div><strong>{generatedPoc.fileName}</strong><Button size="icon" variant="ghost" title="复制 Yak PoC" aria-label="复制 Yak PoC" onClick={() => void run(async () => navigator.clipboard.writeText(generatedPoc.code), 'Yak PoC 已复制')}><Copy size={14} /></Button></div><pre>{generatedPoc.code}</pre></div>}
          {analysisBundle && <div className="network-artifact analysis"><div><strong>AI 分析上下文</strong><Button size="icon" variant="ghost" title="复制 AI 分析上下文" aria-label="复制 AI 分析上下文" onClick={() => void run(async () => navigator.clipboard.writeText(JSON.stringify(analysisBundle, null, 2)), 'AI 分析上下文已复制')}><Copy size={14} /></Button></div><pre>{JSON.stringify(analysisBundle, null, 2)}</pre></div>}
        </>}
      </aside>
    </div>}

  </div>;
}

function GatewayWorkspace({
  tab,
  bridge,
  run,
  busy,
}: {
  tab?: ActiveTabInfo;
  bridge: BridgeStatus;
  run: (task: () => Promise<void>, success?: string) => Promise<void>;
  busy: boolean;
}) {
  const shareTransform = async () => {
    if (!tab) throw new Error('请先选择需要使用的页面');
    if (bridge.state !== 'connected') await request('bridge.connect');
  };

  return <div className="section-view gateway-view">
    <RecordingWorkspace
      tab={tab}
      busy={busy}
      run={run}
      gatewayShared={bridge.state === 'connected'}
      onShareGateway={shareTransform}
      initialMode="gateway"
    />
  </div>;
}

function ContextTool({ tab, run, busy }: { tab?: ActiveTabInfo; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const [context, setContext] = useState<PageContext>();
  const [frames, setFrames] = useState<PageFrameSummary[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState(0);
  const [includeStorage, setIncludeStorage] = useState(false);
  const [includeCookies, setIncludeCookies] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [nodeDetails, setNodeDetails] = useState<PageNodeDetails>();
  const [nodeError, setNodeError] = useState('');
  const [nodeQuery, setNodeQuery] = useState('');
  const [nodeValue, setNodeValue] = useState('');
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('[]');
  const [result, setResult] = useState('');
  const [code, setCode] = useState(`({\n  title: document.title,\n  href: location.href,\n  appGlobals: Object.keys(window).filter((key) => /encrypt|sign|crypto/i.test(key)).slice(0, 20)\n})`);
  const [evalMode, setEvalMode] = useState<'expression' | 'program'>('expression');
  const [evalResult, setEvalResult] = useState<PageEvalResult>();

  useEffect(() => {
    if (!tab) return;
    void request('frame.list', { tabId: tab.id }).then((items) => {
      setFrames(items);
      if (!items.some((frame) => frame.frameId === selectedFrameId && frame.accessible)) setSelectedFrameId(0);
    }).catch(() => setFrames([]));
  }, [tab, selectedFrameId]);

  const capture = () => run(async () => {
    const selectedSemanticKey = context?.document.interactive.find((node) => node.nodeId === selectedNodeId)?.semanticKey;
    const next = await request('context.capture', { includeDom: true, includeStorage, includeCookies, tabId: tab?.id, frameId: selectedFrameId });
    setContext(next);
    setSelectedNodeId(next.document.interactive.find((node) => node.semanticKey === selectedSemanticKey)?.nodeId || next.document.interactive[0]?.nodeId || '');
    setNodeDetails(undefined);
    setNodeError('');
  }, context ? '页面上下文与变化已刷新' : '页面上下文已采集');

  useEffect(() => {
    setNodeDetails(undefined);
    setNodeError('');
    setNodeValue('');
    if (!context || !selectedNodeId) return;
    void request('context.node.inspect', { ...context.target, captureId: context.captureId, nodeId: selectedNodeId })
      .then(setNodeDetails)
      .catch((error) => setNodeError(errorMessage(error)));
  }, [context, selectedNodeId]);

  const selectedNode = context?.document.interactive.find((node) => node.nodeId === selectedNodeId);
  const visibleNodes = context?.document.interactive.filter((node) => {
    const needle = nodeQuery.trim().toLowerCase();
    return !needle || node.accessibleName.toLowerCase().includes(needle) || node.text.toLowerCase().includes(needle)
      || node.tag.toLowerCase().includes(needle) || node.role.toLowerCase().includes(needle) || node.nodeId.includes(needle);
  }) || [];
  const authLabel = context?.authentication.status === 'authenticated' ? '可能已登录'
    : context?.authentication.status === 'unauthenticated' ? '可能未登录' : '登录态未知';
  const diffLabel = context?.diff.kind === 'initial' ? '首次快照' : context?.diff.kind === 'unchanged' ? '没有变化'
    : context?.diff.kind === 'document_changed' ? '文档已变化' : '发现变化';
  const canSetValue = selectedNode && ['input', 'textarea', 'select'].includes(selectedNode.tag) && selectedNode.type !== 'file';
  const act = (action: 'click' | 'focus' | 'scroll' | 'setValue') => run(async () => {
    if (!context || !selectedNode) throw new Error('请选择页面元素');
    const response = await request('context.node.action', {
      ...context.target, captureId: context.captureId, nodeId: selectedNode.nodeId, action,
      ...(action === 'setValue' ? { value: nodeValue } : {}),
    });
    setNodeDetails(response.node);
  }, action === 'click' ? '已向页面元素发送点击' : action === 'setValue' ? '页面字段已写入' : '页面元素已定位');

  return <div className="section-view">
    <div className="page-heading"><div><h1>登录态工作区</h1><p>生成文档绑定的结构化快照，识别认证信号并跟踪页面变化。</p></div><Button variant="primary" disabled={busy || !tab?.url?.startsWith('http')} onClick={() => void capture()}><RefreshCw size={16} />{context ? '刷新并比较' : '采集页面'}</Button></div>
    <div className="context-options"><label className="check-row"><input type="checkbox" checked={includeStorage} onChange={(event) => setIncludeStorage(event.target.checked)} />读取 Storage 值与数据库清单</label><label className="check-row"><input type="checkbox" checked={includeCookies} onChange={(event) => setIncludeCookies(event.target.checked)} />读取 Cookie 值</label><select aria-label="目标 frame" value={selectedFrameId} onChange={(event) => { setSelectedFrameId(Number(event.target.value)); setContext(undefined); }}>{frames.filter((frame) => frame.accessible).map((frame) => <option key={frame.frameId} value={frame.frameId}>#{frame.frameId} · {frame.isTop ? '主 frame' : frame.sameOrigin ? '同源' : '跨源'} · {frame.title || frame.origin}</option>)}</select><span>{tab?.url || '当前标签页不可访问'}</span></div>
    <Tabs defaultValue="workspace" className="context-mode">
      <TabsList className={`context-mode-tabs ${FIREFOX_AMO_BUILD ? 'invoke-only' : ''}`}><TabsTrigger value="workspace">浏览器现场</TabsTrigger>{!FIREFOX_AMO_BUILD && <><TabsTrigger value="invoke">函数调用</TabsTrigger><TabsTrigger value="eval">主世界 Eval</TabsTrigger></>}<TabsTrigger value="json">原始 JSON</TabsTrigger></TabsList>
      <TabsContent value="workspace" className="context-workspace-tab">
        {!context ? <div className="context-empty"><KeyRound size={25} /><strong>尚未建立页面快照</strong><span>采集后显示登录态、上下文变化和可操作元素。</span></div> : <>
          <div className="context-session-strip">
            <div className={`auth-state ${context.authentication.status}`}><ShieldCheck size={17} /><span><small>认证判断</small><strong>{authLabel}</strong></span><i>{Math.round(context.authentication.confidence * 100)}%</i></div>
            <div><small>快照</small><strong>{context.captureId.slice(0, 8)}</strong><span>{new Date(context.capturedAt).toLocaleTimeString()}</span></div>
            <div><small>变化</small><strong>{diffLabel}</strong><span>{context.diff.changedSections.length ? context.diff.changedSections.map((section) => CONTEXT_SECTION_LABELS[section]).join(' / ') : '当前为比较基线'}</span></div>
            <div><small>文档</small><strong>{context.target.documentId?.slice(0, 12) || `frame ${context.target.frameId}`}</strong><span>{context.frames.length} 个 frame · {context.document.interactive.length} 个节点</span></div>
          </div>
          <div className="context-workspace">
            <div className="context-primary">
              <section className="context-diff"><div className="context-section-heading"><div><h2>上下文变化</h2><span>{context.diff.fromCaptureId ? `${context.diff.fromCaptureId.slice(0, 8)} → ${context.captureId.slice(0, 8)}` : '等待下一次快照'}</span></div><span className={`diff-state ${context.diff.kind}`}>{diffLabel}</span></div>
                <div className="diff-summary"><span><strong>+{context.diff.addedNodes.length}</strong>节点</span><span><strong>-{context.diff.removedNodes.length}</strong>节点</span><span><strong>+{context.diff.addedCookieNames.length}</strong>Cookie</span><span><strong>+{context.diff.addedStorageKeys.length}</strong>Storage</span></div>
                {(context.diff.addedNodes.length > 0 || context.diff.removedNodes.length > 0) && <div className="diff-events">{context.diff.addedNodes.slice(0, 4).map((node) => <span key={`add:${node.semanticKey}`}><i>+</i>{node.text || node.tag}</span>)}{context.diff.removedNodes.slice(0, 4).map((node) => <span key={`remove:${node.semanticKey}`} className="removed"><i>-</i>{node.text || node.tag}</span>)}</div>}
              </section>
              <section className="context-inventory"><div className="context-section-heading"><div><h2>页面现场清单</h2><span>frame、浏览器存储和当前文档生命周期</span></div></div><div className="context-inventory-grid">
                <div><strong>Frames</strong><span>{context.frames.length}</span><ul>{context.frames.slice(0, 12).map((frame) => <li key={frame.frameId}><i className={frame.accessible ? 'ready' : ''} /> <b>#{frame.frameId}</b><span>{frame.isTop ? '主 frame' : frame.sameOrigin ? '同源' : '跨源'}</span><small title={frame.url}>{frame.origin || frame.url}</small></li>)}</ul></div>
                <div><strong>IndexedDB / Cache</strong><span>{context.document.storageInventory ? context.document.storageInventory.indexedDB.databases.length + context.document.storageInventory.cacheStorage.names.length : 0}</span>{context.document.storageInventory ? <ul>{context.document.storageInventory.indexedDB.databases.slice(0, 6).map((database) => <li key={`db:${database.name}`}><Database size={11} /><b>{database.name}</b><span>{database.stores.length} stores</span></li>)}{context.document.storageInventory.cacheStorage.names.slice(0, 6).map((name) => <li key={`cache:${name}`}><Database size={11} /><b>{name}</b><span>Cache</span></li>)}</ul> : <p>启用 Storage 后采集数据库与 Cache 名称。</p>}</div>
                <div><strong>Lifecycle</strong><span>{context.lifecycle.length}</span><ul>{context.lifecycle.slice(-8).reverse().map((event) => <li key={event.id}><i className={event.kind} /><b>{event.kind}</b><span>frame #{event.frameId}</span><small>{new Date(event.timestamp).toLocaleTimeString()}</small></li>)}</ul>{context.lifecycle.length === 0 && <p>当前文档尚未记录 SPA 或导航变化。</p>}</div>
              </div></section>
              <section className="context-node-browser"><div className="context-section-heading"><div><h2>可操作元素</h2><span>引用仅在当前快照和文档内有效</span></div><div className="context-node-search"><Search size={14} /><input aria-label="筛选页面元素" placeholder="筛选名称、标签或 nodeId" value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} /></div></div>
                <div className="context-node-head"><span>元素</span><span>类型</span><span>引用</span><span>状态</span></div>
                <div className="context-node-list">{visibleNodes.length === 0 ? <Empty>当前快照没有匹配的可操作元素。</Empty> : visibleNodes.map((node) => <button key={node.nodeId} className={node.nodeId === selectedNodeId ? 'active' : ''} onClick={() => setSelectedNodeId(node.nodeId)}><span><strong>{node.accessibleName || node.text || node.name || '未命名元素'}</strong><small>{node.selectorHint}</small></span><code>{node.tag}{node.type ? `:${node.type}` : ''}</code><code>{node.nodeId}</code><i className={node.visible && !node.disabled ? 'ready' : ''}>{node.disabled ? '禁用' : node.visible ? '可见' : '隐藏'}</i></button>)}</div>
              </section>
            </div>
            <aside className="context-inspector">
              <section><div className="context-section-heading"><div><h2>元素检查器</h2><span>{selectedNode?.nodeId || '未选择'}</span></div><Eye size={15} /></div>
                {!selectedNode ? <div className="context-inspector-empty">选择一个节点查看稳定引用和可用操作。</div> : <>{nodeError ? <div className="context-node-error"><AlertTriangle size={14} />{nodeError}</div> : <>
                  <div className="node-identity"><code>{selectedNode.tag}{selectedNode.type ? `:${selectedNode.type}` : ''}</code><strong>{selectedNode.accessibleName || selectedNode.text || selectedNode.name || '未命名元素'}</strong><span>{selectedNode.selectorHint}</span></div>
                  <dl className="node-properties"><div><dt>Capture</dt><dd>{context.captureId.slice(0, 12)}</dd></div><div><dt>Node</dt><dd>{selectedNode.nodeId}</dd></div><div><dt>Frame</dt><dd>{context.target.frameId}</dd></div><div><dt>Shadow</dt><dd>{selectedNode.shadowDepth}</dd></div>{nodeDetails?.bounds && <><div><dt>X / Y</dt><dd>{Math.round(nodeDetails.bounds.x)} / {Math.round(nodeDetails.bounds.y)}</dd></div><div><dt>尺寸</dt><dd>{Math.round(nodeDetails.bounds.width)} × {Math.round(nodeDetails.bounds.height)}</dd></div></>}</dl>
                  <div className="node-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('scroll')}><Radio size={14} />定位</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('focus')}><Eye size={14} />聚焦</Button><Button size="sm" variant="primary" disabled={busy || selectedNode.disabled} onClick={() => void act('click')}><MousePointer2 size={14} />点击</Button></div>
                  {canSetValue && <div className="node-value-editor"><Field label="写入字段值"><input type={selectedNode.type === 'password' ? 'password' : 'text'} value={nodeValue} onChange={(event) => setNodeValue(event.target.value)} /></Field><Button size="sm" disabled={busy} onClick={() => void act('setValue')}>写入</Button></div>}
                </>}</>}
              </section>
              <section className="auth-evidence"><div className="context-section-heading"><div><h2>认证信号</h2><span>启发式判断，不等同于服务端会话验证</span></div></div>{context.authentication.evidence.length ? <ul>{context.authentication.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <div className="context-inspector-empty">没有发现明确的登录或退出信号。</div>}{context.authentication.cookieNames.length > 0 && <div className="signal-names"><strong>Cookie</strong><span>{context.authentication.cookieNames.join(', ')}</span></div>}{context.authentication.storageKeys.length > 0 && <div className="signal-names"><strong>Storage</strong><span>{context.authentication.storageKeys.join(', ')}</span></div>}</section>
            </aside>
          </div>
        </>}
      </TabsContent>
      {!FIREFOX_AMO_BUILD && <><TabsContent value="invoke" className="context-utility-panel"><h2>调用页面函数</h2><p>按全局路径复用页面已有的签名、加密或解密逻辑。</p><Field label="函数路径"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="app.crypto.encrypt" /></Field><Field label="参数 JSON 数组"><textarea rows={7} value={args} onChange={(event) => setArgs(event.target.value)} /></Field><Button variant="primary" disabled={busy || !path} onClick={() => void run(async () => { const parsed = JSON.parse(args); if (!Array.isArray(parsed)) throw new Error('参数必须是 JSON 数组'); setResult(JSON.stringify(await request('context.invoke', { path, args: parsed, tabId: tab?.id }), null, 2)); }, '页面函数调用完成')}><Braces size={16} />执行函数</Button>{result && <pre className="invoke-result">{result}</pre>}</TabsContent>
      <TabsContent value="eval" className="context-utility-panel">
        <h2>页面主世界 Eval</h2>
        <div className="segmented eval-mode"><button className={evalMode === 'expression' ? 'active' : ''} onClick={() => setEvalMode('expression')}>表达式</button><button className={evalMode === 'program' ? 'active' : ''} onClick={() => setEvalMode('program')}>程序</button></div>
        <div className="eval-warning"><ShieldCheck size={15} /><span>{evalMode === 'program' ? '程序模式是 async 函数体，返回结果需显式使用 return，并需要独立的 browser.page.eval.program 授权。' : '表达式模式自动返回表达式值，Agent 只需要 browser.page.eval.expression 授权。'}</span></div>
        <Field label={evalMode === 'expression' ? 'JavaScript 表达式' : 'JavaScript 程序'}><textarea className="code-editor" rows={12} value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} /></Field>
        <Button variant="primary" disabled={busy || !code.trim()} onClick={() => void run(async () => setEvalResult(await request('context.eval', { mode: evalMode, code, tabId: tab?.id, timeoutMs: 10_000 })), '页面代码执行完成')}><Braces size={16} />预览目标后执行</Button>
        {evalResult && <div className="eval-result-meta"><span>模式 {evalMode}</span><span>类型 {evalResult.type}</span><span>{evalResult.durationMs} ms</span>{evalResult.truncated && <span>结果已截断</span>}</div>}{evalResult && <pre className="invoke-result">{JSON.stringify(evalResult.value, null, 2)}</pre>}
      </TabsContent></>}
      <TabsContent value="json" className="context-json"><div className="panel-title"><span>结构化上下文</span>{context && <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(context, null, 2))}>复制 JSON</button>}</div><pre>{context ? JSON.stringify(context, null, 2) : '尚未采集页面上下文。'}</pre></TabsContent>
    </Tabs>
  </div>;
}

function EngineSettings({ state, setState, bridge, setBridge, tabs, run, busy }: { state: ExtensionState; setState: (state: ExtensionState) => void; bridge: BridgeStatus; setBridge: (status: BridgeStatus) => void; tabs: ActiveTabInfo[]; run: (task: () => Promise<void>, success?: string) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState(state.bridge);
  const [pairing, setPairing] = useState<BridgePairingStatus>({ state: 'idle', message: state.bridge.pairedEngine ? '当前浏览器已配对' : '尚未配对' });
  const [panelDraft, setPanelDraft] = useState(state.floatingPanel);
  const [policy, setPolicy] = useState<EnterprisePolicyStatus>({ managed: false, policy: {}, warnings: [] });
  useEffect(() => {
    void request('policy.status').then(setPolicy).catch(() => undefined);
    void request('bridge.pair.status').then(setPairing).catch(() => undefined);
    const listener = (message: unknown) => {
      const input = message as { action?: string; payload?: BridgePairingStatus };
      if (input.action === 'bridge.pairing.status.changed' && input.payload) setPairing(input.payload);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
  useEffect(() => setDraft(state.bridge), [state.bridge]);
  const save = () => run(async () => {
    if (draft.transport === 'native') {
      // Permission requests must be the first browser call made from the click gesture.
      const granted = await browser.permissions.request({ permissions: ['nativeMessaging'] });
      if (!granted) throw new Error('使用 Native Host 需要用户授予 Native Messaging 权限');
    }
    setState(await request('bridge.config.save', draft));
  }, 'Bridge 设置已保存');
  const savePanel = () => run(async () => {
    const siteOrigins = panelDraft.siteOrigins.map((value) => new URL(value).origin);
    const next = await request('panel.update', { ...panelDraft, siteOrigins });
    setState(next);
    setPanelDraft(next.floatingPanel);
  }, '悬浮面板策略已保存');
  return <div className="section-view engine-view">
    <div className="page-heading"><div><h1>Yak 引擎连接</h1><p>扩展主动连接本机 Bridge，网页无法直接访问此通道。</p></div><span className={`large-status ${bridge.state}`}><Radio size={16} />{bridge.message}</span></div>
    {policy.managed && <div className="managed-policy-banner"><ShieldCheck size={16} /><span><strong>此浏览器由组织策略管理</strong><small>{policy.policy.disableWebSocket ? '必须使用 Native Messaging' : policy.policy.bridgeTransport ? `传输锁定为 ${policy.policy.bridgeTransport}` : '连接与授权限制已应用'}{policy.policy.maxGrantMinutes ? ` · 授权最长 ${policy.policy.maxGrantMinutes} 分钟` : ''}{policy.policy.allowProgramEval === false ? ' · 程序 Eval 已禁用' : ''}</small>{policy.warnings.map((warning) => <i key={warning}>{warning}</i>)}</span></div>}
    {bridge.state === 'connected' && <div className="bridge-identity-strip"><div><span>引擎实例</span><code title={bridge.engineInstanceId}>{bridge.engineInstanceId?.slice(0, 18)}</code></div><div><span>连接</span><code title={bridge.connectionId}>{bridge.connectionId?.slice(0, 18)}</code></div><div><span>会话</span><code title={bridge.sessionId}>{bridge.sessionId?.slice(0, 18)}</code></div><div><span>心跳</span><strong>{bridge.latencyMs === undefined ? '等待首个回执' : `${bridge.latencyMs} ms`}</strong></div><div><span>恢复</span><strong>{bridge.resumed ? '已恢复 task session' : '新会话'}</strong></div></div>}
    <div className="engine-layout"><div className="settings-form">
      <section className={`pairing-workspace ${state.bridge.pairedEngine ? 'paired' : pairing.state}`}>
        <div className="pairing-workspace__heading"><span className="pairing-icon"><KeyRound size={19} /></span><div><h2>{state.bridge.pairedEngine ? '浏览器已安全配对' : pairing.state === 'pending' ? '等待 Yakit 确认' : '连接本机 Yakit'}</h2><p>{state.bridge.pairedEngine ? '设备身份已锁定到首次批准的 Yak 引擎。' : pairing.message}</p></div></div>
        {pairing.state === 'pending' && <div className="pairing-code" aria-live="polite"><span>配对验证码</span><strong>{pairing.code?.slice(0, 3)} {pairing.code?.slice(3)}</strong><small>{pairing.expiresAt ? `${Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000))} 秒内有效` : ''}</small></div>}
        {state.bridge.pairedEngine && <div className="paired-engine-meta"><div><span>引擎身份</span><code title={state.bridge.pairedEngine.engineIdentityId}>{state.bridge.pairedEngine.engineIdentityId.slice(0, 24)}</code></div><div><span>设备 ID</span><code title={state.bridge.pairedEngine.deviceId}>{state.bridge.pairedEngine.deviceId.slice(0, 24)}</code></div></div>}
        <div className="editor-actions">
          {!state.bridge.pairedEngine && pairing.state !== 'pending' && <Button variant="primary" disabled={busy || pairing.state === 'requesting'} onClick={() => void run(async () => setPairing(await request('bridge.pair')))}><Power size={16} />{pairing.state === 'requesting' ? '正在查找' : '查找本机 Yakit'}</Button>}
          {!state.bridge.pairedEngine && pairing.state === 'pending' && <Button disabled={busy} onClick={() => void run(async () => setPairing(await request('bridge.pair.cancel')))}><X size={16} />取消申请</Button>}
          {state.bridge.pairedEngine && <Button variant="primary" disabled={busy} onClick={() => void run(async () => { if (bridge.state === 'connected') await request('bridge.disconnect'); else await request('bridge.connect'); setBridge(await request('bridge.status')); }, bridge.state === 'connected' ? 'Bridge 已断开' : 'Bridge 正在连接')}><Power size={16} />{bridge.state === 'connected' ? '断开连接' : '连接引擎'}</Button>}
          {state.bridge.pairedEngine && <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('解除当前 Yak 引擎的本地配对？浏览器安装身份会保留，重新配对时 Yakit 将更新原可信记录。')) void run(async () => { const next = await request('bridge.unpair'); setState(next); setDraft(next.bridge); }, '本地配对凭据已清除'); }}><Trash2 size={16} />解除配对</Button>}
        </div>
      </section>
      <details className="advanced-connection"><summary>高级连接设置</summary><div className="advanced-connection__body">
        <div className="segmented"><button disabled={Boolean(policy.policy.bridgeTransport || policy.policy.disableWebSocket)} className={draft.transport === 'websocket' ? 'active' : ''} onClick={() => setDraft({ ...draft, transport: 'websocket' })}>本机 WebSocket</button><button disabled={Boolean(policy.policy.bridgeTransport || policy.policy.disableWebSocket)} className={draft.transport === 'native' ? 'active' : ''} onClick={() => setDraft({ ...draft, transport: 'native' })}>Native Host</button></div>
        {draft.transport === 'native' ? <Field label="Native Host" hint="仅在已安装 Yakit Native Host 时使用"><input disabled={Boolean(policy.policy.nativeHost)} value={draft.nativeHost} onChange={(event) => setDraft({ ...draft, nativeHost: event.target.value })} /></Field> : <Field label="WebSocket Endpoint" hint="只允许 127.0.0.1、localhost 或 ::1"><input disabled={Boolean(policy.policy.bridgeEndpoint)} value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></Field>}
        <label className="toggle-row"><span><strong>启动扩展时自动连接</strong><small>{draft.transport === 'native' ? '由浏览器拉起已注册的 Yakit Host' : 'Service Worker 使用心跳维持本机连接'}</small></span><Switch disabled={policy.policy.autoConnect !== undefined || !draft.pairedEngine} checked={draft.autoConnect} onCheckedChange={(checked) => setDraft({ ...draft, autoConnect: checked })} /></label>
        <div className="editor-actions"><Button disabled={busy} onClick={() => void save()}><Save size={16} />保存高级设置</Button></div>
      </div></details>
      <section className="panel-policy-settings"><h2>网页侧边工具</h2>
        <label className="toggle-row"><span><strong>启用悬浮面板</strong><small>轻量启动器常驻，React 工作台仅在展开时加载</small></span><Switch disabled={policy.policy.floatingPanelEnabled !== undefined} checked={panelDraft.enabled} onCheckedChange={(enabled) => setPanelDraft({ ...panelDraft, enabled })} /></label>
        <div className="panel-policy-grid"><Field label="显示条件"><select value={panelDraft.displayMode} onChange={(event) => setPanelDraft({ ...panelDraft, displayMode: event.target.value as 'always' | 'active-task' })}><option value="always">符合站点规则时显示</option><option value="active-task">仅活动任务或人工接管时显示</option></select></Field><Field label="站点规则"><select value={panelDraft.siteMode} onChange={(event) => setPanelDraft({ ...panelDraft, siteMode: event.target.value as 'all' | 'allowlist' | 'denylist' })}><option value="all">所有 HTTP(S) 站点</option><option value="allowlist">仅允许列表</option><option value="denylist">排除列表</option></select></Field></div>
        {panelDraft.siteMode !== 'all' && <Field label="站点 Origin" hint="每行一个完整 origin"><textarea rows={4} value={panelDraft.siteOrigins.join('\n')} onChange={(event) => setPanelDraft({ ...panelDraft, siteOrigins: event.target.value.split(/\s+/).filter(Boolean) })} placeholder="https://app.example.com" /></Field>}
        <label className="toggle-row"><span><strong>页面内快捷展开</strong><small>仅在当前站点策略允许显示时生效</small></span><Switch checked={panelDraft.shortcutEnabled} onCheckedChange={(shortcutEnabled) => setPanelDraft({ ...panelDraft, shortcutEnabled })} /></label>
        <label className="toggle-row"><span><strong>全屏自动收起</strong><small>进入全屏、演示或视频场景时关闭展开内容</small></span><Switch checked={panelDraft.autoCollapseFullscreen} onCheckedChange={(autoCollapseFullscreen) => setPanelDraft({ ...panelDraft, autoCollapseFullscreen })} /></label>
        <div className="editor-actions"><Button disabled={busy} onClick={() => void savePanel()}><Save size={16} />保存面板策略</Button></div>
      </section>
      <div className="grant-editor"><h2>浏览器实例访问</h2><p>配对成功后，Yakit 可直接引用此浏览器中的全部 HTTP(S) 页面；刷新、跳转和新标签页会自动跟随，不再逐页授权。</p><div className="grant-status"><strong>{bridge.state === 'connected' ? '实例已连接' : state.bridge.pairedEngine ? '实例已配对，当前离线' : '实例尚未配对'}</strong><span>{tabs.length} 个可访问页面 · 浏览器内部页始终排除 · 无痕窗口沿用浏览器自己的独立访问开关</span></div><div className="grant-scope-list"><span>人工：逐次确认 · 协同 AI：按风险判断 · YOLO：自动执行</span><span>{policy.policy.allowProgramEval === false ? '程序 Eval 已被企业策略禁用' : '程序 Eval 在 YOLO 下无需手动批准，仍受浏览器与企业策略限制'}</span>{policy.policy.grantAllowedOrigins?.length ? <span>企业来源白名单：{policy.policy.grantAllowedOrigins.length} 项</span> : null}</div></div>
    </div>
      <div className="protocol-panel"><h2>Bridge 方法</h2><div><code>browser.tabs / tab.open / frames</code><span>列出当前实例的 HTTP(S) 标签页、打开网页并读取完整 frame inventory</span></div><div><code>browser.context</code><span>生成结构化快照、存储 inventory、认证信号与上下文 diff</span></div><div><code>browser.node.*</code><span>检查或操作快照内的文档绑定节点引用</span></div><div><code>browser.cookies</code><span>读取指定标签页的浏览器 Cookie</span></div><div><code>browser.network.*</code><span>控制有界网络捕获、读取请求时间线并导出重放包</span></div><div><code>browser.takeover</code><span>将页面切到前台，交给用户扫码或二次验证</span></div><div><code>browser.invoke</code><span>调用页面已有全局函数</span></div><div><code>browser.eval</code><span>在页面主世界执行代码，支持 Promise 和超时</span></div><div><code>proxy.list / switch</code><span>读取并切换扩展代理配置</span></div></div>
    </div>
  </div>;
}

export default App;
