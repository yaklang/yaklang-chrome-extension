import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Globe2, LoaderCircle, Network, Route } from 'lucide-react';
import { request } from '@/platform/messaging/runtime';
import type { ActiveTabInfo, ExtensionState, ProxyProfile, ProxyRulePreview } from '@/types/models';

type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface ProxyQuickViewProps {
  state: ExtensionState;
  setState: (state: ExtensionState) => void;
  busy: boolean;
  run: RunTask;
  tab?: ActiveTabInfo;
  onOpenFull: () => void;
}

const AUTOMATIC_TARGET = '__automatic__';
const CURRENT_GLOBAL_TARGET = '__current_global__';

type SiteApplyStatus = 'idle' | 'applying' | 'success' | 'error';

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

function hostname(url?: string): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ''; } catch { return ''; }
}

function routeKindLabel(preview?: ProxyRulePreview): string {
  if (preview?.matchedKind === 'manual') return '站点覆盖';
  if (preview?.matchedKind === 'source') return '规则订阅';
  return '自动判断';
}

export function ProxyQuickView({ state, setState, busy, run, tab, onOpenFull }: ProxyQuickViewProps) {
  const [preview, setPreview] = useState<ProxyRulePreview>();
  const currentHostname = hostname(tab?.url);
  const autoActive = state.activeProxyId === 'auto';
  const activeProfile = state.proxyProfiles.find((profile) => profile.id === state.activeProxyId);
  const routableProfiles = useMemo(
    () => state.proxyProfiles.filter((profile) => profile.kind === 'direct' || profile.kind === 'fixed_servers'),
    [state.proxyProfiles],
  );
  const siteRule = useMemo(() => [...state.proxyRules]
    .sort((left, right) => left.order - right.order)
    .find((rule) => rule.enabled && rule.condition.type === 'host_exact'
      && rule.condition.value.toLowerCase() === currentHostname), [currentHostname, state.proxyRules]);
  const persistedTarget = siteRule?.proxyProfileId || AUTOMATIC_TARGET;
  const [siteTarget, setSiteTarget] = useState(autoActive ? persistedTarget : CURRENT_GLOBAL_TARGET);
  const [siteApplyStatus, setSiteApplyStatus] = useState<SiteApplyStatus>('idle');
  const [siteApplyMessage, setSiteApplyMessage] = useState('');
  const sourceRuleCount = state.proxyRuleSources
    .filter((source) => source.enabled && source.revision)
    .reduce((total, source) => total + source.supportedRuleCount, 0);

  useEffect(() => {
    setSiteTarget(autoActive
      ? routableProfiles.some((profile) => profile.id === persistedTarget) ? persistedTarget : AUTOMATIC_TARGET
      : CURRENT_GLOBAL_TARGET);
  }, [autoActive, persistedTarget, routableProfiles]);

  useEffect(() => {
    setSiteApplyStatus('idle');
    setSiteApplyMessage('');
  }, [currentHostname]);

  useEffect(() => {
    if (siteApplyStatus !== 'success' && siteApplyStatus !== 'error') return undefined;
    const timer = globalThis.setTimeout(() => {
      setSiteApplyStatus('idle');
      setSiteApplyMessage('');
    }, 2_400);
    return () => globalThis.clearTimeout(timer);
  }, [siteApplyStatus]);

  useEffect(() => {
    if (!tab?.url?.startsWith('http')) {
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    void request('proxy.rules.preview', { url: tab.url })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch(() => { if (!cancelled) setPreview(undefined); });
    return () => { cancelled = true; };
  }, [tab?.url, state.proxyRuntime.revision, state.proxyRuntime.dirty]);

  const switchAuto = () => run(async () => {
    setState(await request('proxy.auto.apply'));
    if (tab?.url) setPreview(await request('proxy.rules.preview', { url: tab.url }));
  }, '自动切换已启用');

  const applySiteRoute = (nextTarget: string) => {
    if (!tab?.url || nextTarget === CURRENT_GLOBAL_TARGET) return Promise.resolve();
    const previousTarget = autoActive ? persistedTarget : CURRENT_GLOBAL_TARGET;
    const nextProfile = routableProfiles.find((profile) => profile.id === nextTarget);
    setSiteTarget(nextTarget);
    setSiteApplyStatus('applying');
    setSiteApplyMessage(nextTarget === AUTOMATIC_TARGET
      ? '正在恢复自动判断…'
      : `正在切换到 ${nextProfile?.name || '所选出口'}…`);
    return run(async () => {
      try {
        const updated = nextTarget === AUTOMATIC_TARGET
          ? await request('proxy.site.route.clear', { url: tab.url! })
          : await request('proxy.site.route', { url: tab.url!, profileId: nextTarget });
        setState(updated);
        setPreview(await request('proxy.rules.preview', { url: tab.url! }).catch(() => undefined));
        setSiteApplyStatus('success');
        setSiteApplyMessage(nextTarget === AUTOMATIC_TARGET
          ? '已恢复自动判断'
          : `已应用 · ${nextProfile?.name || '所选出口'}`);
      } catch (error) {
        setSiteTarget(previousTarget);
        setSiteApplyStatus('error');
        setSiteApplyMessage('切换失败，已恢复原设置');
        throw error;
      }
    });
  };

  const effectiveProfile = state.proxyProfiles.find((profile) => profile.id === preview?.effectiveProfileId);
  const activeModeName = autoActive ? '自动切换' : activeProfile?.name || '未选择';
  const siteHint = !autoActive
    ? `当前使用“${activeModeName}”；选择网站出口后将启用自动切换。`
    : siteTarget === AUTOMATIC_TARGET
      ? '不创建手动覆盖，由订阅源和默认出口决定。'
      : `最高优先级的精确主机规则，只影响 ${currentHostname}。`;
  const routeLabel = autoActive ? preview?.matchedName || '正在解析路由' : '当前全局模式';
  const routeProfile = autoActive ? effectiveProfile : activeProfile;
  const routeKind = autoActive ? preview?.matchedKind || 'default' : 'global';
  const routeKindText = autoActive ? routeKindLabel(preview) : '全局模式';

  return <section className="popup-view popup-tool-view popup-proxy-view">
    {currentHostname ? <section className="popup-site-router" aria-label="当前站点路由">
      <div className="popup-site-router__heading">
        <div><Globe2 size={16} /><span><small>当前站点</small><strong title={currentHostname}>{currentHostname}</strong></span></div>
        <i className={routeKind}>{routeKindText}</i>
      </div>
      <div className="popup-site-decision" title={autoActive ? preview?.matchedCondition : activeModeName}>
        <span>{routeLabel}</span><i>→</i><strong>{routeProfile?.name || '—'}</strong>
      </div>
      <div className="popup-site-picker">
        <label htmlFor="popup-site-proxy">网站出口 <span>选择后立即生效</span></label>
        <select id="popup-site-proxy" aria-label="当前站点代理出口" value={siteTarget} disabled={busy} aria-busy={siteApplyStatus === 'applying'} onChange={(event) => void applySiteRoute(event.target.value)}>
          {!autoActive && <option value={CURRENT_GLOBAL_TARGET}>当前全局模式 · {activeModeName}</option>}
          <option value={AUTOMATIC_TARGET}>跟随自动规则 · 清除站点覆盖</option>
          {routableProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {proxyDetail(profile)}</option>)}
        </select>
      </div>
      <div className={`popup-site-status is-${siteApplyStatus}`} role="status" aria-live="polite">
        {siteApplyStatus === 'applying' && <LoaderCircle size={13} className="spin" />}
        {siteApplyStatus === 'success' && <Check size={13} />}
        {siteApplyStatus === 'error' && <AlertCircle size={13} />}
        <small>{siteApplyMessage || siteHint}</small>
      </div>
    </section> : <div className="popup-proxy-unavailable"><Globe2 size={17} /><span><strong>当前页面无法设置站点路由</strong><small>请切换到 HTTP(S) 页面。</small></span></div>}

    <div className="popup-mode-heading"><span><strong>浏览器模式</strong><small>全局切换，不会创建站点规则</small></span><i>{activeModeName}</i></div>
    <div className="popup-proxy-list popup-proxy-list--view" role="radiogroup" aria-label="浏览器代理模式">
      <button role="radio" aria-checked={autoActive} className={autoActive ? 'is-active' : ''} disabled={busy} onClick={() => void switchAuto()}>
        <span className="popup-mode-icon"><Route size={15} /></span>
        <span><strong>自动切换</strong><small>{state.proxyRules.filter((rule) => rule.enabled).length} 条手动 · {sourceRuleCount.toLocaleString()} 条订阅</small></span>
        {state.proxyRuntime.dirty ? <em>待应用</em> : autoActive ? <Check size={14} /> : null}
      </button>
      {state.proxyProfiles.map((profile) => {
        const active = state.activeProxyId === profile.id;
        return <button key={profile.id} role="radio" aria-checked={active} className={active ? 'is-active' : ''} disabled={busy} onClick={() => void run(async () => setState(await request('proxy.switch', { id: profile.id })), `${profile.name} 已作为全局模式启用`)}>
          <span className="popup-mode-icon"><Network size={15} /></span>
          <span><strong>{profile.name}</strong><small>{proxyDetail(profile)}</small></span>
          {active && <Check size={14} />}
        </button>;
      })}
    </div>
    <div className="popup-tool-footer"><span>{state.proxyProfiles.length} 个出口 · {state.proxyRuleSources.length} 个订阅</span><button onClick={onOpenFull}><ExternalLink size={13} />管理策略</button></div>
  </section>;
}
