import type { NetworkCaptureStatus } from '@/types/models';
import type {
  BrowserAuthorizationBaselineCandidate,
  BrowserAuthorizationMode,
  BrowserAuthorizationSide,
  BrowserAuthorizationWorkspace,
} from '../engine';
import { normalizeBrowserAuthorizationTaskResult } from '../protocol';

export const EMPTY_AUTHORIZATION_CANDIDATES: Record<
  BrowserAuthorizationSide,
  BrowserAuthorizationBaselineCandidate[]
> = { left: [], right: [] };

const EMPTY_SELECTION: Record<BrowserAuthorizationSide, string> = { left: '', right: '' };

export interface PersistedAuthorizationWorkspaceUI {
  mode: BrowserAuthorizationMode;
  leftDeviceId: string;
  rightDeviceId: string;
  leftTabId?: number;
  rightTabId?: number;
  leftLabel: string;
  rightLabel: string;
  workspace?: BrowserAuthorizationWorkspace;
  candidates: Record<BrowserAuthorizationSide, BrowserAuthorizationBaselineCandidate[]>;
  selected: Record<BrowserAuthorizationSide, string>;
  selectedPlanCandidateId: string;
  canaryPaths: string;
}

export interface AuthorizationWorkspaceUIState extends PersistedAuthorizationWorkspaceUI {
  capture: Partial<Record<BrowserAuthorizationSide, NetworkCaptureStatus>>;
}

export const INITIAL_AUTHORIZATION_WORKSPACE_UI: AuthorizationWorkspaceUIState = {
  mode: 'horizontal',
  leftDeviceId: '',
  rightDeviceId: '',
  leftLabel: '账号 A',
  rightLabel: '账号 B',
  candidates: EMPTY_AUTHORIZATION_CANDIDATES,
  selected: EMPTY_SELECTION,
  selectedPlanCandidateId: '',
  canaryPaths: '',
  capture: {},
};

export type AuthorizationWorkspaceUIAction =
  | { type: 'hydrate'; value?: unknown }
  | { type: 'patch'; value: Partial<AuthorizationWorkspaceUIState> }
  | { type: 'workspace.initialize'; workspace: BrowserAuthorizationWorkspace }
  | { type: 'workspace.updated'; workspace: BrowserAuthorizationWorkspace }
  | { type: 'workspace.reset' }
  | {
    type: 'baselines.loaded';
    candidates: Record<BrowserAuthorizationSide, BrowserAuthorizationBaselineCandidate[]>;
    selected: Record<BrowserAuthorizationSide, string>;
  }
  | {
    type: 'baselines.bound';
    workspace: BrowserAuthorizationWorkspace;
    selectedPlanCandidateId: string;
  }
  | { type: 'capture.replace'; capture: AuthorizationWorkspaceUIState['capture'] }
  | { type: 'capture.update'; side: BrowserAuthorizationSide; status: NetworkCaptureStatus };

export type AuthorizationWorkspaceStage =
  | 'identity'
  | 'recovery'
  | 'normal-requests'
  | 'plan'
  | 'execution'
  | 'evidence';

export function authorizationWorkspaceStage(
  state: AuthorizationWorkspaceUIState,
): AuthorizationWorkspaceStage {
  const workspace = state.workspace;
  if (!workspace) return 'identity';
  if (workspace.state === 'stale' || workspace.state === 'blocked') return 'recovery';
  if (!workspace.baselines.left || !workspace.baselines.right) return 'normal-requests';
  if (!workspace.plan) return 'plan';
  if (!workspace.execution) return 'execution';
  return 'evidence';
}

function normalizedCandidates(
  value: PersistedAuthorizationWorkspaceUI['candidates'] | undefined,
): PersistedAuthorizationWorkspaceUI['candidates'] {
  return {
    left: Array.isArray(value?.left) ? value.left : [],
    right: Array.isArray(value?.right) ? value.right : [],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown, max = 100): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string');
}

