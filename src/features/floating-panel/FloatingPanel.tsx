import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Braces, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, GripVertical,
  EyeOff, Network, Pause, Play, Radio, RefreshCw, Settings, ShieldCheck, X,
} from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HANDOFF_REASON_LABELS, waitingHandoff } from '@/features/handoff/presentation';
import { READ_CAPABILITY_SCOPES, isControlScopeSet } from '@/protocol/capabilities';
import { AGENT_RUNTIME_STORAGE_KEY, isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, AgentRuntime, BridgeStatus, ExtensionState, PageContext } from '@/types/models';
import { errorMessage, request } from '@/platform/messaging/runtime';

interface FloatingPanelProps {
  initialState: ExtensionState;
  initialTab?: ActiveTabInfo;
  initialBridge: BridgeStatus;
  yakIconUrl: string;
  embedded?: boolean;
}

export function FloatingPanel({ initialState, initialTab, initialBridge, yakIconUrl, embedded = false }: FloatingPanelProps) {
  const [state, setState] = useState(initialState);
  const [bridge, setBridge] = useState(initialBridge);
  const [tab] = useState(initialTab);
  const [expanded, setExpanded] = useState(embedded);
  const [side, setSide] = useState(initialState.floatingPanel.side);
  const [y, setY] = useState(initialState.floatingPanel.y);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [context, setContext] = useState<PageContext>();
  const [runtime, setRuntime] = useState<AgentRuntime>({ state: 'idle', updatedAt: Date.now(), actions: [] });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | undefined>(undefined);

  const activeProfile = useMemo(
    () => state.proxyProfiles.find((profile) => profile.id === state.activeProxyId),
    [state],
  );
  const grantActive = Boolean(
    state.activeGrant && state.activeGrant.expiresAt > Date.now() && tab && state.activeGrant.targets.some((target) => target.tabId === tab.id),
  );
  const pendingHandoff = waitingHandoff(state.handoff);
  const handoff = pendingHandoff?.target.tabId === tab?.id ? pendingHandoff : undefined;

  useEffect(() => {
    void request('agent.runtime.get').then(setRuntime).catch(() => undefined);
    const listener = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) {
        void request('state.get').then((next) => {
          setState(next);
          setSide(next.floatingPanel.side);
          setY(next.floatingPanel.y);
        }).catch(() => undefined);
      }
      if (AGENT_RUNTIME_STORAGE_KEY in changes) void request('agent.runtime.get').then(setRuntime).catch(() => undefined);
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

  // Embedded mode: report natural content height so the host shell can size the iframe (no dead space, internal scroll when clamped).
  useEffect(() => {
    if (!embedded) return undefined;
    const post = () => {
      const header = document.querySelector('.floating-panel__header');
      const body = document.querySelector('.floating-panel__body');
      const height = (header?.getBoundingClientRect().height || 46) + (body?.scrollHeight || 0);
      window.parent.postMessage({ channel: 'yakit-floating-host', type: 'resize', height: Math.ceil(height) }, '*');
    };
    post();
    const observer = new ResizeObserver(post);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [embedded]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setNotice('');
    try {
      await task();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openWorkspace = (section: string) => {
    const target = tab ? `?tabId=${tab.id}` : '';
    window.open(browser.runtime.getURL(`/options.html${target}#${section}`), '_blank', 'noopener');
  };

  const hideCurrentSite = () => run(async () => {
    if (!tab?.url) return;
    const origin = new URL(tab.url).origin;
    const current = state.floatingPanel;
    const siteOrigins = current.siteMode === 'allowlist'
      ? current.siteOrigins.filter((item) => item !== origin)
      : [...new Set([...current.siteOrigins, origin])];
    setState(await request('panel.update', {
      siteMode: current.siteMode === 'allowlist' ? 'allowlist' : 'denylist', siteOrigins,
    }));
  });

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 4) current.moved = true;
    if (!current.moved) return;
    setY(Math.min(Math.max(event.clientY / window.innerHeight, 0.08), 0.92));
    setSide(event.clientX < window.innerWidth / 2 ? 'left' : 'right');
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (current.moved) {
      const nextSide = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
      const nextY = Math.min(Math.max(event.clientY / window.innerHeight, 0.08), 0.92);
      setSide(nextSide);
      setY(nextY);
      void request('panel.update', { side: nextSide, y: nextY }).then(setState).catch(() => undefined);
    } else {
      setExpanded((value) => !value);
    }
  };

  if (!state.floatingPanel.enabled) return null;

  const collapseEmbedded = () => window.parent.postMessage({ channel: 'yakit-floating-host', type: 'collapse' }, '*');

  return (
    <div className={`floating-panel floating-panel--${side} ${embedded ? 'floating-panel--embedded' : ''} ${expanded ? 'is-expanded' : ''}`} style={embedded ? undefined : { top: `${y * 100}%` }}>
      <div className="floating-panel__header" onClick={embedded ? collapseEmbedded : undefined} onPointerDown={embedded ? undefined : onPointerDown} onPointerMove={embedded ? undefined : onPointerMove} onPointerUp={embedded ? undefined : onPointerUp}>
        <button className="floating-panel__brand" aria-label={expanded ? '收起 Yakit Browser Agent' : '展开 Yakit Browser Agent'}>
          <img src={yakIconUrl} alt="Yak" draggable={false} />
          <span className={`floating-panel__signal ${bridge.state}`} />
        </button>
        {expanded && <>
          <div className="floating-panel__title">
            <strong>Yakit Browser Agent</strong>
            <span>{activeProfile?.name || (state.activeProxyId === 'rules' ? '按规则分流' : '浏览器工具')}</span>
          </div>
          <GripVertical className="floating-panel__grip" size={15} aria-hidden="true" />
          {side === 'right' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </>}
      </div>

      {expanded && (
        <div className="floating-panel__body">
          <Tabs key={handoff?.id || 'default'} defaultValue={handoff ? 'agent' : 'proxy'}>
            <TabsList className="floating-tabs">
              <TabsTrigger value="proxy"><Network size={13} />代理</TabsTrigger>
              <TabsTrigger value="context"><Braces size={13} />上下文</TabsTrigger>
              <TabsTrigger value="agent">{handoff ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}Agent</TabsTrigger>
            </TabsList>

            <TabsContent value="proxy" className="floating-tab-content">
              <div className="floating-section-heading"><span>快速切换</span><Button size="icon" variant="ghost" title="代理设置" onClick={() => openWorkspace('proxies')}><Settings size={15} /></Button></div>
              <div className="floating-option-list">
                {state.proxyProfiles.map((profile) => (
                  <button key={profile.id} className={state.activeProxyId === profile.id ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.switch', { id: profile.id })))}>
                    <i className="floating-radio" />
                    <span><strong>{profile.name}</strong><small>{profile.kind === 'fixed_servers' ? `${profile.host}:${profile.port}` : profile.kind}</small></span>
                  </button>
                ))}
                {state.proxyRules.length > 0 && <button className={state.activeProxyId === 'rules' ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.rules.apply')))}><i className="floating-radio" /><span><strong>按规则分流</strong><small>{state.proxyRules.filter((rule) => rule.enabled).length} 条启用规则</small></span></button>}
              </div>
            </TabsContent>

            <TabsContent value="context" className="floating-tab-content">
              <div className="floating-page-meta"><strong title={tab?.title}>{tab?.title || '当前页面不可访问'}</strong><span title={tab?.url}>{tab?.url || '仅支持 HTTP(S) 页面'}</span></div>
              <Button variant="primary" disabled={busy || !tab?.url?.startsWith('http')} onClick={() => void run(async () => setContext(await request('context.capture', { includeDom: true, includeStorage: true, includeCookies: true, tabId: tab?.id })))}>
                {busy ? <RefreshCw className="spin" size={14} /> : <Radio size={14} />}采集页面环境
              </Button>
              {context && <div className="floating-result"><span>{context.document?.forms.length || 0} 个表单 · {context.document?.interactive.length || 0} 个交互元素</span><Button size="icon" variant="ghost" title="复制上下文 JSON" onClick={() => void navigator.clipboard.writeText(JSON.stringify(context, null, 2))}><Copy size={14} /></Button></div>}
              <Button variant="ghost" onClick={() => openWorkspace('context')}>打开上下文工作台<ExternalLink size={14} /></Button>
            </TabsContent>

            <TabsContent value="agent" className="floating-tab-content">
              <div className="floating-status-row"><span className={`floating-dot ${bridge.state}`} /><span><strong>{bridge.state === 'connected' ? 'Yak 引擎在线' : 'Yak 引擎离线'}</strong><small>{bridge.message}</small></span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { if (bridge.state === 'connected') await request('bridge.disconnect'); else await request('bridge.connect'); setBridge(await request('bridge.status')); })}>{bridge.state === 'connected' ? '断开' : '连接'}</Button></div>
              {handoff ? <div className="floating-handoff" aria-live="assertive">
                <div className="floating-handoff__copy"><AlertTriangle size={16} /><span><strong>{HANDOFF_REASON_LABELS[handoff.reason]}</strong><small>{handoff.message}</small></span></div>
                <div className="floating-handoff__actions">
                  <Button variant="primary" disabled={busy} onClick={() => void run(async () => setState(await request('handoff.resolve', { id: handoff.id, outcome: 'completed' })))}><Check size={14} />已完成</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void run(async () => setState(await request('handoff.resolve', { id: handoff.id, outcome: 'cancelled' })))}><X size={14} />取消</Button>
                </div>
              </div> : <>
                {grantActive && <div className={`floating-agent-task ${runtime.state}`}><span><strong>{runtime.state === 'paused' ? 'Agent 已暂停' : runtime.state === 'running' ? 'Agent 正在操作' : '共享会话活动'}</strong><small title={state.activeGrant?.taskId}>{state.activeGrant?.taskId} · {state.activeGrant && isControlScopeSet(state.activeGrant.scopes) ? '控制权限' : '只读权限'}</small></span>{runtime.state === 'paused' ? <Button size="icon" variant="ghost" title="恢复 Agent" onClick={() => void run(async () => setRuntime(await request('agent.resume')))}><Play size={14} /></Button> : <Button size="icon" variant="ghost" title="暂停 Agent" onClick={() => void run(async () => setRuntime(await request('agent.pause')))}><Pause size={14} /></Button>}</div>}
                <label className="floating-share-row"><span><strong>共享当前主 frame</strong><small>30 分钟只读授权，可随时撤销</small></span><Switch checked={grantActive} disabled={!tab || busy} onCheckedChange={(checked) => void run(async () => setState(checked ? await request('grant.create', { targets: [{ tabId: tab!.id, frameId: 0 }], scopes: READ_CAPABILITY_SCOPES, durationMinutes: 30 }) : await request('grant.revoke')))} /></label>
                <Button variant="secondary" onClick={() => openWorkspace('engine')}>管理控制授权<Settings size={14} /></Button>
                <Button variant="ghost" disabled={!tab?.url} onClick={() => void hideCurrentSite()}><EyeOff size={14} />在此站点隐藏</Button>
              </>}
            </TabsContent>
          </Tabs>
          {notice && <div className="floating-notice">{notice}</div>}
        </div>
      )}
    </div>
  );
}
