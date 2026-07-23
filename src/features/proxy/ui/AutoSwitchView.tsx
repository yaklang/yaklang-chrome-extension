import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, CircleDot, Gauge, Plus, Route, Save, Search, Trash2, Zap,
} from 'lucide-react';
import { v7 as uuidv7 } from 'uuid';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { request } from '@/platform/messaging/runtime';
import type { ProxyConditionType, ProxyRule, ProxyRulePreview } from '@/types/models';
import { CONDITION_LABELS, formatBytes, proxyProfileDetail } from './presentation';
import type { ProxyViewProps } from './types';
import './proxy-workspace.css';

const ROW_HEIGHT = 58;
const LIST_HEIGHT = 408;
const OVERSCAN = 4;

function hostFromUrl(url?: string): string {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}

function freshRule(count: number, url?: string): ProxyRule {
  const now = Date.now();
  const hostname = hostFromUrl(url);
  return {
    id: uuidv7(),
    name: hostname ? `${hostname} 路由` : '新路由规则',
    enabled: true,
    condition: { type: hostname ? 'host_exact' : 'host_suffix', value: hostname },
    proxyProfileId: 'yakit-mitm',
    order: count,
    createdAt: now,
    updatedAt: now,
  };
}

function conditionHint(type: ProxyConditionType): string {
  if (type === 'host_exact') return 'api.example.com';
  if (type === 'host_suffix') return 'example.com';
  if (type === 'host_wildcard') return '*.example.com';
  if (type === 'host_regex') return '(^|\\.)example\\.(com|net)$';
  if (type === 'url_prefix') return 'https://example.com/api/';
  if (type === 'url_wildcard') return '*://*.example.com/*';
  if (type === 'url_regex') return '^https://example\\.com/';
  return 'login';
}