function safeWorkspaceForUI(input: unknown): BrowserAuthorizationWorkspace | undefined {
  let workspace: BrowserAuthorizationWorkspace;
  try {
    workspace = normalizeBrowserAuthorizationTaskResult<BrowserAuthorizationWorkspace>(
      'authorization.workspace.inspect',
      input,
    );
  } catch {
    return undefined;
  }
  const value = workspace as unknown as Record<string, unknown>;
  const left = record(value.left);
  const right = record(value.right);
  const proof = record(value.proof);
  const baselines = record(value.baselines);
  const pair = record(value.baselinePair);
  const validSide = (side: Record<string, unknown> | undefined) => {
    const target = record(side?.target);
    const authentication = record(side?.authentication);
    return Boolean(side && target && authentication
      && typeof side.deviceId === 'string' && side.deviceId
      && Number.isSafeInteger(target.tabId) && Number(target.tabId) > 0
      && Number.isSafeInteger(target.frameId) && Number(target.frameId) >= 0
      && typeof target.documentId === 'string' && target.documentId
      && ['authenticated', 'unauthenticated', 'unknown'].includes(String(authentication.status))
      && Number.isFinite(authentication.cookieCount)
      && Number.isFinite(authentication.storageEntryCount));
  };
  if (value.version !== 1 || typeof value.id !== 'string' || !value.id
    || typeof value.engineInstanceId !== 'string' || !value.engineInstanceId
    || !['horizontal', 'vertical'].includes(String(value.mode))
    || !['ready', 'conditional', 'blocked', 'stale'].includes(String(value.state))
    || !Number.isFinite(value.expiresAt)
    || !validSide(left) || !validSide(right) || !proof || !baselines || !pair
    || !['strong', 'conditional', 'none'].includes(String(proof.level))
    || typeof proof.sameOrigin !== 'boolean'
    || !['different', 'same', 'unknown'].includes(String(proof.cookieStoreRelation))
    || !['different', 'same', 'unknown'].includes(String(proof.accountEvidenceRelation))
    || !['different', 'same', 'unknown'].includes(String(proof.requestCredentialRelation))
    || !['passed', 'failed', 'not-required'].includes(String(proof.refreshCheck))
    || !stringArray(proof.reasons)
    || !['waiting', 'matched', 'mismatch'].includes(String(pair.state))
    || !stringArray(pair.reasons)
    || !Array.isArray(pair.resourceCandidates) || !Array.isArray(pair.operationCandidates)) return undefined;

  const resourceCandidatesValid = pair.resourceCandidates.every((item) => {
    const candidate = record(item);
    return Boolean(candidate && typeof candidate.id === 'string' && candidate.id
      && ['wire', 'logical'].includes(String(candidate.source))
      && ['header', 'path', 'query', 'body'].includes(String(candidate.location))
      && typeof candidate.path === 'string' && typeof candidate.category === 'string'
      && ['high', 'medium', 'low'].includes(String(candidate.confidence))
      && typeof candidate.requiresLogicalBinding === 'boolean'
      && stringArray(candidate.reasons));
  });
  const operationCandidatesValid = pair.operationCandidates.every((item) => {
    const candidate = record(item);
    return Boolean(candidate && typeof candidate.id === 'string' && candidate.id
      && typeof candidate.method === 'string' && typeof candidate.path === 'string'
      && typeof candidate.eligible === 'boolean' && typeof candidate.sideEffect === 'boolean'
      && typeof candidate.requiresDynamicRebuild === 'boolean'
      && stringArray(candidate.authenticationPaths) && stringArray(candidate.dynamicPaths)
      && stringArray(candidate.reasons));
  });
  if (!resourceCandidatesValid || !operationCandidatesValid) return undefined;

  if (value.plan !== undefined) {
    const plan = record(value.plan);
    const selector = record(plan?.selector);
    if (!plan || !selector || typeof plan.id !== 'string' || !plan.id
      || !['horizontal', 'vertical'].includes(String(plan.mode))
      || typeof plan.candidateId !== 'string'
      || !['ready', 'review-required', 'blocked'].includes(String(plan.state))
      || typeof selector.source !== 'string' || typeof selector.location !== 'string'
      || typeof selector.path !== 'string' || !Array.isArray(plan.cases)
      || !Number.isSafeInteger(plan.requestBudget) || Number(plan.requestBudget) < 0
      || typeof plan.requiresDynamicRebuild !== 'boolean' || !stringArray(plan.reasons)
      || !plan.cases.every((item) => {
        const testCase = record(item);
        return Boolean(testCase && typeof testCase.id === 'string' && typeof testCase.label === 'string'
          && ['left', 'right'].includes(String(testCase.authContextSide))
          && ['left', 'right', ''].includes(String(testCase.resourceValueSide))
          && typeof testCase.method === 'string' && typeof testCase.path === 'string'
          && typeof testCase.sideEffect === 'boolean');
      })) return undefined;
  }

  if (value.execution !== undefined) {
    const execution = record(value.execution);
    if (!execution || typeof execution.id !== 'string' || !execution.id
      || !['completed', 'partial'].includes(String(execution.state))
      || !['confirmed', 'likely', 'protected', 'inconclusive', 'invalid-controls'].includes(String(execution.verdict))
      || !['high', 'medium', 'low', 'none'].includes(String(execution.confidence))
      || !Number.isSafeInteger(execution.requestCount) || Number(execution.requestCount) < 0
      || typeof execution.evidenceAvailable !== 'boolean'
      || !Array.isArray(execution.cases) || !Array.isArray(execution.evidence)
      || !stringArray(execution.reasons)
      || !execution.cases.every((item) => {
        const testCase = record(item);
        const result = record(testCase?.result);
        return Boolean(testCase && typeof testCase.id === 'string' && typeof testCase.label === 'string'
          && ['completed', 'failed', 'skipped'].includes(String(testCase.state))
          && (!result || (Number.isFinite(result.status) && typeof result.statusText === 'string'
            && typeof result.outcome === 'string' && Number.isFinite(result.durationMs))));
      })) return undefined;
  }
  return workspace;
}

