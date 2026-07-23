import { useCallback, useEffect, useState } from 'react';
import { Bot, Laptop, RefreshCw, Save, Smartphone, UserRoundCog, X } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, ExtensionState, UserAgentProfile, UserAgentProfileCategory, UserAgentResolution,
} from '@/types/models';

const BROWSER_DEFAULT = '__browser_default__';
type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface UserAgentQuickViewProps {
  tab?: ActiveTabInfo;
  state: ExtensionState;
  setState: (state: ExtensionState) => void;
  busy: boolean;
  run: RunTask;
  onResolutionChange: (resolution?: UserAgentResolution) => void;
}

function categoryIcon(category: UserAgentProfileCategory) {
  if (category === 'mobile') return <Smartphone size={15} />;
  if (category === 'bot') return <Bot size={15} />;
  if (category === 'custom') return <UserRoundCog size={15} />;
  return <Laptop size={15} />;
}

export function UserAgentQuickView({ tab, state, setState, busy, run, onResolutionChange }: UserAgentQuickViewProps) {
  const url = tab?.url?.startsWith('http') ? tab.url : '';
  const [profiles, setProfiles] = useState<UserAgentProfile[]>([]);
  const [resolution, setResolution] = useState<UserAgentResolution>();
  const [selectedProfileId, setSelectedProfileId] = useState(BROWSER_DEFAULT);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customValue, setCustomValue] = useState('');
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    if (!url) {
      setProfiles(await request('ua.catalog'));
      setResolution(undefined);
      onResolutionChange(undefined);
      return;
    }
    try {
      const [nextProfiles, nextResolution] = await Promise.all([request('ua.catalog'), request('ua.resolve', { url })]);
      setProfiles(nextProfiles);
      setResolution(nextResolution);
      setSelectedProfileId(nextResolution.profile?.id || BROWSER_DEFAULT);
      onResolutionChange(nextResolution);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [onResolutionChange, url]);
  useEffect(() => { void load(); }, [load, state.customUserAgentProfiles, state.userAgentAssignments]);

  const applyAndReload = () => run(async () => {
    if (!tab || !url) throw new Error('当前页面不能修改 User-Agent');
    const next = selectedProfileId === BROWSER_DEFAULT
      ? await request('ua.site.reset', { url })
      : await request('ua.site.apply', { url, profileId: selectedProfileId });
    setState(next);
    const resolved = await request('ua.resolve', { url });
    setResolution(resolved);
    onResolutionChange(resolved);
    await browser.tabs.reload(tab.id);
  }, selectedProfileId === BROWSER_DEFAULT ? '已恢复浏览器默认 UA 并刷新页面' : 'User-Agent 已应用并刷新页面');

  const saveCustomAndApply = () => run(async () => {
    if (!tab || !url) throw new Error('当前页面不能修改 User-Agent');
    const profile = await request('ua.profile.save', { name: customName, userAgent: customValue });
    const next = await request('ua.site.apply', { url, profileId: profile.id });
    setState(next);
    setProfiles(await request('ua.catalog'));
    setSelectedProfileId(profile.id);
    const resolved = await request('ua.resolve', { url });
    setResolution(resolved);
    onResolutionChange(resolved);
    setCustomOpen(false);
    setCustomName('');
    setCustomValue('');
    await browser.tabs.reload(tab.id);
  }, '自定义 User-Agent 已保存、应用并刷新页面');

  return <section className="popup-view popup-tool-view popup-ua-view">
    <div className="popup-tool-context"><UserRoundCog size={14} /><span>{resolution?.hostname || (url ? new URL(url).hostname : '当前页面不可访问')}</span><strong>{resolution?.mode === 'override' ? '已覆盖' : '默认'}</strong></div>
    <div className="popup-ua-current"><span>当前生效</span><strong>{resolution?.profile?.name || '浏览器默认'}</strong><code title={resolution?.userAgent}>{resolution?.userAgent || navigator.userAgent}</code><small>仅修改网络请求头，不等于完整设备指纹伪装。</small></div>
    {customOpen ? <div className="popup-ua-custom popup-view-enter"><div className="popup-editor-title"><div><strong>自定义 User-Agent</strong><span>保存为预设并应用到当前 hostname</span></div><Button size="icon" variant="ghost" aria-label="关闭自定义 UA" onClick={() => setCustomOpen(false)}><X size={15} /></Button></div><label><span>预设名称</span><input autoFocus value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="API Client" /></label><label><span>User-Agent</span><textarea rows={5} value={customValue} onChange={(event) => setCustomValue(event.target.value)} placeholder="Custom-Agent/1.0" /></label><Button variant="primary" disabled={busy || !customName.trim() || !customValue.trim()} onClick={() => void saveCustomAndApply()}><Save size={15} />保存、应用并刷新</Button></div> : <>
      <div className="popup-ua-list popup-view-enter" role="radiogroup" aria-label="User-Agent 预设">
        <button role="radio" aria-checked={selectedProfileId === BROWSER_DEFAULT} className={selectedProfileId === BROWSER_DEFAULT ? 'is-selected' : ''} onClick={() => setSelectedProfileId(BROWSER_DEFAULT)}><span className="popup-ua-icon"><RefreshCw size={15} /></span><span><strong>浏览器默认</strong><small>移除当前站点覆盖</small></span><i /></button>
        {profiles.map((profile) => <button role="radio" aria-checked={selectedProfileId === profile.id} className={selectedProfileId === profile.id ? 'is-selected' : ''} key={profile.id} onClick={() => setSelectedProfileId(profile.id)}><span className="popup-ua-icon">{categoryIcon(profile.category)}</span><span><strong>{profile.name}</strong><small>{profile.builtin ? profile.category === 'mobile' ? '移动设备模板' : profile.category === 'bot' ? '爬虫模板' : '桌面设备模板' : '自定义预设'}</small></span><i /></button>)}
      </div>
      {loadError && <div className="popup-inline-warning">{loadError}</div>}
      <div className="popup-ua-actions"><Button variant="ghost" disabled={!url || busy} onClick={() => setCustomOpen(true)}>自定义…</Button><Button variant="primary" disabled={!url || busy || selectedProfileId === (resolution?.profile?.id || BROWSER_DEFAULT)} onClick={() => void applyAndReload()}><RefreshCw size={15} />应用并刷新</Button></div>
    </>}
  </section>;
}
