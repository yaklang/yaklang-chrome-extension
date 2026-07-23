import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Braces, Check, Cookie, ExternalLink, Gauge, Network, Radio, RefreshCw, UserRoundCog, X,
} from 'lucide-react';
import { browser } from 'wxt/browser';
import { YakMark } from '@/components/brand/Brand';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { HANDOFF_REASON_LABELS, waitingHandoff } from '@/features/handoff/presentation';
import { isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, BridgeStatus, ExtensionState, UserAgentResolution } from '@/types/models';
import { errorMessage, request } from '@/platform/messaging/runtime';
import { CookieQuickView } from './views/CookieQuickView';
import { OverviewQuickView } from './views/OverviewQuickView';
import { ProxyQuickView } from './views/ProxyQuickView';
import { UserAgentQuickView } from './views/UserAgentQuickView';
import './App.css';

type PopupView = 'home' | 'proxy' | 'cookies' | 'user-agent';

const FULL_VIEW_TARGETS: Record<PopupView, { section: string; label: string }> = {
  home: { section: 'overview', label: '打开完整工作台' },
  proxy: { section: 'rules', label: '打开代理策略' },
  cookies: { section: 'cookies', label: '打开完整 Cookie Editor' },
  'user-agent': { section: 'user-agent', label: '打开 User-Agent 管理' },
};

function engineStatusLabel(state: ExtensionState, bridge: BridgeStatus): string {
  if (bridge.state === 'connected') return '引擎在线';
  if (bridge.state === 'connecting') return '正在连接引擎';
  if (bridge.state === 'negotiating') return '正在验证引擎身份';
  if (bridge.state === 'error') return bridge.message || '引擎连接失败';
  return state.bridge.pairedEngine ? bridge.message || '引擎离线' : '尚未配对引擎';
}