function normalizePersistedCandidate(input: unknown): BrowserAuthorizationBaselineCandidate | undefined {
  const candidate = record(input);
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id
    || typeof candidate.method !== 'string' || !candidate.method
    || typeof candidate.url !== 'string' || typeof candidate.path !== 'string'
    || typeof candidate.resourceType !== 'string' || !Number.isFinite(candidate.startedAt)
    || typeof candidate.eligible !== 'boolean' || !stringArray(candidate.reasons)) return undefined;
  try {
    const parsed = new URL(candidate.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
  } catch {
    return undefined;
  }
  return {
    id: candidate.id.slice(0, 240),
    method: candidate.method.slice(0, 32),
    url: candidate.url.slice(0, 8_192),
    path: candidate.path.slice(0, 4_096),
    resourceType: candidate.resourceType.slice(0, 120),
    startedAt: Number(candidate.startedAt),
    completedAt: Number.isFinite(candidate.completedAt) ? Number(candidate.completedAt) : undefined,
    durationMs: Number.isFinite(candidate.durationMs) ? Number(candidate.durationMs) : undefined,
    statusCode: Number.isSafeInteger(candidate.statusCode) ? Number(candidate.statusCode) : undefined,
    error: typeof candidate.error === 'string' ? candidate.error.slice(0, 1_024) : undefined,
    eligible: candidate.eligible,
    reasons: (candidate.reasons as string[]).slice(0, 20).map((item) => item.slice(0, 1_024)),
  };
}

