import { browser } from 'wxt/browser';
import { AGENT_RUNTIME_STORAGE_KEY } from '@/protocol/storage';
import type {
  AgentActionRecord, AgentActionState, AgentRuntime, AgentRuntimeState, BridgeGrant,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const MAX_ACTIONS = 200;
const sessionStorage = (browser.storage as unknown as { session?: StorageArea }).session;
let queue: Promise<void> = Promise.resolve();
let fallbackRuntime: AgentRuntime | undefined;

function emptyRuntime(): AgentRuntime {
  return { state: 'idle', updatedAt: Date.now(), actions: [] };
}

function normalizeRuntime(input: unknown): AgentRuntime {
  if (!input || typeof input !== 'object') return emptyRuntime();
  const value = input as Partial<AgentRuntime>;
  return {
    state: value.state || 'idle',
    taskId: value.taskId,
    grantId: value.grantId,
    startedAt: value.startedAt,
    pausedAt: value.pausedAt,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    actions: Array.isArray(value.actions) ? value.actions.slice(-MAX_ACTIONS) : [],
  };
}

export async function getAgentRuntime(): Promise<AgentRuntime> {
  if (!sessionStorage) return fallbackRuntime || emptyRuntime();
  return normalizeRuntime((await sessionStorage.get(AGENT_RUNTIME_STORAGE_KEY))[AGENT_RUNTIME_STORAGE_KEY]);
}

async function mutate(updater: (current: AgentRuntime) => AgentRuntime | Promise<AgentRuntime>): Promise<AgentRuntime> {
  let resolveResult!: (runtime: AgentRuntime) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<AgentRuntime>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  queue = queue.then(async () => {
    try {
      const next = normalizeRuntime(await updater(await getAgentRuntime()));
      fallbackRuntime = next;
      await sessionStorage?.set({ [AGENT_RUNTIME_STORAGE_KEY]: next });
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

export function startAgentRuntime(grant: BridgeGrant): Promise<AgentRuntime> {
  const now = Date.now();
  return mutate((current) => ({
    state: 'running', taskId: grant.taskId, grantId: grant.id, startedAt: now,
    updatedAt: now, actions: current.grantId === grant.id ? current.actions : [],
  }));
}

export function setAgentRuntimeState(state: AgentRuntimeState, grant?: BridgeGrant): Promise<AgentRuntime> {
  return mutate((current) => ({
    ...current,
    state,
    taskId: grant?.taskId || current.taskId,
    grantId: grant?.id || current.grantId,
    pausedAt: state === 'paused' ? Date.now() : undefined,
    updatedAt: Date.now(),
    actions: ['revoked', 'expired'].includes(state)
      ? current.actions.map((action) => action.state === 'running'
        ? { ...action, state: 'cancelled', completedAt: Date.now(), durationMs: Date.now() - action.startedAt, errorCode: state }
        : action)
      : current.actions,
  }));
}

export function clearAgentActions(): Promise<AgentRuntime> {
  return mutate((current) => ({ ...current, actions: [], updatedAt: Date.now() }));
}

export async function beginAgentAction(
  grant: BridgeGrant,
  input: { requestId: string; method: string; targetTabId?: number },
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
      method: input.method, targetTabId: input.targetTabId, state: 'running', startedAt: Date.now(),
    };
    return { ...runtime, updatedAt: Date.now(), actions: [...runtime.actions, created].slice(-MAX_ACTIONS) };
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
