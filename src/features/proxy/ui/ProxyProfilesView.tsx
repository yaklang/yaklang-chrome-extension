import { useEffect, useState } from 'react';
import { ChevronRight, KeyRound, Network, Plus, Power, Save, Trash2 } from 'lucide-react';
import { v7 as uuidv7 } from 'uuid';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { request } from '@/platform/messaging/runtime';
import type { ProxyProfile } from '@/types/models';
import { PROXY_KIND_LABELS, proxyProfileDetail } from './presentation';
import type { ProxyViewProps } from './types';
import './proxy-workspace.css';

function createProfile(): ProxyProfile {
  return {
    id: uuidv7(), name: '新代理出口', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8080, bypass: [],
  };
}

export function ProxyProfilesView({ state, setState, run, busy }: ProxyViewProps) {
  const [draft, setDraft] = useState<ProxyProfile>(() => state.proxyProfiles[0] || createProfile());
  const [password, setPassword] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPassword('');
    setPasswordConfigured(false);
    void request('proxy.auth.status', { profileId: draft.id })
      .then((result) => { if (!cancelled) setPasswordConfigured(result.configured); })
      .catch(() => { if (!cancelled) setPasswordConfigured(false); });
    return () => { cancelled = true; };
  }, [draft.id]);

  const persistDraft = async () => {
    const saved = await request('proxy.save', draft);
    setState(saved);
    if (draft.authEnabled) {
      if (password) await request('proxy.auth.set', { profileId: draft.id, password });
    } else {
      await request('proxy.auth.set', { profileId: draft.id, password: '' });
    }
    setPassword('');
    setPasswordConfigured(Boolean(draft.authEnabled && (password || passwordConfigured)));
    return saved;
  };

  const save = () => run(async () => {
    await persistDraft();
  }, '代理出口已保存');

  const saveAndUse = () => run(async () => {
    await persistDraft();
    setState(await request('proxy.switch', { id: draft.id }));
  }, `${draft.name} 已保存并启用`);

  const remove = () => run(async () => {
    const updated = await request('proxy.delete', { id: draft.id });
    setState(updated);
    setDraft(updated.proxyProfiles[0] || createProfile());
  }, '代理出口已删除');

  return <div className="section-view proxy-page">
    <div className="page-heading proxy-page-heading">
      <div><h1>代理出口</h1><p>维护浏览器可以使用的直连、HTTP、HTTPS、SOCKS 和 PAC 出口。</p></div>
      <Button variant="primary" onClick={() => setDraft(createProfile())}><Plus size={16} />新建出口</Button>
    </div>

    <div className="proxy-profile-workspace">
      <section className="proxy-profile-index" aria-label="代理出口列表">
        <div className="proxy-panel-label"><span>出口</span><strong>{state.proxyProfiles.length}</strong></div>
        <div className="proxy-profile-list">
          {state.proxyProfiles.map((profile) => <button
            key={profile.id}
            className={`${draft.id === profile.id ? 'is-selected' : ''} ${state.activeProxyId === profile.id ? 'is-active' : ''}`}
            onClick={() => setDraft({ ...profile, bypass: [...profile.bypass] })}
          >
            <span className="proxy-profile-icon"><Network size={16} /></span>
            <span><strong>{profile.name}</strong><small>{proxyProfileDetail(profile)}</small></span>
            {state.activeProxyId === profile.id && <i>使用中</i>}
            <ChevronRight size={15} />
          </button>)}
        </div>
      </section>

      <section className="proxy-profile-editor">
        <div className="proxy-editor-heading">
          <div><span>{draft.builtin ? '内置出口' : '自定义出口'}</span><h2>{draft.name}</h2></div>
          <span className={`proxy-live-state ${state.activeProxyId === draft.id ? 'is-live' : ''}`}><i />{state.activeProxyId === draft.id ? '当前生效' : '未使用'}</span>
        </div>
        <div className="proxy-form-grid">
          <Field label="名称"><input value={draft.name} disabled={draft.id === 'direct' || draft.id === 'system'} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="类型"><select value={draft.kind} disabled={draft.builtin} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ProxyProfile['kind'] })}>{Object.entries(PROXY_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          {draft.kind === 'fixed_servers' && <>
            <Field label="协议"><select value={draft.scheme || 'http'} onChange={(event) => setDraft({ ...draft, scheme: event.target.value as ProxyProfile['scheme'] })}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select></Field>
            <Field label="主机"><input value={draft.host || ''} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></Field>
            <Field label="端口"><input type="number" min="1" max="65535" value={draft.port || ''} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></Field>
            <Field label="绕过列表" hint="每行一个域名、IP 或 &lt;local&gt;"><textarea rows={5} value={draft.bypass.join('\n')} onChange={(event) => setDraft({ ...draft, bypass: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></Field>
          </>}
          {draft.kind === 'pac_script' && <>
            <Field label="PAC URL"><input value={draft.pacUrl || ''} onChange={(event) => setDraft({ ...draft, pacUrl: event.target.value, pacScript: '' })} placeholder="https://example.com/proxy.pac" /></Field>
            <Field label="内联 PAC"><textarea rows={10} value={draft.pacScript || ''} onChange={(event) => setDraft({ ...draft, pacScript: event.target.value, pacUrl: '' })} /></Field>
          </>}
        </div>
        {draft.kind === 'fixed_servers' && <section className="proxy-auth-section">
          <label><span><KeyRound size={16} /><span><strong>代理认证</strong><small>{passwordConfigured ? '已保存本次浏览器会话的凭据' : '凭据仅保存在浏览器 session'}</small></span></span><Switch checked={Boolean(draft.authEnabled)} onCheckedChange={(checked) => setDraft({ ...draft, authEnabled: checked })} /></label>
          {draft.authEnabled && <div className="proxy-auth-fields"><Field label="用户名"><input value={draft.authUsername || ''} onChange={(event) => setDraft({ ...draft, authUsername: event.target.value })} /></Field><Field label="密码"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={passwordConfigured ? '留空以保留当前密码' : '输入密码'} /></Field></div>}
        </section>}
        <div className="proxy-editor-actions">
          <Button variant="primary" disabled={busy || !draft.name || (draft.kind === 'fixed_servers' && (!draft.host || !draft.port))} onClick={() => void save()}><Save size={16} />保存</Button>
          <Button disabled={busy || !draft.name || (draft.kind === 'fixed_servers' && (!draft.host || !draft.port))} onClick={() => void saveAndUse()}><Power size={16} />保存并使用</Button>
          {!draft.builtin && <Button variant="danger" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />删除</Button>}
        </div>
      </section>
    </div>
  </div>;
}
