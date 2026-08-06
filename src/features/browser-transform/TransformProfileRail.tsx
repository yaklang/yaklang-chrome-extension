import {
  CheckCircle2, ChevronDown, CirclePlus, Code2, FileKey2, Plus, RefreshCw, Trash2,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  ActiveTabInfo,
  BrowserPageCallable,
  BrowserTransformPipelineNode,
  BrowserTransformProfile,
} from '@/types/models';

function originOf(url?: string): string {
  try { return url ? new URL(url).origin : ''; } catch { return ''; }
}

function callableKindLabel(callable: BrowserPageCallable): string {
  if (callable.kind === 'recorded-call') return '录制调用';
  if (callable.kind === 'business-closure') return '业务闭包';
  if (callable.kind === 'request-transaction') return '请求事务';
  return '全局函数';
}

export function TransformProfileRail({
  tab,
  profiles,
  callables,
  selectedProfileId,
  callableIds,
  callableReferences,
  confirmDeleteCallableId,
  busy,
  onCreate,
  onSelect,
  onConfirmDeleteCallable,
  onDeleteCallable,
  onRefresh,
}: {
  tab?: ActiveTabInfo;
  profiles: BrowserTransformProfile[];
  callables: BrowserPageCallable[];
  selectedProfileId: string;
  callableIds: ReadonlySet<string>;
  callableReferences: ReadonlyMap<string, number>;
  confirmDeleteCallableId: string;
  busy: boolean;
  onCreate: () => void;
  onSelect: (profile: BrowserTransformProfile) => void;
  onConfirmDeleteCallable: (id: string) => void;
  onDeleteCallable: (callable: BrowserPageCallable) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  return <aside className="transform-profiles">
    <header><div><strong>明文网关</strong><span>{profiles.length}</span></div><Button size="icon" variant="ghost" aria-label="新建 Pipeline" title="新建 Pipeline" disabled={!tab} onClick={onCreate}><Plus size={15} /></Button></header>
    <div className="transform-profile-list">
      {profiles.map((profile) => {
        const ready = (!profile.recovery || profile.recovery.state === 'ready')
          && originOf(tab?.url) === profile.origin && [profile.request, profile.response]
          .flatMap((item) => item.enabled ? item.nodes : [])
          .filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'page.call' }> => node.kind === 'page.call')
          .every((node) => callableIds.has(node.callableId));
        return <button key={profile.id} className={selectedProfileId === profile.id ? 'is-selected' : ''} onClick={() => onSelect(profile)}>
          <span className={`transform-profile-mark ${ready ? 'is-ready' : ''}`}><FileKey2 size={14} /></span>
          <span><strong>{profile.name}</strong><small>{profile.match.methods.join(' / ') || 'ANY'} · {profile.match.urlPattern}</small></span>
          <i title={ready ? '页面绑定可用' : '页面函数已失效'}>{ready ? <CheckCircle2 size={13} /> : <Unplug size={13} />}</i>
        </button>;
      })}
      {!profiles.length && <div className="transform-profile-empty"><FileKey2 size={20} /><strong>没有 Pipeline</strong><Button size="sm" variant="primary" disabled={!tab} onClick={onCreate}><CirclePlus size={14} />新建</Button></div>}
    </div>
    <footer>
      <details className="transform-callable-menu">
        <summary className={callables.length ? 'is-ready' : ''}><i />{callables.length} 个页面函数<ChevronDown size={12} /></summary>
        <div className="transform-callable-popover">
          <header><div><strong>当前文档页面函数</strong><span>页面刷新或导航后自动失效</span></div><em>{callables.length}</em></header>
          {!callables.length ? <div className="transform-callable-empty"><Code2 size={17} /><span>还没有可管理的页面函数</span></div> : <div className="transform-callable-list">{callables.map((callable) => {
            const referenceCount = callableReferences.get(callable.id) || 0;
            const confirming = confirmDeleteCallableId === callable.id;
            return <section key={callable.id}>
              <div className="transform-callable-row"><span><strong>{callable.name}</strong><small>{callableKindLabel(callable)} · {callable.algorithm || callable.operation}</small></span><Button size="icon" variant="ghost" aria-label={`删除 ${callable.name}`} title="删除页面函数" disabled={busy} onClick={() => onConfirmDeleteCallable(callable.id)}><Trash2 size={13} /></Button></div>
              {confirming && <div className="transform-callable-confirm"><span>{referenceCount ? `${referenceCount} 个网关节点正在引用，删除后会显示“页面函数缺失”。` : '这个页面函数将从当前文档中移除。'}</span><div><Button size="sm" variant="ghost" onClick={() => onConfirmDeleteCallable('')}>取消</Button><Button size="sm" variant="danger" disabled={busy} onClick={() => void onDeleteCallable(callable)}>确认删除</Button></div></div>}
            </section>;
          })}</div>}
        </div>
      </details>
      <Button size="icon" variant="ghost" aria-label="刷新页面绑定" title="刷新页面绑定" onClick={() => void onRefresh()}><RefreshCw size={14} /></Button>
    </footer>
  </aside>;
}
