import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, CloudDownload, Download, FileText, Plus, RefreshCw,
  Search, Trash2, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { request } from '@/platform/messaging/runtime';
import type {
  ProxyConfiguration, ProxyRulePage, ProxyRuleSource, ProxyRuleSourceFormat, ProxyRuleSourceInput,
} from '@/types/models';
import { CONDITION_LABELS, relativeTime, SOURCE_FORMAT_LABELS } from './presentation';
import type { ProxyViewProps } from './types';
import './proxy-workspace.css';

const PAGE_SIZE = 100;

function sourceDraft(state: ProxyViewProps['state'], source?: ProxyRuleSource): ProxyRuleSourceInput {
  return source ? {
    id: source.id,
    name: source.name,
    url: source.url,
    format: source.format,
    enabled: source.enabled,
    matchProfileId: source.matchProfileId,
    bypassProfileId: source.bypassProfileId,
    order: source.order,
    updateIntervalMinutes: source.updateIntervalMinutes,
  } : {
    name: 'GitHub 规则订阅',
    url: '',
    format: 'auto',
    enabled: true,
    matchProfileId: state.proxyProfiles.some((profile) => profile.id === 'yakit-mitm') ? 'yakit-mitm' : 'direct',
    bypassProfileId: 'direct',
    order: state.proxyRuleSources.length,
    updateIntervalMinutes: 720,
  };
}

function sourceStatusLabel(source: ProxyRuleSource): string {
  if (source.status === 'updating') return '正在更新';
  if (source.status === 'error') return source.revision ? '使用上一版本' : '更新失败';
  if (source.status === 'ready') return '可用';
  return '尚未下载';
}

