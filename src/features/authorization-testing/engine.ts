import { request } from '@/platform/messaging/runtime';
import { ExtensionError } from '@/shared/errors';
import { normalizeBrowserAuthorizationTaskResult } from './protocol';

export type BrowserAuthorizationMode = 'horizontal' | 'vertical';
export type BrowserAuthorizationSide = 'left' | 'right';

export interface BrowserAuthorizationBaselineCandidate {
  id: string;
  method: string;
  url: string;
  path: string;
  resourceType: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  eligible: boolean;
  reasons: string[];
}

export interface BrowserAuthorizationBaseline {
  id: string;
  networkRequestId: string;
  request: {
    method: string;
    url: string;
    path: string;
    contentType: string;
    actionFingerprint: string;
  };
}

export interface BrowserAuthorizationResourceCandidate {
  id: string;
  source: 'wire' | 'logical';
  location: 'header' | 'path' | 'query' | 'body';
  path: string;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  requiresLogicalBinding: boolean;
  reasons: string[];
}

export interface BrowserAuthorizationOperationCandidate {
  id: string;
  method: string;
  path: string;
  eligible: boolean;
  sideEffect: boolean;
  requiresDynamicRebuild: boolean;
  authenticationPaths: string[];
  dynamicPaths: string[];
  reasons: string[];
}

export interface BrowserAuthorizationWorkspace {
  version: 1;
  id: string;
  engineInstanceId: string;
  mode: BrowserAuthorizationMode;
  state: 'ready' | 'conditional' | 'blocked' | 'stale';
  left: {
    accountLabel?: string;
    origin: string;
    target: { tabId: number; frameId: number; documentId: string };
    authentication: {
      status: 'authenticated' | 'unauthenticated' | 'unknown';
      cookieCount: number;
      storageEntryCount: number;
    };
  };
  right: BrowserAuthorizationWorkspace['left'];
  proof: {
    level: 'strong' | 'conditional' | 'none';
    sameOrigin: boolean;
    cookieStoreRelation: 'different' | 'same' | 'unknown';
    accountEvidenceRelation: 'different' | 'same' | 'unknown';
    requestCredentialRelation: 'different' | 'same' | 'unknown';
    refreshCheck: 'passed' | 'failed' | 'not-required';
    reasons: string[];
  };
  baselines: {
    left?: BrowserAuthorizationBaseline;
    right?: BrowserAuthorizationBaseline;
    verification?: BrowserAuthorizationBaseline;
  };
  baselinePair: {
    state: 'waiting' | 'matched' | 'mismatch';
    reasons: string[];
    resourceCandidates: BrowserAuthorizationResourceCandidate[];
    operationCandidates: BrowserAuthorizationOperationCandidate[];
  };
  plan?: {
    id: string;
    mode: BrowserAuthorizationMode;
    candidateId: string;
    state: 'ready' | 'review-required' | 'blocked';
    selector: {
      source: 'wire' | 'logical' | 'operation';
      location: 'header' | 'path' | 'query' | 'body' | 'request';
      path: string;
    };
    cases: Array<{
      id: string;
      label: string;
      authContextSide: 'left' | 'right';
      resourceValueSide: 'left' | 'right' | '';
      method: string;
      path: string;
      sideEffect: boolean;
    }>;
    requestBudget: number;
    requiresDynamicRebuild: boolean;
    reasons: string[];
  };
  execution?: {
    id: string;
    state: 'completed' | 'partial';
    verdict: 'confirmed' | 'likely' | 'protected' | 'inconclusive' | 'invalid-controls';
    confidence: 'high' | 'medium' | 'low' | 'none';
    requestCount: number;
    cases: Array<{
      id: string;
      label: string;
      state: 'completed' | 'failed' | 'skipped';
      result?: {
        method: string;
        url: string;
        status: number;
        statusText: string;
        outcome: 'success' | 'denied' | 'redirect' | 'client-error' | 'server-error' | 'opaque';
        durationMs: number;
        timing: BrowserAuthorizationRequestTiming;
        response: {
          contentType: string;
          contentEncoding?: string;
          capturedBytes: number;
          analysisBytes?: number;
          declaredBytes?: number;
          truncated: boolean;
          decoded?: boolean;
          analysisState?: 'identity' | 'decoded' | 'encoded-unavailable';
          analysisRepresentation?: 'json' | 'html' | 'form' | 'text' | 'binary' | 'encoded';
        };
      };
      error?: string;
    }>;
    evidence: Array<{
      direction: string;
      path: string;
      valueFingerprint: string;
      source: string;
    }>;
    evidenceAvailable: boolean;
    reasons: string[];
  };
  expiresAt: number;
  staleReason?: string;
  recovery?: {
    code: string;
    scope: string;
    message: string;
    automatic: false;
  };
}

export type BrowserAuthorizationWorkspaceLifecycleReason =
  | 'expired'
  | 'evicted'
  | 'engine_instance_changed'
  | 'not_found'
  | 'replaced';

export interface BrowserAuthorizationWorkspaceLifecycleDetails {
  reason: BrowserAuthorizationWorkspaceLifecycleReason;
  workspaceId: string;
  engineInstanceId: string;
  expiresAt?: number;
  replacementWorkspaceId?: string;
}

function parseWorkspaceLifecycleDetails(input: unknown): BrowserAuthorizationWorkspaceLifecycleDetails | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (!['expired', 'evicted', 'engine_instance_changed', 'not_found', 'replaced'].includes(String(value.reason))) return undefined;
  if (typeof value.workspaceId !== 'string' || typeof value.engineInstanceId !== 'string') return undefined;
  return value as unknown as BrowserAuthorizationWorkspaceLifecycleDetails;
}