export function normalizePersistedAuthorizationWorkspaceUI(
  input: unknown,
): Partial<PersistedAuthorizationWorkspaceUI> | undefined {
  const value = record(input);
  if (!value) return undefined;
  const workspace = value.workspace === undefined ? undefined : safeWorkspaceForUI(value.workspace);
  const candidateInput = record(value.candidates);
  const candidates = workspace ? {
    left: (Array.isArray(candidateInput?.left) ? candidateInput.left : [])
      .slice(0, 50).map(normalizePersistedCandidate)
      .filter((item): item is BrowserAuthorizationBaselineCandidate => Boolean(item)),
    right: (Array.isArray(candidateInput?.right) ? candidateInput.right : [])
      .slice(0, 50).map(normalizePersistedCandidate)
      .filter((item): item is BrowserAuthorizationBaselineCandidate => Boolean(item)),
  } : EMPTY_AUTHORIZATION_CANDIDATES;
  const selectedInput = record(value.selected);
  const selected = {
    left: typeof selectedInput?.left === 'string'
      && candidates.left.some((item) => item.id === selectedInput.left) ? selectedInput.left : '',
    right: typeof selectedInput?.right === 'string'
      && candidates.right.some((item) => item.id === selectedInput.right) ? selectedInput.right : '',
  };
  return {
    mode: value.mode === 'vertical' ? 'vertical' : 'horizontal',
    leftDeviceId: typeof value.leftDeviceId === 'string' ? value.leftDeviceId.slice(0, 320) : '',
    rightDeviceId: typeof value.rightDeviceId === 'string' ? value.rightDeviceId.slice(0, 320) : '',
    leftTabId: Number.isSafeInteger(value.leftTabId) && Number(value.leftTabId) > 0 ? Number(value.leftTabId) : undefined,
    rightTabId: Number.isSafeInteger(value.rightTabId) && Number(value.rightTabId) > 0 ? Number(value.rightTabId) : undefined,
    leftLabel: typeof value.leftLabel === 'string' ? value.leftLabel.slice(0, 80) : '账号 A',
    rightLabel: typeof value.rightLabel === 'string' ? value.rightLabel.slice(0, 80) : '账号 B',
    workspace,
    candidates,
    selected,
    selectedPlanCandidateId: workspace && typeof value.selectedPlanCandidateId === 'string'
      ? value.selectedPlanCandidateId.slice(0, 240)
      : '',
    canaryPaths: typeof value.canaryPaths === 'string' ? value.canaryPaths.slice(0, 4_096) : '',
  };
}

export function authorizationWorkspaceUIReducer(
  state: AuthorizationWorkspaceUIState,
  action: AuthorizationWorkspaceUIAction,
): AuthorizationWorkspaceUIState {
  switch (action.type) {
    case 'hydrate': {
      const value = normalizePersistedAuthorizationWorkspaceUI(action.value);
      if (!value) return state;
      return {
        ...state,
        mode: value.mode === 'vertical' ? 'vertical' : 'horizontal',
        leftDeviceId: value.leftDeviceId || '',
        rightDeviceId: value.rightDeviceId || '',
        leftTabId: value.leftTabId,
        rightTabId: value.rightTabId,
        leftLabel: value.leftLabel || '账号 A',
        rightLabel: value.rightLabel || '账号 B',
        workspace: value.workspace,
        candidates: normalizedCandidates(value.candidates),
        selected: {
          left: value.selected?.left || '',
          right: value.selected?.right || '',
        },
        selectedPlanCandidateId: value.selectedPlanCandidateId || '',
        canaryPaths: value.canaryPaths || '',
      };
    }
    case 'patch': return { ...state, ...action.value };
    case 'workspace.initialize':
      return {
        ...state,
        workspace: action.workspace,
        candidates: EMPTY_AUTHORIZATION_CANDIDATES,
        selected: EMPTY_SELECTION,
        selectedPlanCandidateId: '',
      };
    case 'workspace.updated':
      return { ...state, workspace: action.workspace };
    case 'workspace.reset':
      return {
        ...state,
        workspace: undefined,
        candidates: EMPTY_AUTHORIZATION_CANDIDATES,
        selected: EMPTY_SELECTION,
        selectedPlanCandidateId: '',
        capture: {},
      };
    case 'baselines.loaded':
      return {
        ...state,
        candidates: action.candidates,
        selected: action.selected,
      };
    case 'baselines.bound':
      return {
        ...state,
        workspace: action.workspace,
        selectedPlanCandidateId: action.selectedPlanCandidateId,
      };
    case 'capture.replace':
      return { ...state, capture: action.capture };
    case 'capture.update':
      return {
        ...state,
        capture: { ...state.capture, [action.side]: action.status },
      };
  }
}

export function persistedAuthorizationWorkspaceUI(
  state: AuthorizationWorkspaceUIState,
): PersistedAuthorizationWorkspaceUI {
  return {
    mode: state.mode,
    leftDeviceId: state.leftDeviceId,
    rightDeviceId: state.rightDeviceId,
    leftTabId: state.leftTabId,
    rightTabId: state.rightTabId,
    leftLabel: state.leftLabel,
    rightLabel: state.rightLabel,
    workspace: state.workspace,
    candidates: state.candidates,
    selected: state.selected,
    selectedPlanCandidateId: state.selectedPlanCandidateId,
    canaryPaths: state.canaryPaths,
  };
}