export function RuleSourcesView({ state, setState, run, busy }: ProxyViewProps) {
  const routableProfiles = useMemo(() => state.proxyProfiles.filter((profile) => ['direct', 'fixed_servers'].includes(profile.kind)), [state.proxyProfiles]);
  const orderedSources = useMemo(() => [...state.proxyRuleSources].sort((left, right) => left.order - right.order), [state.proxyRuleSources]);
  const [selectedId, setSelectedId] = useState(orderedSources[0]?.id || '');
  const selected = state.proxyRuleSources.find((source) => source.id === selectedId);
  const [draft, setDraft] = useState<ProxyRuleSourceInput>(() => sourceDraft(state, selected));
  const [page, setPage] = useState<ProxyRulePage>();
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(sourceDraft(state, selected));
    setQuery('');
    setOffset(0);
  }, [selectedId]);

  useEffect(() => {
    if (!selected?.revision) {
      setPage(undefined);
      return undefined;
    }
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      void request('proxy.source.rules', { id: selected.id, offset, limit: PAGE_SIZE, query: query || undefined })
        .then((next) => { if (!cancelled) setPage(next); })
        .catch(() => { if (!cancelled) setPage(undefined); });
    }, 180);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [selected?.id, selected?.revision, offset, query]);

  const reorderSource = (index: number, delta: -1 | 1) => run(async () => {
    const target = index + delta;
    if (target < 0 || target >= orderedSources.length) return;
    const ids = orderedSources.map((source) => source.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setState(await request('proxy.sources.reorder', { ids }));
  }, '订阅匹配顺序已更新');

  const saveAndRefresh = () => run(async () => {
    const saved = await request('proxy.source.save', draft);
    setSelectedId(saved.id);
    try {
      setState(await request('proxy.source.refresh', { id: saved.id }));
    } catch (error) {
      setState(await request('state.get'));
      throw error;
    }
  }, '规则源已更新');

  const downloadConfiguration = () => run(async () => {
    const configuration = await request('proxy.config.export');
    const href = URL.createObjectURL(new Blob([JSON.stringify(configuration, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `yakit-proxy-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(href);
  }, '代理配置已导出');

  const importConfiguration = (file?: File) => run(async () => {
    if (!file) return;
    const configuration = JSON.parse(await file.text()) as ProxyConfiguration;
    setState(await request('proxy.config.import', { configuration }));
    setSelectedId('');
  }, '代理配置已导入');

  return <div className="section-view proxy-page">
    <div className="page-heading proxy-page-heading">
      <div><h1>规则订阅</h1><p>从 GitHub 或任意 HTTP(S) 地址更新规则；下载失败时继续使用上一份可用版本。</p></div>
      <div className="proxy-heading-actions">
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importConfiguration(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        <Button onClick={() => importRef.current?.click()}><Upload size={15} />导入</Button>
        <Button onClick={() => void downloadConfiguration()}><Download size={15} />导出</Button>
        <Button variant="primary" onClick={() => { setSelectedId(''); setDraft(sourceDraft(state)); }}><Plus size={15} />添加订阅</Button>
      </div>
    </div>

    <div className="proxy-source-workspace">
      <section className="proxy-source-index">
        <div className="proxy-panel-label"><span>订阅源</span><strong>{orderedSources.length}</strong></div>
        {orderedSources.length === 0 ? <div className="proxy-source-empty"><CloudDownload size={24} /><strong>尚无规则订阅</strong><span>添加 GitHub raw、AutoProxy 或域名列表。</span></div> : <div className="proxy-source-list">{orderedSources.map((source, index) => <div key={source.id} className={`proxy-source-item ${selectedId === source.id ? 'is-selected' : ''}`}>
          <button className="proxy-source-select" onClick={() => setSelectedId(source.id)}>
            <span className={`proxy-source-status ${source.status}`}><i /></span>
            <span><strong>{source.name}</strong><small>{source.supportedRuleCount.toLocaleString()} 条 · {relativeTime(source.lastUpdatedAt)}</small></span>
            <i>{sourceStatusLabel(source)}</i>
            <ChevronRight size={15} />
          </button>
          <span className="proxy-source-order"><Button size="icon" variant="ghost" aria-label="上移规则源" disabled={index === 0 || busy} onClick={() => void reorderSource(index, -1)}><ArrowUp size={13} /></Button><Button size="icon" variant="ghost" aria-label="下移规则源" disabled={index === orderedSources.length - 1 || busy} onClick={() => void reorderSource(index, 1)}><ArrowDown size={13} /></Button></span>
        </div>)}</div>}
      </section>

      <section className="proxy-source-main">
        <div className="proxy-source-editor">
          <div className="proxy-editor-heading"><div><span>{selected ? '订阅设置' : '新规则订阅'}</span><h2>{draft.name || '未命名订阅'}</h2></div><label className="proxy-inline-switch"><span>{draft.enabled ? '参与匹配' : '已停用'}</span><Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></label></div>
          <div className="proxy-source-form">
            <Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
            <Field label="订阅地址" hint="GitHub blob 地址会自动转换为 raw 地址"><input value={draft.url} placeholder="https://github.com/user/repo/blob/main/rules.txt" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></Field>
            <Field label="格式"><select value={draft.format} onChange={(event) => setDraft({ ...draft, format: event.target.value as ProxyRuleSourceFormat })}>{Object.entries(SOURCE_FORMAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            <Field label="匹配出口"><select value={draft.matchProfileId} onChange={(event) => setDraft({ ...draft, matchProfileId: event.target.value })}>{routableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
            <Field label="排除出口"><select value={draft.bypassProfileId} onChange={(event) => setDraft({ ...draft, bypassProfileId: event.target.value })}>{routableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
            <Field label="更新周期"><select value={draft.updateIntervalMinutes} onChange={(event) => setDraft({ ...draft, updateIntervalMinutes: Number(event.target.value) })}><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option><option value="10080">每周</option></select></Field>
          </div>
          {selected?.error && <div className={`proxy-source-message ${selected.status === 'error' ? 'is-error' : 'is-warning'}`}><AlertTriangle size={15} /><span>{selected.error}</span></div>}
          <div className="proxy-editor-actions">
            <Button variant="primary" disabled={busy || !draft.name.trim() || !draft.url.trim()} onClick={() => void saveAndRefresh()}>{selected?.status === 'updating' ? <RefreshCw className="spin" size={15} /> : <CloudDownload size={15} />}保存并更新</Button>
            {selected && <Button disabled={busy} onClick={() => void run(async () => setState(await request('proxy.source.refresh', { id: selected.id })), '规则源已更新')}><RefreshCw size={15} />立即更新</Button>}
            {selected && <Button variant="danger" disabled={busy} onClick={() => void run(async () => { const next = await request('proxy.source.delete', { id: selected.id }); setState(next); const nextId = next.proxyRuleSources[0]?.id || ''; setSelectedId(nextId); setDraft(sourceDraft(next, next.proxyRuleSources.find((source) => source.id === nextId))); }, '规则源已删除')}><Trash2 size={15} />删除</Button>}
          </div>
        </div>

        {selected && <section className="proxy-source-rules">
          <div className="proxy-source-rules-heading">
            <div><span>规范化规则</span><strong>{(page?.total ?? selected.supportedRuleCount).toLocaleString()}</strong></div>
            <label><Search size={14} /><input value={query} placeholder="搜索当前规则源" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
          </div>
          <div className="proxy-source-stats"><span><CheckCircle2 size={13} />{selected.supportedRuleCount.toLocaleString()} 有效</span><span>{selected.ignoredRuleCount.toLocaleString()} 忽略</span><span className={selected.invalidRuleCount ? 'is-warning' : ''}>{selected.invalidRuleCount.toLocaleString()} 无效</span><span>{SOURCE_FORMAT_LABELS[selected.format]}</span></div>
          <div className="proxy-source-rule-head"><span>#</span><span>类型</span><span>条件</span><span>结果</span></div>
          {!page ? <div className="proxy-source-rule-loading"><RefreshCw className="spin" size={16} />正在读取 IndexedDB</div> : page.rules.length === 0 ? <div className="proxy-source-rule-loading"><FileText size={18} />没有符合条件的规则</div> : <div className="proxy-source-rule-list">{page.rules.map((rule) => <div key={`${rule.sourceId}:${rule.ordinal}`}>
            <span>{rule.ordinal + 1}</span><span>{CONDITION_LABELS[rule.condition.type]}</span><code title={rule.raw}>{rule.condition.value}</code><i className={rule.exception ? 'is-exception' : ''}>{rule.exception ? state.proxyProfiles.find((profile) => profile.id === selected.bypassProfileId)?.name : rule.resultProfileName || state.proxyProfiles.find((profile) => profile.id === selected.matchProfileId)?.name}</i>
          </div>)}</div>}
          <div className="proxy-source-pagination"><span>{page ? page.total === 0 ? '0 / 0' : `${page.offset + 1}-${Math.min(page.offset + page.limit, page.total)} / ${page.total.toLocaleString()}` : '—'}</span><div><Button size="icon" variant="ghost" aria-label="上一页" disabled={!page || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={15} /></Button><Button size="icon" variant="ghost" aria-label="下一页" disabled={!page || offset + PAGE_SIZE >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)}><ChevronRight size={15} /></Button></div></div>
        </section>}
      </section>
    </div>
  </div>;
}
