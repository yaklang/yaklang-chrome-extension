import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Braces, Check, Copy, ExternalLink,
  EyeOff, Network, Pause, Play, Radio, RefreshCw, Settings, ShieldCheck, X,
} from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HANDOFF_REASON_LABELS, waitingHandoff } from '@/features/handoff/presentation';
import { AGENT_RUNTIME_STORAGE_KEY, isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, AgentRuntime, BridgeStatus, ExtensionState, PageContext } from '@/types/models';
import { errorMessage, request } from '@/platform/messaging/runtime';
import { isFloatingPanelShortcut, mergeFloatingTabUpdate } from './host-controller';

interface FloatingPanelProps {
  initialState: ExtensionState;
  initialTab?: ActiveTabInfo;
  initialBridge: BridgeStatus;
  hostChannel: string;
}

export function FloatingPanel({ initialState, initialTab, initialBridge, hostChannel }: FloatingPanelProps) {
  const [state, setState] = useState(initialState);
  const [bridge, setBridge] = useState(initialBridge);
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [context, setContext] = useState<PageContext>();
  const [runtime, setRuntime] = useState<AgentRuntime>({ state: 'idle', updatedAt: Date.now(), actions: [] });
  const bodyRef = useRef<HTMLDivElement>(null);

  const pendingHandoff = waitingHandoff(state.handoff);
  const handoff = pendingHandoff?.target.tabId === tab?.id ? pendingHandoff : undefined;

  useEffect(() => {
    void request('agent.runtime.get').then(setRuntime).catch(() => undefined);
    const listener = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) {
        void request('state.get').then((next) => {
          setState(next);
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

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const input = event.data as {
        channel?: string;
        token?: string;
        type?: string;
        tab?: { tabId: number; title?: string; url?: string };
      };
      if (event.source !== window.parent || input?.channel !== 'yakit-floating-host'
        || input.token !== hostChannel || input.type !== 'tab.changed' || !input.tab) return;
      setTab((current) => mergeFloatingTabUpdate(current, input.tab!));
      setContext(undefined);
    };
    globalThis.addEventListener('message', listener);
    return () => globalThis.removeEventListener('message', listener);
  }, [hostChannel]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = Boolean(target?.isContentEditable || target?.closest('input, textarea, select, [contenteditable="true"]'));
      const shortcut = isFloatingPanelShortcut(state.floatingPanel, event, editable);
      if (!shortcut && event.key !== 'Escape') return;
      event.preventDefault();
      window.parent.postMessage({ channel: 'yakit-floating-host', token: hostChannel, type: 'collapse' }, '*');
    };
    globalThis.addEventListener('keydown', listener);
    return () => globalThis.removeEventListener('keydown', listener);
  }, [hostChannel, state.floatingPanel]);

  // The content-script host owns header, drag, placement and collapse. This
  // document reports body height only, so those responsibilities never exist twice.
  useEffect(() => {
    const post = () => {
      const height = bodyRef.current?.scrollHeight || 0;
      window.parent.postMessage({
        channel: 'yakit-floating-host', token: hostChannel, type: 'resize', height: Math.ceil(height),
      }, '*');
    };
    post();
    const observer = new ResizeObserver(post);
    if (bodyRef.current) observer.observe(bodyRef.current);
    return () => observer.disconnect();
  }, [hostChannel]);

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

  if (!state.floatingPanel.enabled) return null;

  return (
    <div className="floating-panel floating-panel--embedded is-expanded">
        <div ref={bodyRef} className="floating-panel__body">
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
                <button className={state.activeProxyId === 'auto' ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.auto.apply')))}><i className="floating-radio" /><span><strong>自动切换</strong><small>{state.proxyRules.filter((rule) => rule.enabled).length} 条手动 · {state.proxyRuleSources.filter((source) => source.enabled).length} 个订阅</small></span></button>
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
                {bridge.state === 'connected' && <div className={`floating-agent-task ${runtime.state}`}><span><strong>{runtime.state === 'paused' ? 'Agent 已暂停' : runtime.state === 'running' ? 'Agent 正在操作' : '浏览器实例已接入'}</strong><small>当前浏览器的 HTTP(S) 页面均可引用</small></span>{runtime.state === 'paused' ? <Button size="icon" variant="ghost" title="恢复 Agent" onClick={() => void run(async () => setRuntime(await request('agent.resume')))}><Play size={14} /></Button> : <Button size="icon" variant="ghost" title="暂停 Agent" onClick={() => void run(async () => setRuntime(await request('agent.pause')))}><Pause size={14} /></Button>}</div>}
                <div className="floating-share-row"><span><strong>实例级页面访问</strong><small>刷新、跳转和新标签页自动跟随，无需逐页授权</small></span><ShieldCheck size={16} /></div>
                <Button variant="secondary" onClick={() => openWorkspace('engine')}>管理 Agent 连接<Settings size={14} /></Button>
                <Button variant="ghost" disabled={!tab?.url} onClick={() => void hideCurrentSite()}><EyeOff size={14} />在此站点隐藏</Button>
              </>}
            </TabsContent>
          </Tabs>
          {notice && <div className="floating-notice">{notice}</div>}
        </div>
    </div>
  );
}