export function browserAuthorizationWorkspaceRecovery(error: unknown): {
  reason: BrowserAuthorizationWorkspaceLifecycleReason;
  message: string;
  details?: BrowserAuthorizationWorkspaceLifecycleDetails;
} | undefined {
  if (!(error instanceof ExtensionError) || !error.code.startsWith('authorization_workspace_')) return undefined;
  const details = parseWorkspaceLifecycleDetails(error.details);
  const reason = (details?.reason || error.code.slice('authorization_workspace_'.length)) as BrowserAuthorizationWorkspaceLifecycleReason;
  const messages: Record<BrowserAuthorizationWorkspaceLifecycleReason, string> = {
    expired: '授权工作区已自然过期。A/B 登录页不会受影响，请点击“新建”重新验证身份。',
    evicted: '该工作区因引擎内存容量达到上限而被淘汰。请点击“新建”重新建立，已有页面登录态不会丢失。',
    engine_instance_changed: 'Yak 引擎已经重启，旧工作区不能跨进程恢复。请确认引擎在线后点击“新建”。',
    not_found: '当前页面缓存的工作区在引擎中不存在。请点击“新建”重新建立身份工作区。',
    replaced: details?.replacementWorkspaceId
      ? '该工作区已被同一组身份的新工作区替换。请刷新页面状态，或点击“新建”重新建立。'
      : '该工作区已被更新的身份工作区替换。请点击“新建”重新建立。',
  };
  if (!(reason in messages)) return undefined;
  return { reason, message: messages[reason], details };
}

export interface BrowserAuthorizationRequestTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  transferMs: number;
  totalMs: number;
}

export interface BrowserAuthorizationEvidenceCase {
  id: string;
  label: string;
  authContextSide: 'left' | 'right';
  resourceValueSide: 'left' | 'right' | '';
  state: 'completed' | 'failed' | 'skipped';
  status?: number;
  outcome?: string;
  timing: BrowserAuthorizationRequestTiming;
  requestAvailable: boolean;
  responseAvailable: boolean;
  response?: {
    contentType: string;
    contentEncoding?: string;
    capturedBytes: number;
    analysisBytes?: number;
    declaredBytes?: number;
    truncated: boolean;
    decoded?: boolean;
    analysisState?: 'identity' | 'decoded' | 'encoded-unavailable';
    analysisRepresentation?: 'json' | 'html' | 'form' | 'text' | 'binary' | 'encoded';
  };
}

export interface BrowserAuthorizationEvidenceComparison {
  id: string;
  label: string;
  leftCaseId: string;
  rightCaseId: string;
  purpose: 'control' | 'authorization' | 'state-change';
}

export interface BrowserAuthorizationEvidenceBundle {
  version: 1;
  workspaceId: string;
  executionId: string;
  mode: BrowserAuthorizationMode;
  verdict: NonNullable<BrowserAuthorizationWorkspace['execution']>['verdict'];
  confidence: NonNullable<BrowserAuthorizationWorkspace['execution']>['confidence'];
  cases: BrowserAuthorizationEvidenceCase[];
  comparisons: BrowserAuthorizationEvidenceComparison[];
  semantic: NonNullable<BrowserAuthorizationWorkspace['execution']>['evidence'];
  representations: string[];
  expiresAt: number;
}

export interface BrowserAuthorizationEvidenceDiff {
  version: 1;
  workspaceId: string;
  executionId: string;
  leftCaseId: string;
  rightCaseId: string;
  scope: 'request' | 'response';
  view: 'redacted' | 'raw';
  representation: 'structured' | 'raw';
  equal: boolean;
  entries: Array<{
    path: string;
    kind: 'added' | 'removed' | 'changed';
    left?: string;
    right?: string;
    volatile: boolean;
    sensitive: boolean;
    semantic: boolean;
  }>;
  omitted: number;
}

export interface BrowserAuthorizationEvidencePacket {
  version: 1;
  workspaceId: string;
  executionId: string;
  caseId: string;
  side: 'request' | 'response';
  view: 'redacted' | 'raw';
  packetBase64: string;
  capturedBytes: number;
  truncated: boolean;
}

export interface BrowserAuthorizationEvidenceValidation {
  version: 1;
  workspaceId: string;
  executionId: string;
  direction: 'a-to-b' | 'b-to-a' | 'low-to-privileged' | 'post-state';
  verified: boolean;
  evidence: NonNullable<BrowserAuthorizationWorkspace['execution']>['evidence'];
  rejectedPaths: string[];
  verdict: NonNullable<BrowserAuthorizationWorkspace['execution']>['verdict'];
  confidence: NonNullable<BrowserAuthorizationWorkspace['execution']>['confidence'];
  verdictChanged: boolean;
  reason: string;
}

export type BrowserAuthorizationTaskSchema =
  | 'authorization.workspace.create'
  | 'authorization.workspace.inspect'
  | 'authorization.baseline.candidates'
  | 'authorization.baseline.bind'
  | 'authorization.logical.bind'
  | 'authorization.plan.create'
  | 'authorization.plan.execute'
  | 'authorization.evidence.inspect'
  | 'authorization.evidence.packet'
  | 'authorization.evidence.diff'
  | 'authorization.evidence.validate';

export async function runBrowserAuthorizationTask<T>(
  schema: BrowserAuthorizationTaskSchema,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  try {
    const result = await request('authorization.engine.task', { schema, payload, timeoutMs });
    return normalizeBrowserAuthorizationTaskResult<T>(schema, result);
  } catch (error) {
    const recovery = browserAuthorizationWorkspaceRecovery(error);
    if (!recovery || !(error instanceof ExtensionError)) throw error;
    throw new ExtensionError(error.code, recovery.message, recovery.details);
  }
}