function App() {
  const [state, setState] = useState<ExtensionState>();
  const [tab, setTab] = useState<ActiveTabInfo>();
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'disconnected', message: '未连接引擎' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<PopupView>('home');
  const [cookieCount, setCookieCount] = useState(0);
  const [uaResolution, setUaResolution] = useState<UserAgentResolution>();

  const load = useCallback(async () => {
    const [nextState, nextTab, nextBridge] = await Promise.all([
      request('state.get'),
      request('tab.active').catch(() => undefined),
      request('bridge.status'),
    ]);
    setState(nextState);
    setTab(nextTab);
    setBridge(nextBridge);
    if (nextTab?.url?.startsWith('http')) {
      const [cookies, resolution] = await Promise.all([
        request('cookie.list', { url: nextTab.url }).catch(() => []),
        request('ua.resolve', { url: nextTab.url }).catch(() => undefined),
      ]);
      setCookieCount(cookies.length);
      setUaResolution(resolution);
    } else {
      setCookieCount(0);
      setUaResolution(undefined);
    }
  }, []);

  useEffect(() => {
    void load();
    const listener = (message: { action?: string; payload?: BridgeStatus }) => {
      if (message.action === 'bridge.status.changed' && message.payload) setBridge(message.payload);
    };
    browser.runtime.onMessage.addListener(listener);
    const onStorageChange = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) void load();
    };
    browser.storage.onChanged.addListener(onStorageChange);
    return () => {
      browser.runtime.onMessage.removeListener(listener);
      browser.storage.onChanged.removeListener(onStorageChange);
    };
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = globalThis.setTimeout(() => setNotice(''), 2_400);
    return () => globalThis.clearTimeout(timer);
  }, [notice]);

  const grantActive = Boolean(state?.activeGrant && state.activeGrant.expiresAt > Date.now() && tab && state.activeGrant.targets.some((target) => target.tabId === tab.id));
  const handoff = waitingHandoff(state?.handoff);

  const run = async (task: () => Promise<void>, success?: string) => {
    setBusy(true);
    setNotice('');
    try {
      await task();
      if (success) setNotice(success);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openTool = (tool: string) => {
    const target = tab ? `?tabId=${tab.id}` : '';
    return browser.tabs.create({ url: browser.runtime.getURL(`/options.html${target}#${tool}`) });
  };

  const toggleEngine = () => run(async () => {
    if (!state!.bridge.pairedEngine) {
      await request('bridge.pair');
      await openTool('engine');
      return;
    }
    if (bridge.state === 'connected') await request('bridge.disconnect'); else await request('bridge.connect');
    setBridge(await request('bridge.status'));
  });

  const capture = () => run(async () => {
    const context = await request('context.capture', {
      includeDom: true,
      includeStorage: true,
      includeCookies: true,
      tabId: tab?.id,
    });
    await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
    setNotice('页面上下文已复制');
  });

  if (!state) {
    return <div className="popup-loading"><RefreshCw size={18} className="spin" />正在读取浏览器状态</div>;
  }

  const engineBusy = bridge.state === 'connecting' || bridge.state === 'negotiating';
  const currentHost = (() => { try { return tab?.url ? new URL(tab.url).host : ''; } catch { return ''; } })();
  const statusLabel = engineStatusLabel(state, bridge);
  const statusActionLabel = bridge.state === 'connected'
    ? `${statusLabel}，点击断开`
    : state.bridge.pairedEngine ? `${statusLabel}，点击连接` : `${statusLabel}，点击配对`;
  const fullViewTarget = FULL_VIEW_TARGETS[view];

  return (
    <TooltipProvider delayDuration={350}>
      <main className="popup-shell">
        <header className="popup-header">
          <div className="popup-header-main">
            <Tooltip label="Yakit Browser Agent" side="bottom">
              <span className="popup-brand-mark" role="img" aria-label="Yakit Browser Agent">
                <YakMark />
              </span>
            </Tooltip>
            <div className="popup-target">
              <div className="popup-target-title">
                <span className="popup-favicon">{tab?.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Radio size={12} />}</span>
                <strong title={tab?.title}>{tab?.title || '当前页面不可访问'}</strong>
              </div>
              <span className="popup-target-host" title={tab?.url}>{currentHost || '无法读取当前标签页'}</span>
            </div>
            <div className="popup-brand-actions">
              <Tooltip label={statusActionLabel} side="bottom">
                <button className={`popup-engine-status ${bridge.state}`} aria-label={statusLabel} disabled={busy || engineBusy} onClick={() => void toggleEngine()}>
                  <i aria-hidden="true" />
                  <span>{bridge.state === 'connected' ? '在线' : engineBusy ? '连接中' : state.bridge.pairedEngine ? '离线' : '配对'}</span>
                </button>
              </Tooltip>
              <Tooltip label={fullViewTarget.label} side="bottom">
                <Button size="icon" variant="ghost" aria-label={fullViewTarget.label} onClick={() => void openTool(fullViewTarget.section)}>
                  <ExternalLink size={16} />
                </Button>
              </Tooltip>
            </div>
          </div>
        </header>

        <div className="popup-body">
          <nav className="popup-rail" aria-label="Popup 工具导航">
            <div className="popup-rail-main">
              <Tooltip label="运行概览" side="right"><button className={view === 'home' ? 'is-active' : ''} aria-label="运行概览" aria-current={view === 'home' ? 'page' : undefined} onClick={() => setView('home')}><Gauge size={18} /></button></Tooltip>
              <Tooltip label="代理" side="right"><button className={view === 'proxy' ? 'is-active' : ''} aria-label="代理" aria-current={view === 'proxy' ? 'page' : undefined} onClick={() => setView('proxy')}><Network size={18} /></button></Tooltip>
              <Tooltip label="Cookie Editor" side="right"><button className={view === 'cookies' ? 'is-active' : ''} aria-label="Cookie Editor" aria-current={view === 'cookies' ? 'page' : undefined} onClick={() => setView('cookies')}><Cookie size={18} /></button></Tooltip>
              <Tooltip label="User-Agent" side="right"><button className={view === 'user-agent' ? 'is-active' : ''} aria-label="User-Agent" aria-current={view === 'user-agent' ? 'page' : undefined} onClick={() => setView('user-agent')}><UserRoundCog size={18} /></button></Tooltip>
            </div>
            <div className="popup-rail-bottom">
              <Tooltip label="登录态工作区" side="right"><button aria-label="打开登录态工作区" onClick={() => void openTool('context')}><Braces size={18} /></button></Tooltip>
            </div>
          </nav>

          <section className="popup-workspace">
            {handoff && <section className="popup-handoff" aria-live="assertive">
              <AlertTriangle size={18} />
              <div className="popup-handoff__copy">
                <strong>{HANDOFF_REASON_LABELS[handoff.reason]}</strong>
                <span>{handoff.message}</span>
                <small title={handoff.target.title}>{handoff.target.title}</small>
              </div>
              <div className="popup-handoff__actions">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(async () => setState(await request('handoff.resolve', { id: handoff.id, outcome: 'completed' })))}><Check size={14} />完成</Button>
                <Button size="icon" variant="ghost" disabled={busy} aria-label="取消人工接管" title="取消人工接管" onClick={() => void run(async () => setState(await request('handoff.resolve', { id: handoff.id, outcome: 'cancelled' })))}><X size={15} /></Button>
              </div>
            </section>}
            {view === 'home' && <OverviewQuickView state={state} tab={tab} grantActive={grantActive} busy={busy} run={run} setState={setState} cookieCount={cookieCount} uaResolution={uaResolution} onNavigate={setView} onOpenContext={() => void openTool('context')} onCapture={() => void capture()} />}
            {view === 'proxy' && <ProxyQuickView state={state} setState={setState} busy={busy} run={run} tab={tab} onOpenFull={() => void openTool('rules')} />}
            {view === 'cookies' && <CookieQuickView tab={tab} busy={busy} run={run} onCountChange={setCookieCount} />}
            {view === 'user-agent' && <UserAgentQuickView tab={tab} state={state} setState={setState} busy={busy} run={run} onResolutionChange={setUaResolution} />}
          </section>
        </div>
        {notice && <span className="popup-global-notice" role="status">{notice}</span>}
      </main>
    </TooltipProvider>
  );
}

export default App;
