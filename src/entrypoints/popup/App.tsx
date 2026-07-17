import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Braces, Check, Cookie, ExternalLink, Network, Radio, RefreshCw,
  ShieldCheck, UserRoundCog, X,
} from 'lucide-react';
import { browser } from 'wxt/browser';
import { ProductBrand } from '@/components/brand/Brand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { HANDOFF_REASON_LABELS, waitingHandoff } from '@/features/handoff/presentation';
import { READ_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import { isStateStorageChange } from '@/protocol/storage';
import type { ActiveTabInfo, BridgeStatus, ExtensionState, ProxyProfile } from '@/types/models';
import { errorMessage, request } from '@/platform/messaging/runtime';
import './App.css';

const PROXY_KIND_LABELS: Record<ProxyProfile['kind'], string> = {
  fixed_servers: '固定代理',
  pac_script: 'PAC Script',
  direct: '直连',
  system: '系统代理',
};

function proxyDetail(profile: ProxyProfile): string {
  return profile.kind === 'fixed_servers'
    ? `${profile.scheme}://${profile.host}:${profile.port}`
    : PROXY_KIND_LABELS[profile.kind];
}

function App() {
  const [state, setState] = useState<ExtensionState>();
  const [tab, setTab] = useState<ActiveTabInfo>();
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'disconnected', message: '未连接引擎' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [nextState, nextTab, nextBridge] = await Promise.all([
      request('state.get'),
      request('tab.active').catch(() => undefined),
      request('bridge.status'),
    ]);
    setState(nextState);
    setTab(nextTab);
    setBridge(nextBridge);
  }, []);

  useEffect(() => {
    void load();
    const listener = (message: { action?: string; payload?: BridgeStatus }) => {
      if (message.action === 'bridge.status.changed' && message.payload) setBridge(message.payload);
    };
    browser.runtime.onMessage.addListener(listener);
    const onStorageChange = (changes: Record<string, unknown>) => {
      if (isStateStorageChange(changes)) void request('state.get').then(setState).catch(() => undefined);
    };
    browser.storage.onChanged.addListener(onStorageChange);
    return () => {
      browser.runtime.onMessage.removeListener(listener);
      browser.storage.onChanged.removeListener(onStorageChange);
    };
  }, [load]);

  const grantActive = Boolean(state?.activeGrant && state.activeGrant.expiresAt > Date.now() && tab && state.activeGrant.targets.some((target) => target.tabId === tab.id));
  const handoff = waitingHandoff(state?.handoff);

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

  return (
    <TooltipProvider delayDuration={350}>
      <main className="popup-shell">
        <header className="popup-header">
          <div className="popup-brand-row">
            <ProductBrand compact />
            <div className="popup-brand-actions">
              <Tooltip label={bridge.state === 'connected' ? '断开引擎连接' : state.bridge.pairedEngine ? '连接引擎' : '配对本机 Yakit'}>
                <button className={`popup-engine-pill ${bridge.state}`} disabled={busy} onClick={() => void toggleEngine()}>
                  <i />{bridge.state === 'connected' ? '引擎在线' : engineBusy ? '连接中' : state.bridge.pairedEngine ? '引擎离线' : '配对'}
                </button>
              </Tooltip>
              <Tooltip label="打开完整工作台">
                <Button size="icon" variant="ghost" aria-label="打开完整工作台" onClick={() => void openTool('overview')}>
                  <ExternalLink size={16} />
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="popup-tab-line">
            <span className="popup-favicon">{tab?.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Radio size={12} />}</span>
            <span title={tab?.url}>{tab?.title || '当前页面不可访问'}</span>
          </div>
        </header>

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

        <section className={`popup-share ${grantActive ? 'is-active' : ''}`}>
          <div className="popup-share-copy">
            <ShieldCheck size={18} />
            <div>
              <strong>共享当前标签页</strong>
              <span>{grantActive ? `只读会话 ${new Date(state.activeGrant!.expiresAt).toLocaleTimeString()} 到期` : '创建 30 分钟只读会话'}</span>
            </div>
          </div>
          <Switch checked={grantActive} disabled={!tab || busy} aria-label="共享当前浏览器上下文" onCheckedChange={(checked) => void run(async () => {
            const updated = checked
              ? await request('grant.create', { targets: [{ tabId: tab!.id, frameId: 0 }], scopes: READ_CAPABILITY_SCOPES, durationMinutes: 30 })
              : await request('grant.revoke');
            setState(updated);
          })} />
        </section>

        <section className="popup-proxy">
          <div className="popup-section-label"><Network size={14} /><span>当前代理</span>{state.activeProxyId === 'rules' && <Badge>规则分流</Badge>}</div>
          <div className="popup-proxy-list" role="radiogroup" aria-label="代理出口">
            {state.proxyProfiles.map((profile) => {
              const active = state.activeProxyId === profile.id;
              return <button key={profile.id} role="radio" aria-checked={active} className={active ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.switch', { id: profile.id })))}>
                <i className="popup-radio" />
                <span><strong>{profile.name}</strong><small>{proxyDetail(profile)}</small></span>
              </button>;
            })}
            {state.proxyRules.length > 0 && <button role="radio" aria-checked={state.activeProxyId === 'rules'} className={state.activeProxyId === 'rules' ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.rules.apply')))}>
              <i className="popup-radio" />
              <span><strong>按规则分流</strong><small>{state.proxyRules.filter((rule) => rule.enabled).length} 条启用规则</small></span>
            </button>}
          </div>
        </section>

        {!handoff && <nav className="popup-tools" aria-label="安全测试工具">
          <button onClick={() => void openTool('cookies')}><Cookie size={17} /><span>Cookie</span></button>
          <button onClick={() => void openTool('user-agent')}><UserRoundCog size={17} /><span>User-Agent</span></button>
          <button onClick={() => void openTool('context')}><Braces size={17} /><span>登录态</span></button>
        </nav>}

        <footer className="popup-footer">
          <Button className="popup-capture" variant="primary" disabled={busy || !tab?.url?.startsWith('http')} onClick={() => void capture()}>
            {busy ? <RefreshCw className="spin" size={15} /> : <Radio size={15} />}采集并复制上下文
          </Button>
          {notice && <span className="popup-notice">{notice}</span>}
        </footer>
      </main>
    </TooltipProvider>
  );
}

export default App;
