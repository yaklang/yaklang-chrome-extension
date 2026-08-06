import { browser } from 'wxt/browser';
import { stopNetworkCapturesForGrant } from '@/features/network-capture/service';
import { stopBrowserRecordingsForGrant } from '@/features/browser-recording/service';
import { stopDeepCapturesForGrant } from '@/features/deep-capture/service';
import {
  endAgentRuntimeForGrant, startAgentRuntime,
} from '@/features/agent-runtime/service';
import { appendAuditEvent } from '@/features/diagnostics/audit';
import { getState, updateState } from '@/platform/storage/state';
import type {
  BridgeGrant, BridgeGrantTarget, ExtensionState, HumanHandoff,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

export const ACTIVE_GRANT_EXPIRY_ALARM = 'yakit.active-grant.expiry';

type GrantEndReason = 'revoked' | 'expired' | 'replaced' | 'scheduler_failure' | 'activation_failure';

interface GrantLifecycleHooks {
  cancelActiveRequests?: () => void;
  emitHandoffChanged?: (handoff: HumanHandoff) => void;
}

export interface GrantTransition {
  state: ExtensionState;
  previousGrant?: BridgeGrant;
  previousHandoff?: HumanHandoff;
}

let lifecycleQueue: Promise<void> = Promise.resolve();
let listenersRegistered = false;
let hooks: GrantLifecycleHooks = {};
const cleanupTasks = new Map<string, Promise<void>>();
const cleanupOrder: string[] = [];

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycleQueue.then(operation);
  lifecycleQueue = next.then(() => undefined, () => undefined);
  return next;
}

function rememberCleanup(grantId: string, task: Promise<void>): Promise<void> {
  cleanupTasks.set(grantId, task);
  cleanupOrder.push(grantId);
  while (cleanupOrder.length > 256) {
    const oldest = cleanupOrder.shift();
    if (oldest) cleanupTasks.delete(oldest);
  }
  return task;
}

async function synchronizeExpiryAlarm(grant?: BridgeGrant): Promise<void> {
  if (grant && grant.expiresAt > Date.now()) {
    await browser.alarms.create(ACTIVE_GRANT_EXPIRY_ALARM, { when: grant.expiresAt });
    return;
  }
  await browser.alarms.clear(ACTIVE_GRANT_EXPIRY_ALARM);
}

async function clearExpiryAlarmBestEffort(grant: BridgeGrant): Promise<void> {
  try {
    await synchronizeExpiryAlarm(undefined);
  } catch (error) {
    console.error('Grant expiry alarm cleanup failed', error);
    void appendAuditEvent({
      category: 'grant',
      action: 'grant.expiry_alarm.clear',
      outcome: 'error',
      taskId: grant.taskId,
      targetTabId: grant.targets[0]?.tabId,
      errorCode: 'grant_alarm_failed',
      summary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    });
  }
}

function cancelledHandoff(current: HumanHandoff | undefined, now: number): HumanHandoff | undefined {
  return current?.state === 'waiting_for_user'
    ? { ...current, state: 'cancelled', resolvedAt: now }
    : current;
}

function cancelActiveRequestsBestEffort(grant: BridgeGrant): void {
  try {
    hooks.cancelActiveRequests?.();
  } catch (error) {
    console.error('Grant request cancellation failed', error);
    void appendAuditEvent({
      category: 'grant',
      action: 'grant.requests.cancel',
      outcome: 'error',
      taskId: grant.taskId,
      targetTabId: grant.targets[0]?.tabId,
      errorCode: 'grant_request_cancel_failed',
      summary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    });
  }
}

async function publishCancelledHandoff(
  previous: HumanHandoff | undefined,
  current: HumanHandoff | undefined,
  reason: GrantEndReason,
): Promise<void> {
  if (previous?.state !== 'waiting_for_user' || !current) return;
  await browser.action.setBadgeText({ text: '', tabId: previous.target.tabId }).catch(() => undefined);
  try {
    hooks.emitHandoffChanged?.(current);
  } catch (error) {
    console.error('Handoff cancellation event failed', error);
  }
  void appendAuditEvent({
    category: 'handoff',
    action: 'handoff.cancelled',
    outcome: 'cancelled',
    taskId: previous.taskId,
    targetTabId: previous.target.tabId,
    summary: reason === 'expired'
      ? '共享会话到期时取消'
      : reason === 'replaced' ? '创建新共享会话时取消' : '撤销共享会话时取消',
  });
}

