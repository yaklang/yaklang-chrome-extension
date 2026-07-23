import { Braces, ChevronRight, Cookie, Network, Radio, ShieldCheck, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { request } from '@/platform/messaging/runtime';
import { READ_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import type { ActiveTabInfo, ExtensionState, UserAgentResolution } from '@/types/models';

type PopupView = 'home' | 'proxy' | 'cookies' | 'user-agent';
type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface OverviewQuickViewProps {
  state: ExtensionState;
  tab?: ActiveTabInfo;
  grantActive: boolean;
  busy: boolean;
  run: RunTask;
  setState: (state: ExtensionState) => void;
  cookieCount: number;
  uaResolution?: UserAgentResolution;
  onNavigate: (view: PopupView) => void;
  onOpenContext: () => void;
  onCapture: () => void;
}

export function OverviewQuickView({
  state, tab, grantActive, busy, run, setState, cookieCount, uaResolution, onNavigate, onOpenContext, onCapture,
}: OverviewQuickViewProps) {
  const activeProxy = state.activeProxyId === 'auto'
    ? '自动切换'
    : state.proxyProfiles.find((profile) => profile.id === state.activeProxyId)?.name || '未选择';
  const targetAvailable = Boolean(tab?.url?.startsWith('http'));

  return <section className="popup-overview-view">
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

    <div className="popup-overview-lead">
      <div className="popup-overview-lead__meta"><strong className={targetAvailable ? '' : 'is-unavailable'}><i />{targetAvailable ? '页面已就绪' : '页面不可访问'}</strong><span>{targetAvailable ? '从这里快速查看和调整当前标签页' : '切换到 HTTP(S) 页面后可使用浏览器工具'}</span></div>
    </div>

    <section className="popup-overview-summary" aria-label="当前页面状态">
      <button onClick={() => onNavigate('proxy')}>
        <span className="popup-overview-icon"><Network size={16} /></span>
        <span><small>当前代理</small><strong>{activeProxy}</strong></span>
        <ChevronRight size={15} />
      </button>
      <button onClick={() => onNavigate('user-agent')}>
        <span className="popup-overview-icon"><UserRoundCog size={16} /></span>
        <span><small>当前 User-Agent</small><strong>{uaResolution?.profile?.name || '浏览器默认'}</strong></span>
        <ChevronRight size={15} />
      </button>
      <button onClick={() => onNavigate('cookies')}>
        <span className="popup-overview-icon"><Cookie size={16} /></span>
        <span><small>当前页面 Cookie</small><strong>{targetAvailable ? `${cookieCount} 个可用 Cookie` : '当前页面不可用'}</strong></span>
        <ChevronRight size={15} />
      </button>
      <button onClick={onOpenContext}>
        <span className="popup-overview-icon"><Braces size={16} /></span>
        <span><small>登录态工作区</small><strong>Storage、数据库与页面上下文</strong></span>
        <ChevronRight size={15} />
      </button>
    </section>

    <footer className="popup-footer">
      <Button className="popup-capture" variant="primary" disabled={busy || !targetAvailable} onClick={onCapture}>
        {busy ? <Radio className="spin" size={15} /> : <Radio size={15} />}采集并复制上下文
      </Button>
    </footer>
  </section>;
}
