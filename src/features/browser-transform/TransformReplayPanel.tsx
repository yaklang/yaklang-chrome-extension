import { AlertTriangle, CheckCircle2, FlaskConical, Play, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  ActiveTabInfo,
  BrowserTransformExecution,
  BrowserTransformProfileInput,
  BrowserTransformValueSummary,
} from '@/types/models';
import type { ReplayPersistenceState } from './workspace-reducer';

function replayValueSummary(value?: BrowserTransformValueSummary): string {
  if (!value) return '不存在';
  if (value.type === 'string' || value.type === 'bytes') {
    return `${value.type === 'string' ? '文本' : '字节'}${value.byteLength === undefined ? '' : ` · ${value.byteLength} B`}`;
  }
  if (value.type === 'array' || value.type === 'object') {
    return `${value.type === 'array' ? '数组' : '对象'}${value.itemCount === undefined ? '' : ` · ${value.itemCount} 项`}`;
  }
  return value.type;
}

export function TransformReplayPanel({
  tab,
  draft,
  busy,
  replayLoading,
  replayPersistence,
  replayPersistenceLabel,
  replayPersistenceTitle,
  gatewayShared,
  onShareGateway,
  onClear,
  canExecute,
  onExecute,
  method,
  url,
  headers,
  body,
  sample,
  onMethodChange,
  onUrlChange,
  onHeadersChange,
  onBodyChange,
  loadError,
  replayStorageError,
  testError,
  result,
}: {
  tab?: ActiveTabInfo;
  draft?: BrowserTransformProfileInput;
  busy: boolean;
  replayLoading: boolean;
  replayPersistence: ReplayPersistenceState;
  replayPersistenceLabel: string;
  replayPersistenceTitle: string;
  gatewayShared: boolean;
  onShareGateway: () => Promise<void>;
  onClear: () => Promise<void>;
  canExecute: boolean;
  onExecute: () => Promise<void>;
  method: string;
  url: string;
  headers: string;
  body: string;
  sample?: { body: string; label: string };
  onMethodChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onHeadersChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  loadError: string;
  replayStorageError: string;
  testError: string;
  result?: BrowserTransformExecution;
}) {
  const error = loadError || replayStorageError || testError;
  return <aside className="transform-test">
    <header>
      <div><FlaskConical size={15} /><span><strong>本地回放</strong><small>不发送网络请求</small></span></div>
      <div className="transform-test-header-actions">
        {result && <i className="transform-test-duration">{result.durationMs.toFixed(1)} ms</i>}
        <span className={`transform-replay-persistence is-${replayPersistence}`} title={replayPersistenceTitle} aria-live="polite"><i />{replayPersistenceLabel}</span>
        <Button size="icon" variant="ghost" disabled={!draft?.id || busy || replayLoading} aria-label="清空本机回放草稿" title="清空当前方向的本机回放草稿" onClick={() => void onClear()}><Trash2 size={13} /></Button>
      </div>
    </header>
    {draft?.id && <section className={`transform-gateway-share ${gatewayShared ? 'is-active' : ''}`}>
      <span className="transform-gateway-share__mark"><ShieldCheck size={15} /></span>
      <div>
        <strong>{gatewayShared ? '当前浏览器实例已接入 Yakit' : '连接 Yakit 后使用这个网关'}</strong>
        <small>{gatewayShared
          ? '页面刷新、跳转后仍可使用，无需续接授权'
          : '连接后由 Agent 操作审核策略统一控制'}</small>
      </div>
      {!gatewayShared && <Button
        size="sm"
        variant="primary"
        disabled={busy || !tab}
        onClick={() => void onShareGateway()}
      >连接</Button>}
    </section>}
    <label><span>请求</span><div><input disabled={replayLoading} aria-label="回放 HTTP 方法" value={method} onChange={(event) => onMethodChange(event.target.value)} /><input disabled={replayLoading} aria-label="回放请求 URL" value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="https://example.test/api" /></div></label>
    <label><span>Headers · JSON</span><textarea disabled={replayLoading} rows={4} value={headers} onChange={(event) => onHeadersChange(event.target.value)} /></label>
    <div className="transform-test-body"><div className="transform-test-field-label"><span>Body</span>{sample && (body === sample.body ? <em title={sample.label}>短时样本</em> : <button type="button" disabled={replayLoading} onClick={() => onBodyChange(sample.body)}>恢复短时样本</button>)}</div><textarea disabled={replayLoading} aria-label="回放 Body" rows={8} value={body} onChange={(event) => onBodyChange(event.target.value)} /></div>
    <Button variant="primary" disabled={!canExecute} onClick={() => void onExecute()}><Play size={14} />执行 Pipeline</Button>
    {error && <div className="transform-test-error"><AlertTriangle size={14} />{error}</div>}
    {result && <section className="transform-test-result">
      <header><div><CheckCircle2 size={14} /><strong>转换完成</strong></div><span>{result.nodeTrace.length} 节点 · {result.fieldChanges.length} 项变化</span></header>
      <dl><div><dt>输出 URL</dt><dd>{result.url}</dd></div><div><dt>Headers</dt><dd>{result.setHeaders.length} 设置 · {result.removeHeaders.length} 删除</dd></div></dl>
      {result.fieldChanges.length > 0 && <ul className="transform-test-changes">{result.fieldChanges.map((change) => <li key={change.path}>
        <i className={`is-${change.change}`}>{change.change === 'added' ? '+' : change.change === 'removed' ? '-' : '→'}</i>
        <code>{change.path}</code><span>{change.before && `${replayValueSummary(change.before)} → `}{replayValueSummary(change.after)}</span>
      </li>)}</ul>}
      <ol className="transform-test-trace">{result.nodeTrace.map((node, index) => <li key={node.nodeId}><i>{index + 1}</i><span><strong>{node.name}</strong><small>{node.kind} · {replayValueSummary(node.output)}</small></span><time>{node.durationMs.toFixed(1)} ms</time></li>)}</ol>
      <details className="transform-test-debug"><summary>调试输出</summary><pre>{JSON.stringify(result.logicalOutput, null, 2)}</pre></details>
    </section>}
  </aside>;
}