function cleanupGrantResources(grant: BridgeGrant, reason: GrantEndReason): Promise<void> {
  const existing = cleanupTasks.get(grant.id);
  if (existing) return existing;
  const runtimeState = reason === 'expired' ? 'expired' as const : 'revoked' as const;
  const task = Promise.allSettled([
    stopNetworkCapturesForGrant(grant.id),
    stopBrowserRecordingsForGrant(grant.id),
    stopDeepCapturesForGrant(grant.id),
    endAgentRuntimeForGrant(runtimeState, grant),
  ]).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length === 0) return;
    void appendAuditEvent({
      category: 'grant',
      action: 'grant.cleanup',
      outcome: 'error',
      taskId: grant.taskId,
      targetTabId: grant.targets[0]?.tabId,
      errorCode: 'grant_cleanup_failed',
      summary: `${failures.length} 个会话资源清理失败`,
    });
    console.error(`Grant ${grant.id} cleanup failed`, failures);
  });
  return rememberCleanup(grant.id, task);
}

async function endActiveGrantInQueue(
  reason: GrantEndReason,
  expectedGrantId?: string,
  now = Date.now(),
): Promise<GrantTransition> {
  let previousGrant: BridgeGrant | undefined;
  let previousHandoff: HumanHandoff | undefined;
  const state = await updateState((current) => {
    const grant = current.activeGrant;
    if (!grant || (expectedGrantId && grant.id !== expectedGrantId)) return current;
    if (reason === 'expired' && grant.expiresAt > now) return current;
    previousGrant = grant;
    previousHandoff = current.handoff;
    return {
      ...current,
      activeGrant: undefined,
      handoff: cancelledHandoff(current.handoff, now),
    };
  });

  if (!previousGrant) {
    if (state.activeGrant) await synchronizeExpiryAlarm(state.activeGrant);
    else await browser.alarms.clear(ACTIVE_GRANT_EXPIRY_ALARM).catch(() => false);
    return { state };
  }

  cancelActiveRequestsBestEffort(previousGrant);
  await clearExpiryAlarmBestEffort(previousGrant);
  await cleanupGrantResources(previousGrant, reason);
  await publishCancelledHandoff(previousHandoff, state.handoff, reason);
  void appendAuditEvent({
    category: 'grant',
    action: reason === 'expired' ? 'grant.expire' : 'grant.revoke',
    outcome: 'success',
    taskId: previousGrant.taskId,
    targetTabId: previousGrant.targets[0]?.tabId,
    summary: reason === 'replaced'
      ? '已由新共享会话替换'
      : reason === 'scheduler_failure'
        ? '无法建立可靠的到期调度，已安全撤销'
        : reason === 'activation_failure' ? 'Agent Runtime 初始化失败，已安全撤销' : undefined,
  });
  return { state, previousGrant, previousHandoff };
}

export function configureGrantLifecycleHooks(next: GrantLifecycleHooks): void {
  hooks = { ...next };
}

export function registerGrantLifecycleListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ACTIVE_GRANT_EXPIRY_ALARM) return;
    void reconcileGrantLifecycle(true).catch((error) => {
      console.error('Grant expiry reconciliation failed', error);
    });
  });
}

export function restoreGrantLifecycle(): Promise<ExtensionState> {
  return reconcileGrantLifecycle(true).then((transition) => transition.state);
}

