import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Cookie, Copy, Plus, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cookieKey, cookieRemovalInput } from '@/features/cookies/presentation';
import { request } from '@/platform/messaging/runtime';
import type { ActiveTabInfo, BrowserCookie, CookieInput } from '@/types/models';

type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface CookieQuickViewProps {
  tab?: ActiveTabInfo;
  busy: boolean;
  run: RunTask;
  onCountChange: (count: number) => void;
}

function emptyDraft(url = ''): Omit<CookieInput, 'url'> {
  return {
    name: '', value: '', path: '/', secure: url.startsWith('https:'), httpOnly: false, sameSite: 'unspecified',
  };
}

export function CookieQuickView({ tab, busy, run, onCountChange }: CookieQuickViewProps) {
  const url = tab?.url?.startsWith('http') ? tab.url : '';
  const [cookies, setCookies] = useState<BrowserCookie[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Omit<CookieInput, 'url'>>(emptyDraft(url));
  const [editing, setEditing] = useState<BrowserCookie>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(async () => {
    if (!url) {
      setCookies([]);
      onCountChange(0);
      return;
    }
    try {
      const next = await request('cookie.list', { url });
      setCookies(next);
      onCountChange(next.length);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [onCountChange, url]);

  useEffect(() => { void reload(); }, [reload]);

  const visibleCookies = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cookies.filter((cookie) => !needle || [cookie.name, cookie.domain, cookie.path]
      .some((value) => value.toLowerCase().includes(needle)));
  }, [cookies, query]);

  const startNew = () => {
    setEditing(undefined);
    setDraft(emptyDraft(url));
    setEditorOpen(true);
  };
  const startEdit = (cookie: BrowserCookie) => {
    setEditing(cookie);
    setDraft({
      name: cookie.name, value: cookie.value, domain: cookie.hostOnly ? undefined : cookie.domain,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite as CookieInput['sameSite'], expirationDate: cookie.expirationDate,
      storeId: cookie.storeId, firstPartyDomain: cookie.firstPartyDomain, partitionKey: cookie.partitionKey,
    });
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(undefined);
    setDraft(emptyDraft(url));
  };

  const saveCookie = () => run(async () => {
    if (!url || !draft.name) throw new Error('Cookie 名称不能为空');
    await request('cookie.set', { url, ...draft });
    await reload();
    closeEditor();
  }, editing ? 'Cookie 已更新' : 'Cookie 已创建');

  return <section className="popup-view popup-tool-view popup-cookie-view">
    <div className="popup-tool-context"><Cookie size={14} /><span title={url}>{url ? new URL(url).host : '当前页面不可访问'}</span><strong>{cookies.length}</strong></div>

    {editorOpen ? <div className="popup-cookie-editor popup-view-enter">
      <div className="popup-editor-title"><div><strong>{editing ? '编辑 Cookie' : '新增 Cookie'}</strong><span>{editing ? `${editing.domain}${editing.path}` : '默认创建 HostOnly Cookie'}</span></div><Button size="icon" variant="ghost" aria-label="关闭 Cookie 编辑器" onClick={closeEditor}><X size={15} /></Button></div>
      <label><span>名称</span><input autoFocus={!editing} disabled={Boolean(editing)} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="session_id" /></label>
      <label><span>值</span><input value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} /></label>
      <div className="popup-editor-grid"><label><span>Path</span><input disabled={Boolean(editing)} value={draft.path || '/'} onChange={(event) => setDraft({ ...draft, path: event.target.value || '/' })} /></label><label><span>SameSite</span><select value={draft.sameSite} onChange={(event) => setDraft({ ...draft, sameSite: event.target.value as CookieInput['sameSite'] })}><option value="unspecified">Unspecified</option><option value="lax">Lax</option><option value="strict">Strict</option><option value="no_restriction">None</option></select></label></div>
      <div className="popup-cookie-flags"><label><input type="checkbox" checked={draft.secure || false} onChange={(event) => setDraft({ ...draft, secure: event.target.checked })} />Secure</label><label><input type="checkbox" checked={draft.httpOnly || false} onChange={(event) => setDraft({ ...draft, httpOnly: event.target.checked })} />HttpOnly</label></div>
      {editing?.partitionKey && <div className="popup-inline-warning">Partitioned Cookie 将保留现有 top-level site；修改分区请打开完整编辑器。</div>}
      <Button variant="primary" disabled={busy || !url || !draft.name} onClick={() => void saveCookie()}><Check size={15} />{editing ? '保存修改' : '创建 Cookie'}</Button>
    </div> : <>
      <div className="popup-tool-toolbar"><label><Search size={14} /><input aria-label="搜索当前页面 Cookie" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、Domain 或 Path" /></label><Button size="icon" variant="ghost" aria-label="新增 Cookie" title="新增 Cookie" disabled={!url} onClick={startNew}><Plus size={16} /></Button></div>
      <div className="popup-cookie-list popup-view-enter">
        {loadError && <div className="popup-tool-empty">{loadError}</div>}
        {!loadError && visibleCookies.length === 0 && <div className="popup-tool-empty">{cookies.length ? '没有匹配的 Cookie' : '当前页面没有可用 Cookie'}</div>}
        {visibleCookies.map((cookie) => {
          const key = cookieKey(cookie);
          const authRelated = /(auth|token|jwt|session|login|csrf|sid)/i.test(cookie.name);
          return <article className="popup-cookie-row" key={key}>
            <button className="popup-cookie-main" onClick={() => startEdit(cookie)}><span><strong>{cookie.name}</strong>{authRelated && <i>认证</i>}</span><code title={cookie.value}>{cookie.value}</code><small>{cookie.domain}{cookie.path}</small></button>
            <div className="popup-cookie-meta">{cookie.httpOnly && <i>HttpOnly</i>}{cookie.secure && <i>Secure</i>}{cookie.partitionKey && <i>CHIPS</i>}</div>
            <div className="popup-cookie-actions"><button aria-label={`复制 ${cookie.name}`} onClick={() => void run(async () => navigator.clipboard.writeText(`${cookie.name}=${cookie.value}`), 'Cookie 已复制')}><Copy size={14} /></button><button className="danger" aria-label={`删除 ${cookie.name}`} onClick={() => void run(async () => { await request('cookie.remove', cookieRemovalInput(cookie)); await reload(); }, 'Cookie 已删除')}><Trash2 size={14} /></button></div>
          </article>;
        })}
      </div>
      <div className="popup-tool-footer"><button disabled={!cookies.length || busy} onClick={() => { if (window.confirm(`删除当前页面可用的 ${cookies.length} 个 Cookie？`)) void run(async () => { await request('cookie.removeMany', { cookies: cookies.map(cookieRemovalInput) }); await reload(); }, '当前页面 Cookie 已清理'); }}><Trash2 size={14} />清理当前页面</button></div>
    </>}
  </section>;
}
