import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { request } from '@/platform/messaging/runtime';
import type { ExtensionState, ProxyStatus } from '@/types/models';
import type { ProxyViewProps } from './types';
import { Check, Info, Monitor } from 'lucide-react';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import './proxy-status.css';

export function useProxyStatus(state: ExtensionState): ProxyStatus {
  const [status, setStatus] = useState<ProxyStatus>({ control: 'loading', label: '正在读取实际代理…' });
  useEffect(() => {
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const value = await request('proxy.status');
        if (current === revision) setStatus(value);
      } catch {
        if (current === revision) setStatus({ control: 'unavailable', label: '实际代理读取失败' });
      }
    };
    const listener = (message: unknown) => {
      if ((message as { action?: string })?.action === 'proxy.status.changed') void refresh();
    };
    browser.runtime.onMessage.addListener(listener);
    void refresh();
    return () => { revision++; browser.runtime.onMessage.removeListener(listener); };
  }, [state]);
  return status;
}

export function ProxyStatusBar({ status }: { status: ProxyStatus }) {
  const source = status.control === 'controlled_by_this_extension' ? '本扩展控制'
    : status.control === 'controlled_by_other_extensions' ? '其他扩展控制'
    : status.control === 'not_controllable' ? '浏览器限制修改，请检查管理策略'
    : status.control === 'controllable_by_this_extension' ? '非本扩展控制，可选择出口接管' : '状态未确认';
  return <section className="proxy-effective-status" aria-label="实际代理状态" role="status" title={source}>
    <small>实际代理</small><strong title={`${status.label} · ${source}`}>{status.label}</strong>
  </section>;
}

export function StartupProxyOption({ state, status, setState, run, busy }: Pick<ProxyViewProps, 'state' | 'setState' | 'run' | 'busy'> & { status: ProxyStatus }) {
  if (state.bridge.managedInstance?.manager === 'ytray' && state.startupProxy === 'direct') return null;
  const active = Boolean(status.followingStartup);
  const manager = state.bridge.managedInstance?.manager === 'ytray' ? 'YTray' : state.bridge.managedInstance?.manager === 'yakit' ? 'Yakit' : '浏览器';
  const detail = state.startupProxy ? `${manager} · ${state.startupProxy === 'direct' ? '启动时直连' : state.startupProxy}` : `${manager}启动参数或系统默认设置`;
  return <div className={`startup-proxy-option ${active ? 'is-active' : ''}`}>
    <button role="radio" aria-checked={active} disabled={busy || status.control === 'loading' || status.control === 'unavailable'} onClick={() => void run(async () => {
      setState(await request('proxy.release'));
      const actual = await request('proxy.status');
      if (!actual.followingStartup) throw new Error(`未能切换到启动配置；实际代理：${actual.label}。请检查其他扩展或管理策略。`);
    }, '已跟随启动配置')}>
      <span className="startup-proxy-icon"><Monitor size={16} /></span><span className="startup-proxy-label"><strong>跟随启动配置</strong><small title={detail}>{detail}</small></span><span className="startup-proxy-check">{active && <Check size={14} />}</span>
    </button>
    <TooltipProvider><Tooltip label="切换后使用浏览器启动时的网络配置；未指定启动代理时，跟随浏览器默认设置。可随时切换到其他模式，已保存的出口和规则不变。若受其他扩展或管理策略影响，以顶部实际代理为准。" side="top">
      <button className="startup-proxy-info" aria-label="解释跟随启动配置"><Info size={14} /></button>
    </Tooltip></TooltipProvider>
  </div>;
}
