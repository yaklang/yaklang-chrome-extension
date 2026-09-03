import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  ArrowDownToLine,
  Braces,
  CheckCircle2,
  ChevronDown,
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

interface FlowStageItem {
  id: string;
  stage: BrowserTransformExplanationStage;
  members: BrowserTransformExplanationStage[];
}

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

function displayStages(
  stages: BrowserTransformExplanationStage[],
  direction: BrowserTransformDirectionName,
): FlowStageItem[] {
  const items: FlowStageItem[] = [];
  for (const stage of stages) {
    const assembly = stage.owner === 'extension' && (stage.kind === 'builtin' || stage.kind === 'output');
    const previous = items[items.length - 1];
    if (assembly && previous?.members.every((item) => (
      item.owner === 'extension' && (item.kind === 'builtin' || item.kind === 'output')
    ))) {
      previous.members.push(stage);
      continue;
    }
    items.push({ id: stage.id, stage, members: [stage] });
  }
  return items.map((item) => {
    if (item.members.length === 1) return item;
    const first = item.members[0];
    const last = item.members[item.members.length - 1];
    return {
      ...item,
      id: `${first.id}:assembly`,
      stage: {
        ...first,
        id: `${first.id}:assembly`,
        title: direction === 'request' ? '浏览器扩展组装线上请求' : '浏览器扩展还原逻辑响应',
        summary: `${item.members.length} 个受限步骤，将中间结果写入最终报文`,
        nodeIds: item.members.flatMap((member) => member.nodeIds),
        inputPaths: first.inputPaths,
        outputPaths: last.outputPaths,
        operations: item.members.flatMap((member) => member.operations),
        evidence: item.members.flatMap((member) => member.evidence),
      },
    };
  });
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
  const stages = useMemo(() => displayStages(explained?.stages || [], direction), [direction, explained?.stages]);
  const defaultOpenStageId = stages.find((item) => item.members.some((member) => member.kind === 'page-call'))?.id || '';
  const [openStageId, setOpenStageId] = useState('');

  useEffect(() => {
    setOpenStageId(defaultOpenStageId);
  }, [defaultOpenStageId, direction, profile.id]);

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
        <p>{stages.length === explained.stages.length
          ? explained.summary
          : `${explained.stages.length} 个处理步骤已收拢为 ${stages.length} 个主要阶段`}</p>
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
      {stages.map((item, index) => {
        const { stage } = item;
        const Icon = STAGE_ICONS[stage.kind];
        const traces = currentExecution?.nodeTrace.filter((trace) => stage.nodeIds.includes(trace.nodeId)) || [];
        const stageDuration = traces.reduce((total, trace) => total + trace.durationMs, 0);
        const hasDetails = Boolean(stage.inputPaths.length || stage.outputPaths.length || stage.operations.length
          || stage.evidence.length || stage.network || stage.source || traces.length);
        return <details className={`transform-flow-stage is-${stage.owner}`} key={item.id} open={openStageId === item.id}>
          <summary
            aria-expanded={openStageId === item.id}
            onClick={(event) => {
              event.preventDefault();
              if (hasDetails) setOpenStageId((current) => current === item.id ? '' : item.id);
            }}
          >
            <span className="transform-flow-stage__rail">
              <i><Icon size={15} /></i>
              {index < stages.length - 1 && <b />}
            </span>
            <span className="transform-flow-stage__main">
              <span className="transform-flow-stage__meta"><em>{OWNER_LABELS[stage.owner]}</em><i className={`is-${stage.proof}`}>{proofLabel(stage)}</i></span>
              <strong>{stage.title}</strong>
              <small>{stage.summary}</small>
            </span>
            <span className="transform-flow-stage__status">
              {traces.length ? <><CheckCircle2 size={14} /><time>{stageDuration.toFixed(1)} ms</time></> : null}
              {hasDetails && <ChevronDown className="transform-flow-stage__chevron" size={14} />}
            </span>
          </summary>
          {hasDetails && <div className="transform-flow-stage__details">
            {item.members.length > 1 && <div className="transform-flow-steps">
              <span>阶段内操作</span>
              <ol>{item.members.map((member, memberIndex) => <li key={member.id}>
                <i>{memberIndex + 1}</i>
                <span><strong>{member.title}</strong><small>{member.operations.map(operationLabel).join(' · ') || member.summary}</small></span>
                <code>{[member.inputPaths.join('、'), member.outputPaths.join('、')].filter(Boolean).join(' → ')}</code>
              </li>)}</ol>
            </div>}
            {stage.network && <dl className="transform-flow-network">
              <div><dt>网络边界</dt><dd><code>{stage.network.method}</code> {stage.network.route}</dd></div>
              {stage.network.statusCode && <div><dt>录制响应</dt><dd>{stage.network.statusCode}</dd></div>}
            </dl>}
            {item.members.length === 1 && stage.operations.length > 0 && <div className="transform-flow-facts"><span>处理逻辑</span><ul>{stage.operations.map((operation, operationIndex) => <li key={`${operation.operation}:${operationIndex}`}><strong>{operationLabel(operation)}</strong>{operation.destination && <code>→ {operation.destination}</code>}</li>)}</ul></div>}
            {item.members.length === 1 && (stage.inputPaths.length > 0 || stage.outputPaths.length > 0) && <div className="transform-flow-paths">
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
