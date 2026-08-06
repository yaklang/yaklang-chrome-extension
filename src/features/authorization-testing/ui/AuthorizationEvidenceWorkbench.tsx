import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, CircleCheck, Code2, FileDiff, FileText, Timer,
} from 'lucide-react';
import { errorMessage } from '@/platform/messaging/runtime';
import {
  runBrowserAuthorizationTask,
  type BrowserAuthorizationEvidenceBundle,
  type BrowserAuthorizationEvidenceDiff,
  type BrowserAuthorizationEvidencePacket,
  type BrowserAuthorizationEvidenceValidation,
  type BrowserAuthorizationWorkspace,
} from '../engine';

function decodeEvidencePacket(packetBase64: string): string {
  const binary = atob(packetBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function compactDuration(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  return `${Math.round(value)} ms`;
}

function formatResponseAnalysis(response?: BrowserAuthorizationEvidenceBundle['cases'][number]['response']): string {
  if (!response) return '';
  if (response.analysisState === 'encoded-unavailable') return ' · 编码正文不可分析';
  if (response.analysisRepresentation === 'binary') return ' · 二进制摘要';
  if (response.decoded) {
    const encoding = response.contentEncoding || '压缩内容';
    const representation = response.analysisRepresentation?.toUpperCase() || '正文';
    return ` · ${encoding} → ${representation}`;
  }
  return '';
}

export function AuthorizationEvidenceWorkbench({
  workspace,
  onWorkspaceChange,
}: {
  workspace: BrowserAuthorizationWorkspace;
  onWorkspaceChange: (workspace: BrowserAuthorizationWorkspace) => void;
}) {
  const execution = workspace.execution!;
  const [bundle, setBundle] = useState<BrowserAuthorizationEvidenceBundle>();
  const [comparisonId, setComparisonId] = useState('');
  const [diff, setDiff] = useState<BrowserAuthorizationEvidenceDiff>();
  const [packet, setPacket] = useState<BrowserAuthorizationEvidencePacket>();
  const [packetTitle, setPacketTitle] = useState('');
  const [view, setView] = useState<'redacted' | 'raw'>('redacted');
  const [showVolatile, setShowVolatile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [validatingPath, setValidatingPath] = useState('');
  const [validationMessage, setValidationMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    setBundle(undefined);
    setDiff(undefined);
    setPacket(undefined);
    void runBrowserAuthorizationTask<BrowserAuthorizationEvidenceBundle>(
      'authorization.evidence.inspect',
      { workspaceId: workspace.id, executionId: execution.id },
    ).then((next) => {
      if (disposed) return;
      setBundle(next);
      const preferred = next.comparisons.find((item) => item.purpose === 'authorization')
        || next.comparisons[0];
      setComparisonId(preferred?.id || '');
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [execution.id, workspace.id]);

  const comparison = bundle?.comparisons.find((item) => item.id === comparisonId);
  const comparisonCases = comparison
    ? bundle?.cases.filter((item) => item.id === comparison.leftCaseId || item.id === comparison.rightCaseId) || []
    : [];
  const comparisonTruncated = comparisonCases.some((item) => item.response?.truncated);
  const comparisonEncodedUnavailable = comparisonCases.some(
    (item) => item.response?.analysisState === 'encoded-unavailable',
  );
  const rawDiffEntries = diff?.entries;
  const diffEntries = Array.isArray(rawDiffEntries) ? rawDiffEntries : [];
  const diffRepresentationLabel = diff?.representation === 'structured'
    ? '结构化字段差异'
    : diffEntries.some((entry) => entry.path.includes('.body.binary.'))
      ? '二进制摘要差异'
      : diffEntries.some((entry) => entry.path.includes('.body.encoded.'))
        ? '编码正文元数据差异'
        : '原始文本差异';
  const volatileCount = diffEntries.filter((entry) => entry.volatile).length;
  const visibleEntries = diffEntries.filter((entry) => showVolatile || !entry.volatile);
  const executionEvidence = Array.isArray(execution.evidence) ? execution.evidence : [];
  const validationDirections: BrowserAuthorizationEvidenceValidation['direction'][] = comparison?.id === 'controls'
    ? ['a-to-b', 'b-to-a']
    : comparison?.id === 'a-to-b'
      ? ['a-to-b']
      : comparison?.id === 'b-to-a'
        ? ['b-to-a']
        : comparison?.id === 'low-vs-privileged' || comparison?.id === 'probe-vs-privileged'
          ? ['low-to-privileged']
          : comparison?.id === 'post-state'
            ? ['post-state']
            : [];

  useEffect(() => {
    if (!comparison) return;
    let disposed = false;
    setLoading(true);
    setError('');
    setPacket(undefined);
    void runBrowserAuthorizationTask<BrowserAuthorizationEvidenceDiff>(
      'authorization.evidence.diff',
      {
        workspaceId: workspace.id,
        executionId: execution.id,
        leftCaseId: comparison.leftCaseId,
        rightCaseId: comparison.rightCaseId,
        scope: 'response',
        view,
      },
    ).then((next) => {
      if (!disposed) setDiff(next);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [comparison?.id, execution.id, view, workspace.id]);

  const changeView = (next: 'redacted' | 'raw') => {
    if (next === 'raw' && !window.confirm(
      '原始证据可能包含 Cookie、Authorization 与业务敏感值。仅在当前授权测试确有需要时显示。',
    )) return;
    setView(next);
    setPacket(undefined);
  };

  const openPacket = async (
    caseId: string,
    side: 'request' | 'response',
    label: string,
  ) => {
    setLoading(true);
    setError('');
    try {
      const next = await runBrowserAuthorizationTask<BrowserAuthorizationEvidencePacket>(
        'authorization.evidence.packet',
        {
          workspaceId: workspace.id,
          executionId: execution.id,
          caseId,
          side,
          view,
        },
      );
      setPacket(next);
      setPacketTitle(`${label} · ${side === 'request' ? '请求' : '响应'}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const validatePath = async (
    path: string,
    direction: BrowserAuthorizationEvidenceValidation['direction'],
  ) => {
    const validationKey = `${direction}:${path}`;
    setValidatingPath(validationKey);
    setValidationMessage('');
    setError('');
    try {
      const validation = await runBrowserAuthorizationTask<BrowserAuthorizationEvidenceValidation>(
        'authorization.evidence.validate',
        {
          workspaceId: workspace.id,
          executionId: execution.id,
          direction,
          paths: [path],
        },
      );
      setValidationMessage(validation.reason);
      const validationEvidence = Array.isArray(validation.evidence) ? validation.evidence : [];
      const additions = validationEvidence.filter((candidate) => !executionEvidence.some((current) => (
        current.direction === candidate.direction
        && current.path === candidate.path
        && current.source === candidate.source
      )));
      onWorkspaceChange({
        ...workspace,
        execution: {
          ...execution,
          verdict: validation.verdict,
          confidence: validation.confidence,
          evidence: [...executionEvidence, ...additions],
          reasons: validation.verdictChanged
            ? [...execution.reasons, validation.reason]
            : execution.reasons,
        },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setValidatingPath('');
    }
  };

  return <div className="authorization-evidence-workbench">
    <div className="authorization-evidence-title">
      <div>
        <span>短时证据包</span>
        <strong>交叉请求与业务归属证据</strong>
        <small>
          报文仅在当前工作区短时保留；差异默认脱敏，时间戳与请求 ID 会单独降噪。
          {bundle ? ` · 保留至 ${new Date(bundle.expiresAt).toLocaleTimeString()}` : ''}
        </small>
      </div>
      <div className="authorization-evidence-view">
        <button className={view === 'redacted' ? 'active' : ''} onClick={() => changeView('redacted')}>脱敏</button>
        <button className={view === 'raw' ? 'active raw' : ''} onClick={() => changeView('raw')}>原始值</button>
      </div>
    </div>

    {bundle && <div className="authorization-evidence-trace" aria-label="测试请求执行顺序">
      {bundle.cases.map((item, index) => <div key={item.id}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{item.label}</strong>
        <small>
          {item.status || '—'} · {compactDuration(item.timing.totalMs)}
          {item.timing.ttfbMs > 0 ? ` · 首字节 ${compactDuration(item.timing.ttfbMs)}` : ''}
          {formatResponseAnalysis(item.response)}
        </small>
        <nav>
          <button disabled={!item.requestAvailable || loading} onClick={() => void openPacket(item.id, 'request', item.label)}>
            <Code2 size={12} />请求
          </button>
          <button disabled={!item.responseAvailable || loading} onClick={() => void openPacket(item.id, 'response', item.label)}>
            <FileText size={12} />响应
          </button>
        </nav>
      </div>)}
    </div>}

    <div className="authorization-evidence-body">
      <aside>
        <span>比较关系</span>
        {bundle?.comparisons.map((item) => <button
          key={item.id}
          className={item.id === comparisonId ? 'active' : ''}
          onClick={() => {
            setComparisonId(item.id);
            setPacket(undefined);
          }}
        >
          <i>{item.purpose === 'authorization' ? '关键' : item.purpose === 'state-change' ? '状态' : '对照'}</i>
          <strong>{item.label}</strong>
        </button>)}
      </aside>
      <main>
        <header>
          <div>
            {packet ? <FileText size={16} /> : <FileDiff size={16} />}
            <span><strong>{packet ? packetTitle : comparison?.label || '响应差异'}</strong>
              <small>{packet
                ? `${packet.view === 'raw' ? '原始' : '脱敏'}报文${packet.truncated ? ' · 已截断' : ''}`
                : diffRepresentationLabel}</small>
            </span>
          </div>
          {packet
            ? <button onClick={() => setPacket(undefined)}><FileDiff size={13} />返回差异</button>
            : volatileCount > 0 && <button onClick={() => setShowVolatile((current) => !current)}>
              {showVolatile ? '隐藏' : '显示'}动态噪声 · {volatileCount}
            </button>}
        </header>

        {loading && <div className="authorization-evidence-empty"><Timer size={17} />正在读取证据…</div>}
        {!loading && error && <div className="authorization-evidence-empty error"><AlertTriangle size={17} />{error}</div>}
        {!loading && !error && packet && <pre>{decodeEvidencePacket(packet.packetBase64)}</pre>}
        {!loading && !error && !packet && diff?.equal && <div className="authorization-evidence-empty">
          <CircleCheck size={17} />{comparison?.purpose === 'authorization'
            ? comparisonTruncated
              ? '两项响应已捕获部分一致，但至少一项已截断，不能据此判断资源归属。'
              : comparisonEncodedUnavailable
                ? '两项线上编码正文指纹一致，但正文未能在预算内解码，不能据此提升授权结论。'
                : '交叉响应与目标身份响应完全一致；如结论尚未确认，请切换到“身份 A 自有资源 ↔ 身份 B 自有资源”，选择稳定业务字段验证。'
            : comparison?.purpose === 'state-change'
              ? '操作前后的稳定业务字段没有变化。'
              : '双方正常响应完全一致，当前对照没有可用于区分资源归属的字段。'}
        </div>}
        {!loading && !error && !packet && diff && !diff.equal
          && visibleEntries.length === 0 && volatileCount > 0 && !showVolatile
          && <div className="authorization-evidence-empty">
            <Timer size={17} />当前差异只有 {volatileCount} 项动态噪声，已默认折叠。
          </div>}
        {!packet && validationMessage && <div className="authorization-evidence-validation">
          <Check size={13} />{validationMessage}
        </div>}
        {!loading && !error && !packet && diff && !diff.equal && visibleEntries.length > 0 && <div className="authorization-diff-list">
          {visibleEntries.slice(0, 80).map((entry) => {
            const pendingDirections = validationDirections.filter((direction) => !executionEvidence.some((item) => (
              item.path === entry.path && item.direction === direction
            )));
            const alreadyVerified = pendingDirections.length < validationDirections.length;
            const canValidate = Boolean(
              pendingDirections.length
              && diff.scope === 'response'
              && entry.path.startsWith('body.')
              && !entry.volatile
              && !entry.sensitive
            );
            return <div
              key={`${entry.path}-${entry.kind}`}
              className={`${entry.semantic || alreadyVerified ? 'semantic' : ''} ${entry.volatile ? 'volatile' : ''}`}
            >
              <div>
                <code>{entry.path}</code>
                <span>{alreadyVerified
                  ? pendingDirections.length ? '部分已验证' : '已验证'
                  : entry.semantic ? '归属候选' : entry.volatile ? '动态噪声' : entry.sensitive ? '敏感字段' : entry.kind}</span>
                {canValidate && pendingDirections.map((direction) => {
                  const validationKey = `${direction}:${entry.path}`;
                  const label = direction === 'a-to-b'
                    ? '验证 A→B'
                    : direction === 'b-to-a'
                      ? '验证 B→A'
                      : direction === 'post-state'
                        ? '验证状态变化'
                        : '核对低权探测';
                  return <button
                    key={direction}
                    disabled={Boolean(validatingPath)}
                    onClick={() => void validatePath(entry.path, direction)}
                  >
                    {validatingPath === validationKey ? '验证中…' : label}
                  </button>;
                })}
              </div>
              <section>
                <p><b>左</b><span title={entry.left}>{entry.left || '—'}</span></p>
                <ArrowRight size={13} />
                <p><b>右</b><span title={entry.right}>{entry.right || '—'}</span></p>
              </section>
            </div>;
          })}
          {(visibleEntries.length > 80 || diff.omitted > 0) && <small className="authorization-diff-omitted">
            当前展示前 80 项，另有 {Math.max(0, visibleEntries.length - 80) + diff.omitted} 项未展开
          </small>}
        </div>}
      </main>
    </div>
  </div>;
}
