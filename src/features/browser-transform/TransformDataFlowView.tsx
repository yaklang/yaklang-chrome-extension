import type { ComponentType } from 'react';
import {
  ArrowDownToLine,
  Braces,
  CheckCircle2,
  Code2,
  FileInput,
  KeyRound,
  RefreshCw,
  Send,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  BrowserTransformDirectionName,
  BrowserTransformExecution,
  BrowserTransformExplanationOwner,
  BrowserTransformExplanationStage,
  BrowserTransformProfile,
  BrowserTransformValueSummary,
} from '@/types/models';

const OWNER_LABELS: Record<BrowserTransformExplanationOwner, string> = {
  webfuzzer: 'Web Fuzzer',
  extension: '浏览器扩展',
  page: '目标页面',
  yak: 'Yak 引擎',
};

const STAGE_ICONS: Record<BrowserTransformExplanationStage['kind'], ComponentType<{ size?: number }>> = {
  input: FileInput,
  prerequisite: RefreshCw,
  'page-call': Code2,
  builtin: Braces,
  output: ArrowDownToLine,
  session: KeyRound,
  transport: Send,
};

function proofLabel(stage: BrowserTransformExplanationStage): string {
  if (stage.proof === 'observed') return '录制实证';
  if (stage.proof === 'supported') return '关联支持';
  return '配置规则';
}

function valueSummary(value?: BrowserTransformValueSummary): string {
  if (!value) return '不存在';
  if (value.type === 'string' || value.type === 'bytes') {
    return `${value.type === 'string' ? '文本' : '字节'}${value.byteLength === undefined ? '' : ` · ${value.byteLength} B`}`;
  }
  if (value.type === 'array' || value.type === 'object') {
    return `${value.type === 'array' ? '数组' : '对象'}${value.itemCount === undefined ? '' : ` · ${value.itemCount} 项`}`;
  }
  const labels: Record<string, string> = {
    null: 'null', undefined: 'undefined', boolean: '布尔值', number: '数字',
  };
  return labels[value.type] || value.type;
}

function operationLabel(operation: BrowserTransformExplanationStage['operations'][number]): string {
  if (!operation.crypto) return operation.operation;
  const crypto = operation.crypto;
  const details = [
    crypto.algorithm || crypto.operation,
    crypto.mode,
    crypto.padding,
    crypto.outputEncoding && `输出 ${crypto.outputEncoding}`,
  ].filter(Boolean);
  return details.join(' · ');
}

