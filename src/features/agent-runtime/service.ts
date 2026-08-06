import { browser } from 'wxt/browser';
import { AGENT_RUNTIME_STORAGE_KEY } from '@/protocol/storage';
import type {
  AgentActionRecord, AgentActionState, AgentRuntime, AgentRuntimeState, BridgeGrant, RuntimeQueueMetric,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type AgentRuntimeCore = Omit<AgentRuntime, 'persistence' | 'persistenceError' | 'pendingMutations' | 'droppedActionCount'>;

const MAX_ACTIONS = 200;
const MAX_QUEUED_MUTATIONS = 1_024;
const FLUSH_DELAY_MS = 100;
const sessionStorage = (browser.storage as unknown as { session?: StorageArea }).session;

let runtimeCache: AgentRuntimeCore | undefined;
let restorePromise: Promise<void> | undefined;
let mutationQueue: Promise<void> = Promise.resolve();
let persistenceQueue: Promise<void> = Promise.resolve();
let flushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let queuedMutations = 0;
let pendingMutations = 0;
let droppedActionCount = 0;
let droppedMutationCount = 0;
let persistenceErrors = 0;
let persistenceError: string | undefined;

function emptyRuntime(): AgentRuntimeCore {
  return { state: 'idle', updatedAt: Date.now(), actions: [] };
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedString(value: unknown, max = 240): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function normalizeAction(input: unknown): AgentActionRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Partial<AgentActionRecord>;
  const states = new Set<AgentActionState>(['running', 'success', 'denied', 'error', 'cancelled']);
  const id = boundedString(value.id);
  const requestId = boundedString(value.requestId);
  const taskId = boundedString(value.taskId);
  const grantId = boundedString(value.grantId);
  const method = boundedString(value.method, 500);
  const startedAt = finiteTimestamp(value.startedAt);
  if (!id || !requestId || !taskId || !grantId || !method || !value.state
    || !states.has(value.state) || startedAt === undefined) return undefined;
  const targetTabId = Number.isSafeInteger(value.targetTabId) && Number(value.targetTabId) > 0
    ? Number(value.targetTabId)
    : undefined;
  return {
    id,
    requestId,
    taskId,
    grantId,
    method,
    targetTabId,
    isolationContextId: boundedString(value.isolationContextId, 500),
    state: value.state,
    startedAt,
    completedAt: finiteTimestamp(value.completedAt),
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
      ? value.durationMs
      : undefined,
    errorCode: boundedString(value.errorCode, 240),
  };
}

function normalizeRuntime(input: unknown): AgentRuntimeCore {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyRuntime();
  const value = input as Partial<AgentRuntime>;
  const allowedStates = new Set<AgentRuntimeState>(['idle', 'running', 'paused', 'waiting_for_human', 'revoked', 'expired']);
  const state = value.state && allowedStates.has(value.state) ? value.state : 'idle';
  const taskId = boundedString(value.taskId);
  const grantId = boundedString(value.grantId);
  if (state !== 'idle' && (!taskId || !grantId)) return emptyRuntime();
  const actions = Array.isArray(value.actions)
    ? value.actions
      .slice(-MAX_ACTIONS)
      .map(normalizeAction)
      .filter((action): action is AgentActionRecord => Boolean(action))
      .filter((action) => state !== 'idle' && action.taskId === taskId && action.grantId === grantId)
    : [];
  return {
    state,
    taskId: state === 'idle' ? undefined : taskId,
    grantId: state === 'idle' ? undefined : grantId,
    startedAt: state === 'idle' ? undefined : finiteTimestamp(value.startedAt),
    pausedAt: state === 'paused' ? finiteTimestamp(value.pausedAt) : undefined,
    updatedAt: finiteTimestamp(value.updatedAt) ?? Date.now(),
    actions,
  };
}

async function ensureRestored(): Promise<void> {
  if (runtimeCache) return;
  if (!restorePromise) {
    if (!sessionStorage) {
      runtimeCache = emptyRuntime();
      restorePromise = Promise.resolve();
    } else {
      restorePromise = sessionStorage.get(AGENT_RUNTIME_STORAGE_KEY).then((stored) => {
        runtimeCache = normalizeRuntime(stored[AGENT_RUNTIME_STORAGE_KEY]);
      }).catch((error) => {
        runtimeCache = emptyRuntime();
        persistenceErrors += 1;
        persistenceError = error instanceof Error ? error.message : String(error);
      });
    }
  }
  await restorePromise;
}

function persistenceState(): NonNullable<AgentRuntime['persistence']> {
  if (!sessionStorage) return 'memory-only';
  if (persistenceError) return 'degraded';
  return pendingMutations || queuedMutations ? 'pending' : 'persisted';
}

function publicRuntime(runtime: AgentRuntimeCore): AgentRuntime {
  return {
    ...runtime,
    persistence: persistenceState(),
    persistenceError: persistenceError?.slice(0, 512),
    pendingMutations: pendingMutations + queuedMutations,
    droppedActionCount: droppedActionCount + droppedMutationCount,
  };
}

function boundedActions(actions: AgentActionRecord[]): AgentActionRecord[] {
  if (actions.length <= MAX_ACTIONS) return actions;
  droppedActionCount += actions.length - MAX_ACTIONS;
  return actions.slice(-MAX_ACTIONS);
}

function scheduleFlush(): void {
  if (!sessionStorage || flushTimer !== undefined) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = undefined;
    void flushAgentRuntime().catch(() => undefined);
  }, FLUSH_DELAY_MS);
}