export function AutoSwitchView({ state, setState, run, busy, tab }: ProxyViewProps) {
  const rules = useMemo(() => [...state.proxyRules].sort((left, right) => left.order - right.order), [state.proxyRules]);
  const routableProfiles = useMemo(() => state.proxyProfiles.filter((profile) => ['direct', 'fixed_servers'].includes(profile.kind)), [state.proxyProfiles]);
  const [draft, setDraft] = useState<ProxyRule>(() => freshRule(state.proxyRules.length, tab?.url));
  const [previewUrl, setPreviewUrl] = useState(tab?.url || 'https://example.com/');
  const [preview, setPreview] = useState<ProxyRulePreview>();
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab?.url?.startsWith('http')) setPreviewUrl(tab.url);
  }, [tab?.url]);

  const selectedExists = rules.some((rule) => rule.id === draft.id);
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const visibleRules = rules.slice(firstVisible, firstVisible + visibleCount);
  const enabledSources = state.proxyRuleSources.filter((source) => source.enabled && source.revision);
  const active = state.activeProxyId === 'auto';

  const save = () => run(async () => {
    const now = Date.now();
    const next = { ...draft, updatedAt: now, createdAt: draft.createdAt || now, order: selectedExists ? draft.order : rules.length };
    const updated = await request('proxy.rule.save', next);
    setState(updated);
    setDraft(updated.proxyRules.find((rule) => rule.id === next.id) || next);
  }, '规则已保存，等待应用');

  const reorder = (rule: ProxyRule, delta: -1 | 1) => run(async () => {
    const index = rules.findIndex((item) => item.id === rule.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= rules.length) return;
    const ids = rules.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setState(await request('proxy.rules.reorder', { ids }));
  });

  const explain = () => run(async () => setPreview(await request('proxy.rules.preview', { url: previewUrl })));
  const quickRoute = (profileId: string) => run(async () => {
    if (!tab?.url) return;
    setState(await request('proxy.site.route', { url: tab.url, profileId }));
    setPreview(await request('proxy.rules.preview', { url: tab.url }));
  }, '当前站点规则已创建并应用');

  return <div className="section-view proxy-page">
    <div className="page-heading proxy-page-heading">
      <div><h1>自动切换</h1><p>手动规则优先，随后按顺序匹配订阅源，未命中时使用默认出口。</p></div>
      <Button variant="primary" disabled={busy || (!state.proxyRuntime.dirty && active)} onClick={() => void run(async () => setState(await request('proxy.auto.apply')), '自动切换已应用')}><Zap size={16} />{active && !state.proxyRuntime.dirty ? '已应用' : '应用自动切换'}</Button>
    </div>

    <section className={`proxy-apply-band ${active ? 'is-active' : ''} ${state.proxyRuntime.dirty ? 'is-dirty' : ''}`}>
      <div className="proxy-mode-state"><span><i />{active ? '自动切换运行中' : '自动切换未启用'}</span><strong>{state.proxyRuntime.dirty ? '存在未应用的更改' : state.proxyRuntime.appliedAt ? '配置与浏览器一致' : '尚未生成 PAC'}</strong></div>
      <Field label="默认出口"><select value={state.proxyRouting.defaultProfileId} onChange={(event) => void run(async () => setState(await request('proxy.rules.settings', { ...state.proxyRouting, defaultProfileId: event.target.value })), '默认出口已更新')}>{routableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>
      <Field label="代理失败"><select value={state.proxyRouting.failMode} onChange={(event) => void run(async () => setState(await request('proxy.rules.settings', { ...state.proxyRouting, failMode: event.target.value as 'open' | 'closed' })), '失败策略已更新')}><option value="closed">保持失败</option><option value="open">回退到 DIRECT</option></select></Field>
      <div className="proxy-compile-metrics"><span><strong>{state.proxyRuntime.manualRuleCount}</strong> 手动</span><span><strong>{state.proxyRuntime.sourceRuleCount}</strong> 订阅</span><span><strong>{formatBytes(state.proxyRuntime.compiledBytes)}</strong> PAC</span></div>
    </section>

    {state.proxyRuntime.error && <div className="proxy-runtime-alert"><AlertTriangle size={16} /><span><strong>上一轮应用失败</strong>{state.proxyRuntime.error}</span></div>}

    <section className="proxy-route-probe">
      <div className="proxy-probe-input"><Search size={15} /><input value={previewUrl} onChange={(event) => setPreviewUrl(event.target.value)} placeholder="输入 URL 检查路由" /><Button size="sm" onClick={() => void explain()}>解释路由</Button></div>
      {preview ? <div className="proxy-probe-result"><span>{preview.matchedKind === 'default' ? '默认出口' : preview.matchedKind === 'manual' ? '手动规则' : '规则订阅'}</span><strong>{preview.matchedName}</strong><i>→</i><b>{state.proxyProfiles.find((profile) => profile.id === preview.effectiveProfileId)?.name}</b><small title={preview.matchedCondition}>{preview.matchedCondition || preview.hostname}</small></div> : <div className="proxy-probe-placeholder">查看某个请求为什么使用当前出口</div>}
    </section>

    {tab?.url?.startsWith('http') && <section className="proxy-current-site">
      <div><CircleDot size={16} /><span><strong>{hostFromUrl(tab.url)}</strong><small>为当前站点创建最高优先级规则</small></span></div>
      <div><Button size="sm" disabled={busy} onClick={() => void quickRoute('direct')}>始终直连</Button>{state.proxyProfiles.some((profile) => profile.id === 'yakit-mitm') && <Button size="sm" variant="primary" disabled={busy} onClick={() => void quickRoute('yakit-mitm')}>始终走 MITM</Button>}</div>
    </section>}

    <div className="proxy-rule-workspace">
      <section className="proxy-rule-table">
        <div className="proxy-table-toolbar"><div><span>手动规则</span><strong>{rules.length}</strong></div><Button size="sm" onClick={() => setDraft(freshRule(rules.length, tab?.url))}><Plus size={14} />新建</Button></div>
        <div className="proxy-rule-head"><span>顺序</span><span>规则</span><span>条件</span><span>出口</span><span>状态</span><span /></div>
        {rules.length === 0 ? <div className="proxy-table-empty"><Route size={22} /><strong>没有手动规则</strong><span>可以从当前站点快速创建，或在右侧添加。</span></div> : <div
          className="proxy-virtual-list"
          ref={listRef}
          style={{ height: LIST_HEIGHT }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        ><div style={{ height: rules.length * ROW_HEIGHT, position: 'relative' }}>{visibleRules.map((rule, visibleIndex) => {
          const index = firstVisible + visibleIndex;
          const profile = state.proxyProfiles.find((item) => item.id === rule.proxyProfileId);
          return <div
            key={rule.id}
            role="button"
            tabIndex={0}
            className={`proxy-rule-row ${draft.id === rule.id ? 'is-selected' : ''}`}
            style={{ position: 'absolute', top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
            onClick={() => setDraft(rule)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setDraft(rule);
              }
            }}
          >
            <span className="proxy-rule-order"><Button size="icon" variant="ghost" aria-label="上移规则" disabled={index === 0} onClick={(event) => { event.stopPropagation(); void reorder(rule, -1); }}><ArrowUp size={13} /></Button><Button size="icon" variant="ghost" aria-label="下移规则" disabled={index === rules.length - 1} onClick={(event) => { event.stopPropagation(); void reorder(rule, 1); }}><ArrowDown size={13} /></Button></span>
            <span><strong>{rule.name}</strong><small>{CONDITION_LABELS[rule.condition.type]}</small></span>
            <code title={rule.condition.value}>{rule.condition.value}</code>
            <span>{profile?.name || '出口已删除'}</span>
            <i className={rule.enabled ? 'is-enabled' : ''}>{rule.enabled ? '启用' : '停用'}</i>
            <Route size={14} />
          </div>;
        })}</div></div>}
        {enabledSources.length > 0 && <div className="proxy-source-summary"><Gauge size={15} /><span><strong>{enabledSources.length} 个订阅源参与匹配</strong><small>{enabledSources.reduce((sum, source) => sum + source.supportedRuleCount, 0).toLocaleString()} 条已规范化规则</small></span></div>}
      </section>

      <aside className="proxy-rule-inspector">
        <div className="proxy-editor-heading"><div><span>{selectedExists ? '编辑规则' : '新建规则'}</span><h2>{draft.name || '未命名规则'}</h2></div><Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
        <Field label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="条件类型"><select value={draft.condition.type} onChange={(event) => setDraft({ ...draft, condition: { type: event.target.value as ProxyConditionType, value: '' } })}>{Object.entries(CONDITION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="匹配值" hint={draft.condition.type.startsWith('url_') ? 'Chrome 对 HTTPS PAC 会隐藏路径与查询参数，优先使用域名条件。' : undefined}><textarea rows={4} value={draft.condition.value} placeholder={conditionHint(draft.condition.type)} onChange={(event) => setDraft({ ...draft, condition: { ...draft.condition, value: event.target.value } })} /></Field>
        <Field label="代理出口"><select value={draft.proxyProfileId} onChange={(event) => setDraft({ ...draft, proxyProfileId: event.target.value })}>{routableProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {proxyProfileDetail(profile)}</option>)}</select></Field>
        <div className="proxy-inspector-actions"><Button variant="primary" disabled={busy || !draft.name.trim() || !draft.condition.value.trim()} onClick={() => void save()}><Save size={15} />保存规则</Button>{selectedExists && <Button variant="danger" disabled={busy} onClick={() => void run(async () => { const updated = await request('proxy.rule.delete', { id: draft.id }); setState(updated); setDraft(freshRule(updated.proxyRules.length, tab?.url)); }, '规则已删除')}><Trash2 size={15} />删除</Button>}</div>
        {preview && <section className="proxy-trace"><div><CheckCircle2 size={15} /><strong>匹配顺序</strong></div>{preview.trace.slice(0, 8).map((item, index) => <p key={`${item.kind}:${item.name}:${index}`} className={item.matched ? 'is-match' : ''}><i>{item.matched ? <CheckCircle2 size={13} /> : <span />}</i><span><strong>{item.name}</strong><small>{item.condition || item.kind}</small></span></p>)}</section>}
      </aside>
    </div>
  </div>;
}