export function TransformDataFlowView({
  profile,
  direction,
  execution,
  onDirectionChange,
  onConfigure,
}: {
  profile: BrowserTransformProfile;
  direction: BrowserTransformDirectionName;
  execution?: BrowserTransformExecution;
  onDirectionChange: (direction: BrowserTransformDirectionName) => void;
  onConfigure: () => void;
}) {
  const explained = profile.explanation?.directions.find((item) => item.direction === direction);
  const currentExecution = execution?.direction === direction ? execution : undefined;
  const availableDirections = profile.explanation?.directions.map((item) => item.direction) || [];

  if (!explained) return <div className="transform-flow-empty">
    <Code2 size={22} />
    <div><strong>这个方向还没有可解释的数据流</strong><span>保存当前配置后会生成语义步骤与执行证据。</span></div>
    <Button size="sm" variant="primary" onClick={onConfigure}><Settings2 size={13} />打开配置</Button>
  </div>;

  return <section className="transform-data-flow">
    <header className="transform-data-flow__head">
      <div>
        <span className="transform-data-flow__eyebrow">明文网关 · {direction === 'request' ? '请求方向' : '响应方向'}</span>
        <strong>{direction === 'request' ? '明文如何成为线上请求' : '线上响应如何还原为明文'}</strong>
        <p>{explained.summary}</p>
      </div>
      {availableDirections.length > 1 && <div className="transform-flow-directions" role="tablist" aria-label="数据流方向">
        {availableDirections.map((item) => <button
          key={item}
          type="button"
          role="tab"
          aria-selected={direction === item}
          className={direction === item ? 'is-selected' : ''}
          onClick={() => onDirectionChange(item)}
        >{item === 'request' ? '请求加密' : '响应解密'}</button>)}
      </div>}
    </header>

    <div className="transform-flow-owners" aria-label="执行边界">
      {(Object.entries(OWNER_LABELS) as Array<[BrowserTransformExplanationOwner, string]>).map(([owner, label]) => (
        <span key={owner} className={`is-${owner}`}><i />{label}</span>
      ))}
      <em>{currentExecution ? `最近回放 · ${currentExecution.durationMs.toFixed(1)} ms` : '等待本地回放'}</em>
    </div>

    <div className="transform-flow-timeline">
      {explained.stages.map((stage, index) => {
        const Icon = STAGE_ICONS[stage.kind];
        const traces = currentExecution?.nodeTrace.filter((trace) => stage.nodeIds.includes(trace.nodeId)) || [];
        const stageDuration = traces.reduce((total, trace) => total + trace.durationMs, 0);
        const hasDetails = Boolean(stage.inputPaths.length || stage.outputPaths.length || stage.operations.length
          || stage.evidence.length || stage.network || stage.source || traces.length);
        return <details className={`transform-flow-stage is-${stage.owner}`} key={stage.id} open={stage.kind === 'page-call'}>
          <summary>
            <span className="transform-flow-stage__rail">
              <i><Icon size={15} /></i>
              {index < explained.stages.length - 1 && <b />}
            </span>
            <span className="transform-flow-stage__main">
              <span className="transform-flow-stage__meta"><em>{OWNER_LABELS[stage.owner]}</em><i className={`is-${stage.proof}`}>{proofLabel(stage)}</i></span>
              <strong>{stage.title}</strong>
              <small>{stage.summary}</small>
            </span>
            <span className="transform-flow-stage__status">
              {traces.length ? <><CheckCircle2 size={14} /><time>{stageDuration.toFixed(1)} ms</time></> : hasDetails ? <span>详情</span> : null}
            </span>
          </summary>
          {hasDetails && <div className="transform-flow-stage__details">
            {stage.network && <dl className="transform-flow-network">
              <div><dt>网络边界</dt><dd><code>{stage.network.method}</code> {stage.network.route}</dd></div>
              {stage.network.statusCode && <div><dt>录制响应</dt><dd>{stage.network.statusCode}</dd></div>}
            </dl>}
            {stage.operations.length > 0 && <div className="transform-flow-facts"><span>处理</span><ul>{stage.operations.map((operation, operationIndex) => <li key={`${operation.operation}:${operationIndex}`}><strong>{operationLabel(operation)}</strong>{operation.destination && <code>→ {operation.destination}</code>}</li>)}</ul></div>}
            {(stage.inputPaths.length > 0 || stage.outputPaths.length > 0) && <div className="transform-flow-paths">
              {stage.inputPaths.length > 0 && <div><span>输入</span><p>{stage.inputPaths.map((path) => <code key={path}>{path}</code>)}</p></div>}
              {stage.outputPaths.length > 0 && <div><span>输出</span><p>{stage.outputPaths.map((path) => <code key={path}>{path}</code>)}</p></div>}
            </div>}
            {stage.source && (stage.source.functionName || stage.source.url) && <div className="transform-flow-source"><span>页面来源</span><code>{[stage.source.functionName, stage.source.url, stage.source.lineNumber].filter((item) => item !== undefined).join(' · ')}</code></div>}
            {stage.evidence.length > 0 && <div className="transform-flow-evidence"><span>关联证据</span><ul>{stage.evidence.map((evidence, evidenceIndex) => <li key={`${evidence.label}:${evidenceIndex}`}><i className={`is-${evidence.strength}`} />{evidence.label}</li>)}</ul></div>}
            {traces.length > 0 && <div className="transform-flow-runtime"><span>本次执行</span><ol>{traces.map((trace) => <li key={trace.nodeId}><strong>{trace.name}</strong><code>{valueSummary(trace.output)}</code><time>{trace.durationMs.toFixed(1)} ms</time></li>)}</ol></div>}
          </div>}
        </details>;
      })}
    </div>

    {currentExecution && <section className="transform-flow-changes">
      <header><div><strong>报文变化</strong><span>仅记录字段路径、类型与长度</span></div><em>{currentExecution.fieldChanges.length} 项</em></header>
      {currentExecution.fieldChanges.length ? <ul>{currentExecution.fieldChanges.map((change) => <li key={change.path}>
        <i className={`is-${change.change}`}>{change.change === 'added' ? '+' : change.change === 'removed' ? '-' : '→'}</i>
        <code>{change.path}</code>
        <span>{change.before && `${valueSummary(change.before)} → `}{valueSummary(change.after)}</span>
      </li>)}</ul> : <p>本次回放没有改变可观察的报文字段。</p>}
    </section>}
  </section>;
}