async function mutate(
  updater: (current: AgentRuntimeCore) => AgentRuntimeCore | Promise<AgentRuntimeCore>,
  immediate = false,
): Promise<AgentRuntime> {
  if (queuedMutations >= MAX_QUEUED_MUTATIONS) {
    droppedMutationCount += 1;
    throw new ExtensionError('capacity_exceeded', 'Agent action 状态队列已满，请稍后重试');
  }
  queuedMutations += 1;
  let output: AgentRuntimeCore | undefined;
  const operation = mutationQueue.then(async () => {
    await ensureRestored();
    const base = runtimeCache || emptyRuntime();
    const updated = await updater(base);
    if (updated === base) {
      output = base;
      return;
    }
    output = normalizeRuntime(updated);
    output.actions = boundedActions(output.actions);
    runtimeCache = output;
    pendingMutations += 1;
  }).finally(() => {
    queuedMutations -= 1;
  });
  mutationQueue = operation.catch(() => undefined);
  await operation;
  if (immediate) await flushAgentRuntime();
  else scheduleFlush();
  return publicRuntime(output || runtimeCache || emptyRuntime());
}

export async function flushAgentRuntime(): Promise<void> {
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
  await mutationQueue;
  if (!sessionStorage) {
    pendingMutations = 0;
    return;
  }
  let succeeded = false;
  const operation = persistenceQueue.then(async () => {
    await ensureRestored();
    if (!pendingMutations || !runtimeCache) {
      succeeded = true;
      return;
    }
    const snapshot = runtimeCache;
    const batchCount = pendingMutations;
    try {
      await sessionStorage.set({ [AGENT_RUNTIME_STORAGE_KEY]: snapshot });
      pendingMutations = Math.max(0, pendingMutations - batchCount);
      persistenceError = undefined;
      succeeded = true;
    } catch (error) {
      persistenceErrors += 1;
      persistenceError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  });
  persistenceQueue = operation.catch(() => undefined);
  await operation;
  if (succeeded && pendingMutations) scheduleFlush();
}

export async function getAgentRuntime(): Promise<AgentRuntime> {
  await mutationQueue;
  await ensureRestored();
  return publicRuntime(runtimeCache || emptyRuntime());
}

export function agentRuntimeQueueDiagnostics(): RuntimeQueueMetric {
  return {
    pending: pendingMutations + queuedMutations,
    dropped: droppedActionCount + droppedMutationCount,
    persistenceErrors,
    persistence: persistenceState(),
    error: persistenceError?.slice(0, 512),
  };
}

export function startAgentRuntime(grant: BridgeGrant): Promise<AgentRuntime> {
  const now = Date.now();
  return mutate((current) => ({
    state: 'running', taskId: grant.taskId, grantId: grant.id, startedAt: now,
    updatedAt: now, actions: current.grantId === grant.id ? current.actions : [],
  }), true);
}

export function setAgentRuntimeState(state: AgentRuntimeState, grant?: BridgeGrant): Promise<AgentRuntime> {
  return mutate((current) => {
    const now = Date.now();
    return {
      ...current,
      state,
      taskId: grant?.taskId || current.taskId,
      grantId: grant?.id || current.grantId,
      pausedAt: state === 'paused' ? now : undefined,
      updatedAt: now,
      actions: ['revoked', 'expired'].includes(state)
        ? current.actions.map((action) => action.state === 'running'
          ? { ...action, state: 'cancelled', completedAt: now, durationMs: now - action.startedAt, errorCode: state }
          : action)
        : current.actions,
    };
  }, true);
}

export function endAgentRuntimeForGrant(
  state: Extract<AgentRuntimeState, 'revoked' | 'expired'>,
  grant: BridgeGrant,
): Promise<AgentRuntime> {
  return mutate((current) => {
    if (current.grantId && current.grantId !== grant.id) return current;
    const now = Date.now();
    return {
      ...current,
      state,
      taskId: grant.taskId,
      grantId: grant.id,
      pausedAt: undefined,
      updatedAt: now,
      actions: current.actions.map((action) => action.state === 'running'
        ? {
          ...action,
          state: 'cancelled',
          completedAt: now,
          durationMs: now - action.startedAt,
          errorCode: state,
        }
        : action),
    };
  }, true);
}

export function clearAgentActions(): Promise<AgentRuntime> {
  return mutate((current) => ({ ...current, actions: [], updatedAt: Date.now() }), true);
}

export async function beginAgentAction(
  grant: BridgeGrant,
  input: {
    requestId: string;
    method: string;
    targetTabId?: number;
    isolationContextId?: string;
  },
): Promise<AgentActionRecord> {
  let created!: AgentActionRecord;
  await mutate((current) => {
    const runtime = current.grantId === grant.id
      ? current
      : { state: 'running' as const, taskId: grant.taskId, grantId: grant.id, startedAt: Date.now(), updatedAt: Date.now(), actions: [] };
    if (runtime.state === 'paused' || runtime.state === 'waiting_for_human') {
      throw new ExtensionError('agent_paused', runtime.state === 'waiting_for_human' ? 'Agent 正在等待用户完成接管步骤' : 'Agent 操作已被用户暂停');
    }
    if (runtime.state !== 'running') throw new ExtensionError('grant_expired', 'Agent 会话已经结束');
    created = {
      id: crypto.randomUUID(), requestId: input.requestId, taskId: grant.taskId, grantId: grant.id,
      method: input.method, targetTabId: input.targetTabId,
      isolationContextId: input.isolationContextId,
      state: 'running', startedAt: Date.now(),
    };
    return { ...runtime, updatedAt: Date.now(), actions: [...runtime.actions, created] };
  });
  return created;
}

export function finishAgentAction(id: string, state: Exclude<AgentActionState, 'running'>, errorCode?: string): Promise<AgentRuntime> {
  const now = Date.now();
  return mutate((current) => ({
    ...current,
    updatedAt: now,
    actions: current.actions.map((action) => action.id === id && action.state === 'running'
      ? { ...action, state, completedAt: now, durationMs: now - action.startedAt, errorCode }
      : action),
  }));
}