async function reconcileGrantLifecycle(synchronizeAlarm: boolean): Promise<GrantTransition> {
  return enqueueLifecycle(async () => {
    const current = await getState();
    if (current.activeGrant?.expiresAt && current.activeGrant.expiresAt <= Date.now()) {
      return endActiveGrantInQueue('expired', current.activeGrant.id);
    }
    if (synchronizeAlarm) {
      try {
        await synchronizeExpiryAlarm(current.activeGrant);
      } catch (error) {
        if (!current.activeGrant) {
          console.error('Stale Grant expiry alarm cleanup failed', error);
          return { state: current };
        }
        void appendAuditEvent({
          category: 'grant',
          action: 'grant.expiry_alarm.schedule',
          outcome: 'error',
          taskId: current.activeGrant.taskId,
          targetTabId: current.activeGrant.targets[0]?.tabId,
          errorCode: 'grant_alarm_failed',
          summary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        });
        return endActiveGrantInQueue('scheduler_failure', current.activeGrant.id);
      }
    }
    return { state: current };
  });
}

export function currentActiveGrant(): Promise<BridgeGrant | undefined> {
  return reconcileGrantLifecycle(false).then(({ state }) => state.activeGrant);
}

export function replaceActiveGrant(grant: BridgeGrant): Promise<GrantTransition> {
  return enqueueLifecycle(async () => {
    if (grant.expiresAt <= Date.now()) {
      throw new ExtensionError('grant_expired', '不能创建已经过期的浏览器共享会话');
    }
    let previousGrant: BridgeGrant | undefined;
    let previousHandoff: HumanHandoff | undefined;
    const now = Date.now();
    await synchronizeExpiryAlarm(grant);
    let state: ExtensionState;
    try {
      state = await updateState((current) => {
        previousGrant = current.activeGrant;
        previousHandoff = current.handoff;
        return {
          ...current,
          activeGrant: grant,
          handoff: cancelledHandoff(current.handoff, now),
        };
      });
    } catch (error) {
      await synchronizeExpiryAlarm((await getState()).activeGrant).catch(() => undefined);
      throw error;
    }

    if (previousGrant && previousGrant.id !== grant.id) {
      cancelActiveRequestsBestEffort(previousGrant);
      await cleanupGrantResources(previousGrant, 'replaced');
    }
    try {
      await startAgentRuntime(grant);
    } catch (error) {
      await endActiveGrantInQueue('activation_failure', grant.id);
      throw new ExtensionError(
        'grant_activation_failed',
        `无法初始化浏览器共享会话: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await publishCancelledHandoff(previousHandoff, state.handoff, 'replaced');
    return { state, previousGrant, previousHandoff };
  });
}

export function revokeActiveGrant(expectedGrantId?: string): Promise<GrantTransition> {
  return enqueueLifecycle(() => endActiveGrantInQueue('revoked', expectedGrantId));
}

export function updateActiveGrant(
  expectedGrantId: string,
  updater: (grant: BridgeGrant) => BridgeGrant,
): Promise<ExtensionState> {
  return enqueueLifecycle(async () => {
    const before = await getState();
    if (!before.activeGrant || before.activeGrant.id !== expectedGrantId) {
      throw new ExtensionError('grant_expired', '共享会话已经变化，请重试');
    }
    if (before.activeGrant.expiresAt <= Date.now()) {
      await endActiveGrantInQueue('expired', expectedGrantId);
      throw new ExtensionError('grant_expired', '共享会话不存在或已经过期');
    }
    const nextGrant = updater(before.activeGrant);
    await synchronizeExpiryAlarm(nextGrant);
    let state: ExtensionState;
    try {
      state = await updateState((current) => {
        if (!current.activeGrant || current.activeGrant.id !== expectedGrantId) {
          throw new ExtensionError('grant_expired', '共享会话已经变化，请重试');
        }
        return { ...current, activeGrant: nextGrant };
      });
    } catch (error) {
      await synchronizeExpiryAlarm((await getState()).activeGrant).catch(() => undefined);
      throw error;
    }
    return state;
  });
}

export function requireActiveGrant(): Promise<BridgeGrant> {
  return currentActiveGrant().then((grant) => {
    if (!grant) throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期');
    return grant;
  });
}

export function rebindGrantTargets(
  grantId: string,
  targets: BridgeGrantTarget[],
): Promise<ExtensionState> {
  return updateActiveGrant(grantId, (grant) => ({ ...grant, targets }));
}
