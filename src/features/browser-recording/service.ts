import { browser, type Browser } from 'wxt/browser';
import { getTab, scriptingTarget } from '@/platform/browser/targets';
import type {
  BrowserDeepCaptureMatcher, BrowserPageCallable, BrowserRecordingCallArgument, BrowserRecordingEvent, BrowserRecordingNavigation,
  BrowserRecordingOptions, BrowserRecordingSnapshot, BrowserRecordingStatus,
  BrowserRecordingValueEvidence, BrowserTarget,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { inferBrowserTransformProfiles } from '@/features/browser-inference/inference';
import { normalizeBrowserRecordingCrypto } from '@/features/browser-crypto/model';
import { normalizeCallable } from '@/features/page-callable/service';
import { PAGE_RECORDER_PROTOCOL_VERSION, PAGE_RECORDER_REGISTRY_KEY } from './constants';
import {
  buildRecordingLinks,
  buildRecordingTraces,
  latestRecordingTraceId,
  MAX_RECORDING_EVENTS,
  mergeRecordingEvents,
  nextRecordingSequence,
} from './timeline';
import { recordingSnapshotForScope } from './redaction';
import { executeFirefoxPageRecorderCommand } from './bridge-client';
import type { PageRecorderBridgeCommand } from './bridge-protocol';
import {
  RECORDING_GLOBAL_MAX_BYTES,
  RECORDING_MAX_SESSIONS,
  RECORDING_SNAPSHOT_MAX_BYTES,
  boundRecordingPreviews,
  recordingEventPreviewBytes,
  recordingSerializedBytes,
} from './budget';

const RECORDER_SCRIPT = '/page-recorder-main-world.js' as const;
const DEFAULT_OPTIONS: BrowserRecordingOptions = { captureValues: false, maxEntries: 200, maxValueBytes: 2_048 };
const MAX_ENTRIES = MAX_RECORDING_EVENTS;
const RECORDING_SNAPSHOT_PAYLOAD_TARGET_BYTES = 7 * 256 * 1024;

interface RawRecorderSnapshot {
  version: typeof PAGE_RECORDER_PROTOCOL_VERSION;
  active: boolean;
  recordingId?: string;
  startedAt?: number;
  count: number;
  droppedCount: number;
  retainedCallCount: number;
  retainedCallBytes: number;
  retainedCallDroppedCount: number;
  options?: BrowserRecordingOptions;
  events: BrowserRecordingEvent[];
  callables: unknown[];
}

interface OwnedRecording {
  target: BrowserTarget;
  owner: { kind: 'local' } | { kind: 'grant'; grantId: string; expiresAt: number };
}

interface StoredRecordingSession {
  snapshot: BrowserRecordingSnapshot;
  owner?: OwnedRecording['owner'];
}

interface StoredRecordingState {
  version: 4;
  sessions: Record<string, StoredRecordingSession>;
}

type RecordingSessionStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

type RecorderCommand = 'start' | 'resume' | 'status' | 'get' | 'clear' | 'stop' | 'navigation.record'
  | 'callable.create' | 'deep.arm' | 'deep.disarm';
const ownedRecordings = new Map<string, OwnedRecording>();
const latestSnapshots = new Map<string, BrowserRecordingSnapshot>();
const snapshotSignatures = new Map<string, string>();
const sessionOwners = new Map<string, OwnedRecording['owner']>();
const lifecycleQueues = new Map<string, Promise<void>>();
const removedTabs = new Set<number>();
const RECORDING_SESSION_STORAGE_KEY = 'session.browser-recording-sessions.v4';
const RECORDING_PERSIST_DELAY_MS = 500;
const sessionStorage = (browser.storage as unknown as { session?: RecordingSessionStorage } | undefined)?.session;
let persistTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let persistInFlight = false;
let mutationRevision = 0;
let sessionRestorePromise: Promise<void> | undefined;
let sessionRestoreError: string | undefined;
let serviceInitialized = false;

function expiredGrantOwner(owner: OwnedRecording['owner'] | undefined): boolean {
  return owner?.kind === 'grant'
    && (!Number.isFinite(owner.expiresAt) || owner.expiresAt <= Date.now());
}

function targetKey(target: BrowserTarget): string {
  return `${target.tabId}:${target.frameId}`;
}

function persistenceError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function isStoredRecordingSession(value: unknown): value is StoredRecordingSession {
  if (!value || typeof value !== 'object') return false;
  const snapshot = (value as StoredRecordingSession).snapshot;
  return Boolean(snapshot?.status?.target
    && Number.isSafeInteger(snapshot.status.target.tabId)
    && Number.isSafeInteger(snapshot.status.target.frameId)
    && Array.isArray(snapshot.events)
    && Array.isArray(snapshot.callables));
}

async function readStoredSessions(): Promise<Record<string, StoredRecordingSession>> {
  if (!sessionStorage) return {};
  try {
    const stored = await sessionStorage.get(RECORDING_SESSION_STORAGE_KEY);
    const value = stored[RECORDING_SESSION_STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    const state = value as Partial<StoredRecordingState>;
    if (state.version !== 4 || !state.sessions || typeof state.sessions !== 'object') {
      sessionRestoreError = '录制会话存储格式损坏，已忽略并等待重建';
      return {};
    }
    const entries = Object.entries(state.sessions);
    const valid = entries.filter((entry): entry is [string, StoredRecordingSession] => (
      isStoredRecordingSession(entry[1])
    ));
    if (valid.length !== entries.length) {
      sessionRestoreError = `已忽略 ${entries.length - valid.length} 个损坏的录制会话`;
    }
    return Object.fromEntries(valid);
  } catch (error) {
    sessionRestoreError = persistenceError(error);
    return {};
  }
}

function refreshSnapshotSize(snapshot: BrowserRecordingSnapshot): void {
  snapshot.status.retainedBytes = recordingSerializedBytes(snapshot);
  snapshot.status.retainedBytes = recordingSerializedBytes(snapshot);
}

function oldestInactiveSessionKey(): string | undefined {
  return [...latestSnapshots.entries()]
    .filter(([, snapshot]) => !snapshot.status.active)
    .sort(([leftKey, left], [rightKey, right]) => (
      (left.status.startedAt || 0) - (right.status.startedAt || 0)
      || leftKey.localeCompare(rightKey)
    ))[0]?.[0];
}

function deleteSessionMemory(key: string): void {
  latestSnapshots.delete(key);
  snapshotSignatures.delete(key);
  sessionOwners.delete(key);
  ownedRecordings.delete(key);
}

function enforceGlobalRecordingBudget(): void {
  while (latestSnapshots.size > RECORDING_MAX_SESSIONS) {
    const oldest = oldestInactiveSessionKey();
    if (!oldest) break;
    deleteSessionMemory(oldest);
  }

  for (const snapshot of latestSnapshots.values()) refreshSnapshotSize(snapshot);
  let total = [...latestSnapshots.values()].reduce(
    (sum, snapshot) => sum + (snapshot.status.retainedBytes || 0),
    0,
  );
  while (total > RECORDING_GLOBAL_MAX_BYTES) {
    const candidates = [...latestSnapshots.entries()].flatMap(([key, snapshot]) => (
      snapshot.events.map((event) => ({ key, event }))
    )).sort((left, right) => (
      left.event.timestamp - right.event.timestamp
      || left.event.sequence - right.event.sequence
      || left.key.localeCompare(right.key)
      || left.event.id.localeCompare(right.event.id)
    ));
    if (candidates.length) {
      const excessRatio = Math.min(0.5, Math.max(0.01, (total - RECORDING_GLOBAL_MAX_BYTES) / total));
      const removeCount = Math.max(1, Math.ceil(candidates.length * excessRatio));
      const removals = new Map<string, number>();
      for (const candidate of candidates.slice(0, removeCount)) {
        removals.set(candidate.key, (removals.get(candidate.key) || 0) + 1);
      }
      for (const [key, count] of removals) {
        const snapshot = latestSnapshots.get(key);
        if (!snapshot) continue;
        const removed = snapshot.events.slice(0, count);
        latestSnapshots.set(key, snapshotFromEvents(
          snapshot.status.target,
          {
            ...snapshot.status,
            budgetDroppedCount: (snapshot.status.budgetDroppedCount || 0) + removed.length,
            retentionFloorSequence: Math.max(
              snapshot.status.retentionFloorSequence || 0,
              (removed.at(-1)?.sequence || 0) + 1,
            ),
          },
          snapshot.events.slice(count),
          snapshot.callables,
        ));
      }
    } else {
      const oldest = oldestInactiveSessionKey();
      if (!oldest) break;
      deleteSessionMemory(oldest);
    }
    total = [...latestSnapshots.values()].reduce((sum, snapshot) => {
      refreshSnapshotSize(snapshot);
      return sum + (snapshot.status.retainedBytes || 0);
    }, 0);
  }

  const sessionCount = latestSnapshots.size;
  for (const snapshot of latestSnapshots.values()) {
    snapshot.status.globalSessionCount = sessionCount;
    snapshot.status.globalRetainedBytes = total;
    refreshSnapshotSize(snapshot);
  }
  total = [...latestSnapshots.values()].reduce(
    (sum, snapshot) => sum + (snapshot.status.retainedBytes || 0),
    0,
  );
  for (const snapshot of latestSnapshots.values()) snapshot.status.globalRetainedBytes = total;
  for (const [key, snapshot] of latestSnapshots) snapshotSignatures.set(key, snapshotSignature(snapshot));
}

function snapshotSignature(snapshot: BrowserRecordingSnapshot): string {
  const {
    persistence: _persistence,
    persistenceError: _persistenceError,
    retainedBytes: _retainedBytes,
    globalRetainedBytes: _globalRetainedBytes,
    globalSessionCount: _globalSessionCount,
    ...stableStatus
  } = snapshot.status;
  try { return JSON.stringify({ ...snapshot, status: stableStatus }); } catch { return `${Date.now()}:${Math.random()}`; }
}

function markPersistence(
  state: BrowserRecordingStatus['persistence'],
  error?: string,
): void {
  for (const snapshot of latestSnapshots.values()) {
    snapshot.status.persistence = state;
    snapshot.status.persistenceError = error;
  }
}

function persistedState(): StoredRecordingState {
  const sessions = Object.fromEntries([...latestSnapshots.entries()].map(([key, snapshot]) => [key, {
    snapshot: {
      ...snapshot,
      status: { ...snapshot.status, persistence: 'persisted' as const, persistenceError: undefined },
    },
    owner: ownedRecordings.get(key)?.owner || sessionOwners.get(key),
  }]));
  return { version: 4, sessions };
}

function schedulePersist(): void {
  if (!sessionStorage) {
    markPersistence('memory-only');
    return;
  }
  if (persistTimer || persistInFlight) return;
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = undefined;
    const snapshotRevision = mutationRevision;
    const state = persistedState();
    persistInFlight = true;
    void sessionStorage.set({ [RECORDING_SESSION_STORAGE_KEY]: state }).then(() => {
      sessionRestoreError = undefined;
      if (mutationRevision === snapshotRevision) markPersistence('persisted');
    }).catch((error) => {
      sessionRestoreError = persistenceError(error);
      markPersistence('degraded', sessionRestoreError);
    }).finally(() => {
      persistInFlight = false;
      if (mutationRevision > snapshotRevision) schedulePersist();
    });
  }, RECORDING_PERSIST_DELAY_MS);
}

function markSessionsMutated(): void {
  mutationRevision += 1;
  enforceGlobalRecordingBudget();
  markPersistence(
    !sessionStorage ? 'memory-only' : sessionRestoreError ? 'degraded' : 'pending',
    sessionRestoreError,
  );
  schedulePersist();
}

function ensureSessionsRestored(): Promise<void> {
  sessionRestorePromise ||= readStoredSessions().then((sessions) => {
    for (const [key, stored] of Object.entries(sessions)) {
      if (!stored?.snapshot?.status?.startedAt) continue;
      const snapshot = snapshotFromEvents(
        stored.snapshot.status.target,
        { ...stored.snapshot.status, persistence: sessionStorage ? 'persisted' : 'memory-only' },
        stored.snapshot.events,
        stored.snapshot.callables,
      );
      latestSnapshots.set(key, snapshot);
      snapshotSignatures.set(key, snapshotSignature(snapshot));
      if (stored.owner) sessionOwners.set(key, stored.owner);
      if (snapshot.status.active) {
        ownedRecordings.set(key, {
          target: snapshot.status.target,
          owner: stored.owner || { kind: 'local' },
        });
      }
    }
    enforceGlobalRecordingBudget();
    if (sessionRestoreError) markPersistence('degraded', sessionRestoreError);
  });
  return sessionRestorePromise;
}

async function readSession(target: BrowserTarget): Promise<StoredRecordingSession | undefined> {
  await ensureSessionsRestored();
  const key = targetKey(target);
  const memory = latestSnapshots.get(key);
  if (memory) return { snapshot: memory, owner: ownedRecordings.get(key)?.owner || sessionOwners.get(key) };
  return undefined;
}

async function writeSession(snapshot: BrowserRecordingSnapshot, owner?: OwnedRecording['owner']): Promise<void> {
  await ensureSessionsRestored();
  if (removedTabs.has(snapshot.status.target.tabId)) return;
  const key = targetKey(snapshot.status.target);
  const bounded = snapshotFromEvents(
    snapshot.status.target,
    snapshot.status,
    snapshot.events,
    snapshot.callables,
  );
  const signature = snapshotSignature(bounded);
  const unchanged = snapshotSignatures.get(key) === signature;
  const previous = latestSnapshots.get(key);
  if (unchanged && previous) {
    bounded.status.persistence = previous.status.persistence;
    bounded.status.persistenceError = previous.status.persistenceError;
  }
  latestSnapshots.set(key, bounded);
  snapshotSignatures.set(key, signature);
  const resolvedOwner = owner || ownedRecordings.get(key)?.owner || sessionOwners.get(key);
  if (resolvedOwner) sessionOwners.set(key, resolvedOwner);
  if (!unchanged) markSessionsMutated();
  Object.assign(snapshot, latestSnapshots.get(key) || bounded);
}

async function removeSession(target: BrowserTarget): Promise<void> {
  await ensureSessionsRestored();
  const key = targetKey(target);
  latestSnapshots.delete(key);
  snapshotSignatures.delete(key);
  sessionOwners.delete(key);
  ownedRecordings.delete(key);
  markSessionsMutated();
}

async function removeSessionsForTab(tabId: number): Promise<void> {
  await ensureSessionsRestored();
  for (const [key, recording] of ownedRecordings) {
    if (recording.target.tabId === tabId) ownedRecordings.delete(key);
  }
  for (const [key, snapshot] of latestSnapshots) {
    if (snapshot.status.target.tabId === tabId) {
      latestSnapshots.delete(key);
      snapshotSignatures.delete(key);
      sessionOwners.delete(key);
    }
  }
  markSessionsMutated();
}

async function ensureRecordingCapacity(target: BrowserTarget): Promise<void> {
  await ensureSessionsRestored();
  const key = targetKey(target);
  if (latestSnapshots.has(key)) return;
  while (latestSnapshots.size >= RECORDING_MAX_SESSIONS) {
    const oldest = oldestInactiveSessionKey();
    if (!oldest) {
      throw new ExtensionError(
        'recording_capacity_exceeded',
        `同时保留的录制会话已达到 ${RECORDING_MAX_SESSIONS} 个上限，请先停止或清理旧会话`,
      );
    }
    deleteSessionMemory(oldest);
  }
}

function enqueueLifecycle(target: BrowserTarget, task: () => Promise<void>): void {
  const key = targetKey(target);
  const previous = lifecycleQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task).finally(() => {
    if (lifecycleQueues.get(key) === next) lifecycleQueues.delete(key);
  });
  lifecycleQueues.set(key, next);
}

function notifyRecordingChanged(tabId: number, reason: 'navigation' | 'restored' | 'updated'): void {
  void browser.runtime.sendMessage({ action: 'recording.changed', payload: { tabId, reason } }).catch(() => undefined);
}

function pageRecorderCommand(
  registryKey: string,
  protocolVersion: number,
  command: RecorderCommand,
  input: Record<string, unknown>,
): unknown {
  const controller = (window as unknown as Record<string, unknown>)[registryKey] as {
    version?: unknown;
    command?: (name: RecorderCommand, params: Record<string, unknown>) => unknown;
  } | undefined;
  if (controller?.version !== protocolVersion || typeof controller.command !== 'function') {
    if (['start', 'status', 'get', 'stop', 'resume', 'clear', 'navigation.record'].includes(command)) {
      return { version: protocolVersion, active: false, count: 0, droppedCount: 0, events: [], callables: [] };
    }
    throw new Error('页面录制器未安装');
  }
  return controller.command(command, input);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function normalizeOptions(input?: Partial<BrowserRecordingOptions>): BrowserRecordingOptions {
  return {
    captureValues: input?.captureValues === true,
    maxEntries: Math.max(20, Math.min(Math.floor(input?.maxEntries || DEFAULT_OPTIONS.maxEntries), MAX_ENTRIES)),
    maxValueBytes: Math.max(256, Math.min(Math.floor(input?.maxValueBytes || DEFAULT_OPTIONS.maxValueBytes), 8_192)),
    expiresAt: typeof input?.expiresAt === 'number' && Number.isFinite(input.expiresAt) ? input.expiresAt : undefined,
  };
}

function normalizeEvidence(value: unknown, allowSensitive: boolean): BrowserRecordingValueEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.path !== 'string' || typeof input.fingerprint !== 'string'
    || !['text', 'bytes', 'hex', 'base64', 'json'].includes(String(input.encoding))) return undefined;
  return {
    path: input.path.slice(0, 512),
    fingerprint: input.fingerprint.slice(0, 160),
    encoding: input.encoding as BrowserRecordingValueEvidence['encoding'],
    byteLength: Math.max(0, Math.floor(finiteNumber(input.byteLength))),
    preview: allowSensitive ? optionalString(input.preview, 8_192) : undefined,
  };
}

function normalizeCallArgument(value: unknown): BrowserRecordingCallArgument | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const roles: BrowserRecordingCallArgument['role'][] = [
    'data', 'key', 'iv', 'algorithm', 'options', 'signature', 'salt', 'nonce', 'aad', 'unknown',
  ];
  if (!Number.isSafeInteger(input.index) || Number(input.index) < 0 || Number(input.index) > 63
    || !roles.includes(input.role as BrowserRecordingCallArgument['role']) || typeof input.dataType !== 'string') return undefined;
  return {
    index: Number(input.index),
    role: input.role as BrowserRecordingCallArgument['role'],
    dataType: input.dataType.slice(0, 120),
    byteLength: input.byteLength === undefined ? undefined : Math.max(0, Math.floor(finiteNumber(input.byteLength))),
    replaceable: input.replaceable === true,
    retained: input.retained === true,
    summary: optionalString(input.summary, 240),
  };
}

function normalizeNavigation(value: unknown): BrowserRecordingNavigation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const phases: BrowserRecordingNavigation['phase'][] = ['started', 'committed', 'completed', 'restored', 'same-document', 'failed'];
  const kinds: BrowserRecordingNavigation['kind'][] = ['document', 'history', 'fragment', 'reload', 'back-forward'];
  if (!phases.includes(input.phase as BrowserRecordingNavigation['phase'])
    || !kinds.includes(input.kind as BrowserRecordingNavigation['kind'])
    || typeof input.toUrl !== 'string') return undefined;
  return {
    phase: input.phase as BrowserRecordingNavigation['phase'],
    kind: input.kind as BrowserRecordingNavigation['kind'],
    fromUrl: optionalString(input.fromUrl, 8_192),
    toUrl: input.toUrl.slice(0, 8_192),
    sameDocument: input.sameDocument === true,
    transitionType: optionalString(input.transitionType, 120),
    transitionQualifiers: Array.isArray(input.transitionQualifiers)
      ? input.transitionQualifiers.filter((item): item is string => typeof item === 'string').slice(0, 16).map((item) => item.slice(0, 120))
      : undefined,
    previousDocumentId: optionalString(input.previousDocumentId, 160),
    documentId: optionalString(input.documentId, 160),
    error: optionalString(input.error, 512),
  };
}

function normalizeTransform(value: unknown): BrowserRecordingEvent['transform'] {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const categories: NonNullable<BrowserRecordingEvent['transform']>['category'][] = [
    'serializer', 'canonicalization', 'request-builder', 'encoding', 'compression',
  ];
  const providerKinds: NonNullable<BrowserRecordingEvent['transform']>['providerKind'][] = [
    'native', 'library', 'business', 'wasm', 'unknown',
  ];
  const phases: NonNullable<BrowserRecordingEvent['transform']>['phase'][] = ['input', 'output', 'boundary'];
  if (!categories.includes(input.category as NonNullable<BrowserRecordingEvent['transform']>['category'])
    || !providerKinds.includes(input.providerKind as NonNullable<BrowserRecordingEvent['transform']>['providerKind'])
    || typeof input.adapterId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(input.adapterId)) return undefined;
  return {
    adapterId: input.adapterId,
    providerKind: input.providerKind as NonNullable<BrowserRecordingEvent['transform']>['providerKind'],
    category: input.category as NonNullable<BrowserRecordingEvent['transform']>['category'],
    phase: phases.includes(input.phase as NonNullable<BrowserRecordingEvent['transform']>['phase'])
      ? input.phase as NonNullable<BrowserRecordingEvent['transform']>['phase'] : undefined,
  };
}

function normalizeEvent(value: unknown, allowSensitive: boolean): BrowserRecordingEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const kinds = ['interaction', 'fetch', 'xhr', 'form', 'beacon', 'worker', 'message', 'websocket', 'crypto', 'transform', 'navigation'] as const;
  if (typeof input.id !== 'string' || typeof input.recordingId !== 'string' || typeof input.traceId !== 'string'
    || !kinds.includes(input.kind as typeof kinds[number]) || typeof input.operation !== 'string') return undefined;
  const crypto = normalizeBrowserRecordingCrypto(input.crypto);
  if (input.kind === 'crypto' && !crypto) return undefined;
  const output: BrowserRecordingEvent = {
    id: input.id.slice(0, 160),
    sequence: Math.max(0, Math.floor(finiteNumber(input.sequence))),
    timestamp: finiteNumber(input.timestamp),
    durationMs: input.durationMs === undefined ? undefined : Math.max(0, finiteNumber(input.durationMs)),
    recordingId: input.recordingId.slice(0, 160),
    traceId: input.traceId.slice(0, 160),
    interactionId: optionalString(input.interactionId, 160),
    parentEventId: optionalString(input.parentEventId, 160),
    kind: input.kind as BrowserRecordingEvent['kind'],
    source: input.source === 'browser' ? 'browser' : 'page',
    documentId: optionalString(input.documentId, 160),
    operation: input.operation.slice(0, 160),
    inputs: Array.isArray(input.inputs)
      ? input.inputs.slice(0, 48).map((item) => normalizeEvidence(item, allowSensitive)).filter((item): item is BrowserRecordingValueEvidence => Boolean(item))
      : [],
    outputs: Array.isArray(input.outputs)
      ? input.outputs.slice(0, 48).map((item) => normalizeEvidence(item, allowSensitive)).filter((item): item is BrowserRecordingValueEvidence => Boolean(item))
      : [],
    arguments: Array.isArray(input.arguments)
      ? input.arguments.slice(0, 64).map(normalizeCallArgument).filter((item): item is BrowserRecordingCallArgument => Boolean(item))
      : undefined,
    sensitiveCaptured: allowSensitive && input.sensitiveCaptured === true,
    navigation: normalizeNavigation(input.navigation),
    crypto,
    transform: normalizeTransform(input.transform),
  };
  const stringLimits: Record<string, number> = {
    label: 240, url: 8_192, method: 32, socketId: 160, channelId: 160, dataType: 120,
    stack: 4_096, scriptUrl: 2_048, wrapperHandleId: 160, callHandleId: 160, error: 512,
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    const normalized = optionalString(input[key], limit);
    if (normalized !== undefined) (output as unknown as Record<string, unknown>)[key] = normalized;
  }
  if (input.direction === 'send' || input.direction === 'receive') output.direction = input.direction;
  if (typeof input.callableCapable === 'boolean') output.callableCapable = input.callableCapable;
  for (const key of ['byteLength', 'resultByteLength'] as const) {
    if (input[key] !== undefined) output[key] = Math.max(0, finiteNumber(input[key]));
  }
  if (input.statusCode !== undefined) {
    const statusCode = Math.floor(finiteNumber(input.statusCode, -1));
    if (statusCode >= 0 && statusCode <= 999) output.statusCode = statusCode;
  }
  if (allowSensitive) {
    output.inputPreview = optionalString(input.inputPreview, 8_192);
    output.outputPreview = optionalString(input.outputPreview, 8_192);
  }
  return output;
}

function normalizeRawSnapshot(value: unknown, allowSensitive: boolean): RawRecorderSnapshot {
  if (!value || typeof value !== 'object') throw new ExtensionError('recorder_unavailable', '页面录制器返回了无效状态');
  const input = value as Record<string, unknown>;
  if (input.version !== PAGE_RECORDER_PROTOCOL_VERSION || typeof input.active !== 'boolean' || !Array.isArray(input.events) || !Array.isArray(input.callables)) {
    throw new ExtensionError('recorder_unavailable', '页面录制器协议不兼容');
  }
  return {
    version: PAGE_RECORDER_PROTOCOL_VERSION,
    active: input.active,
    recordingId: optionalString(input.recordingId, 160),
    startedAt: input.startedAt === undefined ? undefined : finiteNumber(input.startedAt),
    count: Math.max(0, Math.floor(finiteNumber(input.count))),
    droppedCount: Math.max(0, Math.floor(finiteNumber(input.droppedCount))),
    retainedCallCount: Math.max(0, Math.floor(finiteNumber(input.retainedCallCount))),
    retainedCallBytes: Math.max(0, Math.floor(finiteNumber(input.retainedCallBytes))),
    retainedCallDroppedCount: Math.max(0, Math.floor(finiteNumber(input.retainedCallDroppedCount))),
    options: input.options && typeof input.options === 'object' ? normalizeOptions(input.options as Partial<BrowserRecordingOptions>) : undefined,
    events: input.events.slice(-MAX_ENTRIES).map((item) => normalizeEvent(item, allowSensitive)).filter((item): item is BrowserRecordingEvent => Boolean(item)),
    callables: input.callables.slice(0, 128),
  };
}

async function executeCommand(target: BrowserTarget, command: RecorderCommand, input: Record<string, unknown> = {}): Promise<unknown> {
  if (import.meta.env.FIREFOX) {
    if (command === 'deep.arm' || command === 'deep.disarm') {
      throw new ExtensionError('channel_unavailable', 'Firefox 不提供 Chromium debugger 深度捕获');
    }
    return executeFirefoxPageRecorderCommand(target, command as PageRecorderBridgeCommand, input);
  }
  let results: Browser.scripting.InjectionResult[];
  try {
    results = await browser.scripting.executeScript({
      target: scriptingTarget(target),
      world: 'MAIN',
      func: pageRecorderCommand,
      args: [PAGE_RECORDER_REGISTRY_KEY, PAGE_RECORDER_PROTOCOL_VERSION, command, input],
    });
  } catch (error) {
    throw new ExtensionError('recorder_unavailable', error instanceof Error ? error.message : String(error));
  }
  if (results.length !== 1) throw new ExtensionError('recorder_unavailable', '页面录制器无法唯一定位目标文档');
  return results[0].result;
}

async function install(target: BrowserTarget): Promise<void> {
  if (import.meta.env.FIREFOX) return;
  try {
    await browser.scripting.executeScript({ target: scriptingTarget(target), world: 'MAIN', files: [RECORDER_SCRIPT] });
  } catch (error) {
    throw new ExtensionError('recorder_unavailable', error instanceof Error ? error.message : String(error));
  }
}

function statusFrom(target: BrowserTarget, raw: RawRecorderSnapshot): BrowserRecordingStatus {
  const expired = Boolean(raw.options?.expiresAt && raw.options.expiresAt <= Date.now());
  return {
    active: raw.active, target, documentAvailable: true, recordingId: raw.recordingId, startedAt: raw.startedAt,
    count: raw.count, droppedCount: raw.droppedCount, options: raw.options,
    retainedCallCount: raw.retainedCallCount,
    retainedCallBytes: raw.retainedCallBytes,
    retainedCallDroppedCount: raw.retainedCallDroppedCount,
    endedReason: raw.startedAt && !raw.active ? (expired ? 'expired' : 'user') : undefined,
  };
}

function composeSnapshot(
  target: BrowserTarget,
  status: BrowserRecordingStatus,
  events: BrowserRecordingEvent[],
  callables: BrowserPageCallable[],
): BrowserRecordingSnapshot {
  const links = buildRecordingLinks(events);
  return {
    status: { ...status, target, count: events.length },
    events,
    links,
    traces: buildRecordingTraces(events, links),
    callables,
    profileCandidates: inferBrowserTransformProfiles({ target, events, links }),
  };
}

function snapshotFromEvents(
  target: BrowserTarget,
  status: BrowserRecordingStatus,
  events: BrowserRecordingEvent[],
  callables: BrowserPageCallable[],
): BrowserRecordingSnapshot {
  const previewBudget = boundRecordingPreviews(events);
  const boundedEvents = [...previewBudget.events];
  const boundedCallables = [...callables];
  let budgetDroppedCount = status.budgetDroppedCount || 0;
  let retentionFloorSequence = status.retentionFloorSequence;
  let payloadBytes = boundedEvents.reduce(
    (total, event) => total + recordingSerializedBytes(event),
    0,
  ) + boundedCallables.reduce(
    (total, callable) => total + recordingSerializedBytes(callable),
    0,
  );
  let payloadDropCount = 0;
  while (payloadBytes > RECORDING_SNAPSHOT_PAYLOAD_TARGET_BYTES && payloadDropCount < boundedEvents.length) {
    payloadBytes -= recordingSerializedBytes(boundedEvents[payloadDropCount]);
    payloadDropCount += 1;
  }
  if (payloadDropCount) {
    const removed = boundedEvents.splice(0, payloadDropCount);
    budgetDroppedCount += removed.length;
    retentionFloorSequence = Math.max(
      retentionFloorSequence || 0,
      (removed.at(-1)?.sequence || 0) + 1,
    );
  }
  let snapshot = composeSnapshot(target, status, boundedEvents, boundedCallables);
  if (recordingSerializedBytes(snapshot) > RECORDING_SNAPSHOT_MAX_BYTES && boundedEvents.length) {
    let low = 1;
    let high = boundedEvents.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = composeSnapshot(target, status, boundedEvents.slice(middle), boundedCallables);
      if (recordingSerializedBytes(candidate) <= RECORDING_SNAPSHOT_MAX_BYTES) high = middle;
      else low = middle + 1;
    }
    const removed = boundedEvents.splice(0, low);
    budgetDroppedCount += removed.length;
    retentionFloorSequence = Math.max(
      retentionFloorSequence || 0,
      (removed.at(-1)?.sequence || 0) + 1,
    );
    snapshot = composeSnapshot(target, status, boundedEvents, boundedCallables);
  }
  if (recordingSerializedBytes(snapshot) > RECORDING_SNAPSHOT_MAX_BYTES && boundedCallables.length) {
    let low = 1;
    let high = boundedCallables.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = composeSnapshot(target, status, boundedEvents, boundedCallables.slice(middle));
      if (recordingSerializedBytes(candidate) <= RECORDING_SNAPSHOT_MAX_BYTES) high = middle;
      else low = middle + 1;
    }
    boundedCallables.splice(0, low);
    snapshot = composeSnapshot(target, status, boundedEvents, boundedCallables);
  }
  const retainedPreviewBytes = boundedEvents.reduce(
    (total, event) => total + recordingEventPreviewBytes(event),
    0,
  );
  snapshot.status = {
    ...snapshot.status,
    count: boundedEvents.length,
    budgetDroppedCount,
    previewDroppedCount: Math.max(status.previewDroppedCount || 0, previewBudget.droppedCount),
    retentionFloorSequence,
    retainedPreviewBytes,
  };
  snapshot.status.retainedBytes = recordingSerializedBytes(snapshot);
  snapshot.status.retainedBytes = recordingSerializedBytes(snapshot);
  return snapshot;
}

function snapshotFrom(target: BrowserTarget, raw: RawRecorderSnapshot): BrowserRecordingSnapshot {
  const events = raw.events.map((event) => event.documentId || !target.documentId
    ? event
    : { ...event, documentId: target.documentId });
  const callables = raw.callables
    .map((item) => normalizeCallable(item, target))
    .filter((item): item is BrowserPageCallable => Boolean(item));
  return snapshotFromEvents(target, statusFrom(target, raw), events, callables);
}

function mergeSessionSnapshot(
  target: BrowserTarget,
  raw: RawRecorderSnapshot,
  previous?: BrowserRecordingSnapshot,
  status?: Partial<BrowserRecordingStatus>,
): BrowserRecordingSnapshot {
  const current = snapshotFrom(target, raw);
  const sameSession = Boolean(previous?.status.recordingId && previous.status.recordingId === raw.recordingId);
  let events = sameSession
    ? mergeRecordingEvents([current.events, previous?.events || []])
    : current.events;
  if (sameSession && previous?.status.retentionFloorSequence) {
    events = events.filter((event) => event.sequence >= previous.status.retentionFloorSequence!);
  }
  return snapshotFromEvents(target, {
    ...current.status,
    ...(sameSession ? {
      startedAt: previous?.status.startedAt || current.status.startedAt,
      droppedCount: Math.max(previous?.status.droppedCount || 0, current.status.droppedCount),
      options: current.status.options || previous?.status.options,
      pageUrl: previous?.status.pageUrl,
      navigation: previous?.status.navigation,
      isolationContextId: previous?.status.isolationContextId,
      cookieStoreId: previous?.status.cookieStoreId,
      budgetDroppedCount: previous?.status.budgetDroppedCount,
      previewDroppedCount: previous?.status.previewDroppedCount,
      retentionFloorSequence: previous?.status.retentionFloorSequence,
      retainedBytes: previous?.status.retainedBytes,
      retainedPreviewBytes: previous?.status.retainedPreviewBytes,
      retainedCallCount: current.status.retainedCallCount || previous?.status.retainedCallCount,
      retainedCallBytes: current.status.retainedCallBytes || previous?.status.retainedCallBytes,
      retainedCallDroppedCount: Math.max(
        current.status.retainedCallDroppedCount || 0,
        previous?.status.retainedCallDroppedCount || 0,
      ),
      globalRetainedBytes: previous?.status.globalRetainedBytes,
      globalSessionCount: previous?.status.globalSessionCount,
      persistence: previous?.status.persistence,
      persistenceError: previous?.status.persistenceError,
    } : {}),
    ...status,
  }, events, current.callables);
}

interface NavigationDetails {
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
  timeStamp: number;
  transitionType?: string;
  transitionQualifiers?: string[];
  error?: string;
}

function uniqueToken(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

async function currentPageUrl(target: BrowserTarget): Promise<string | undefined> {
  try {
    const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
    if (frame?.url) return frame.url.slice(0, 8_192);
  } catch { /* The frame can disappear while a navigation is committing. */ }
  if (target.frameId !== 0) return undefined;
  try { return (await browser.tabs.get(target.tabId)).url?.slice(0, 8_192); } catch { return undefined; }
}

function navigationLabel(navigation: BrowserRecordingNavigation): string {
  if (navigation.kind === 'back-forward') return '浏览器前进或后退';
  if (navigation.kind === 'reload') return '重新加载页面';
  if (navigation.kind === 'history') return '页面路由变化';
  if (navigation.kind === 'fragment') return '页面锚点变化';
  return '页面跳转';
}

function navigationOperation(navigation: BrowserRecordingNavigation): string {
  if (navigation.kind === 'back-forward') return 'history.traverse';
  if (navigation.kind === 'reload') return 'navigation.reload';
  if (navigation.kind === 'history') return 'history.state';
  if (navigation.kind === 'fragment') return 'location.fragment';
  return 'navigation.document';
}

function navigationKind(details: Pick<NavigationDetails, 'transitionType' | 'transitionQualifiers'>): BrowserRecordingNavigation['kind'] {
  if (details.transitionQualifiers?.includes('forward_back')) return 'back-forward';
  if (details.transitionType === 'reload') return 'reload';
  return 'document';
}

function applyNavigation(
  snapshot: BrowserRecordingSnapshot,
  target: BrowserTarget,
  navigation: BrowserRecordingNavigation,
  timestamp: number,
  input?: { eventId?: string; documentAvailable?: boolean; callables?: BrowserPageCallable[]; active?: boolean },
): BrowserRecordingSnapshot {
  const hasExplicitEvent = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'eventId'));
  const existingId = hasExplicitEvent ? input?.eventId : snapshot.status.navigation?.eventId;
  const existing = existingId
    ? snapshot.events.find((event) => event.id === existingId)
    : snapshot.events.findLast((event) => event.kind === 'navigation' && event.navigation?.toUrl === navigation.toUrl);
  const eventId = existing?.id || uniqueToken('event-navigation');
  const standalone = navigation.kind === 'back-forward';
  const traceId = standalone
    ? `trace-${eventId}`
    : existing?.traceId || latestRecordingTraceId(snapshot.events) || uniqueToken('trace-navigation');
  const startedAt = existing?.timestamp || timestamp;
  const event: BrowserRecordingEvent = {
    id: eventId,
    sequence: existing?.sequence || nextRecordingSequence(snapshot.events),
    timestamp: startedAt,
    durationMs: navigation.phase === 'started' || navigation.phase === 'same-document'
      ? existing?.durationMs
      : Math.max(0, timestamp - startedAt),
    recordingId: snapshot.status.recordingId || existing?.recordingId || uniqueToken('recording'),
    traceId,
    interactionId: standalone ? undefined : existing?.interactionId,
    parentEventId: existing?.parentEventId,
    kind: 'navigation',
    source: 'browser',
    documentId: navigation.previousDocumentId || existing?.documentId,
    operation: navigationOperation(navigation),
    label: navigationLabel(navigation),
    url: navigation.toUrl,
    inputs: [],
    outputs: [],
    sensitiveCaptured: false,
    error: navigation.error,
    navigation,
  };
  const events = mergeRecordingEvents([
    snapshot.events.filter((item) => item.id !== eventId),
    [event],
  ]);
  return snapshotFromEvents(target, {
    ...snapshot.status,
    target,
    active: input?.active ?? snapshot.status.active,
    documentAvailable: input?.documentAvailable ?? snapshot.status.documentAvailable,
    pageUrl: navigation.phase === 'failed' ? navigation.fromUrl : navigation.toUrl,
    endedReason: undefined,
    navigation: { ...navigation, eventId, timestamp: startedAt },
  }, events, input?.callables ?? snapshot.callables);
}

export async function startBrowserRecording(
  target: BrowserTarget,
  input?: Partial<BrowserRecordingOptions>,
  owner: OwnedRecording['owner'] = { kind: 'local' },
): Promise<BrowserRecordingSnapshot> {
  if (expiredGrantOwner(owner)) throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期');
  const options = normalizeOptions(input);
  const tab = await getTab(target.tabId);
  if (!tab.isolationContextId) {
    throw new ExtensionError('isolation_unavailable', '无法确认录制页面所属的身份隔离上下文');
  }
  await removeSession(target);
  await ensureRecordingCapacity(target);
  await install(target);
  const raw = normalizeRawSnapshot(await executeCommand(target, 'start', { ...options }), options.captureValues);
  if (!raw.startedAt) throw new ExtensionError('recorder_unavailable', '页面录制器尚未在目标文档就绪');
  ownedRecordings.set(targetKey(target), { target, owner });
  const snapshot = snapshotFrom(target, raw);
  snapshot.status.isolationContextId = tab.isolationContextId;
  snapshot.status.cookieStoreId = tab.cookieStoreId;
  snapshot.status.pageUrl = await currentPageUrl(target);
  await writeSession(snapshot, owner);
  return snapshot;
}

export async function browserRecordingStatus(target: BrowserTarget): Promise<BrowserRecordingStatus> {
  const session = await readSession(target);
  let raw = normalizeRawSnapshot(await executeCommand(target, 'status'), false);
  if (session?.snapshot.status.active && raw.startedAt && !raw.active
    && raw.recordingId === session.snapshot.status.recordingId
    && (!raw.options?.expiresAt || raw.options.expiresAt > Date.now())) {
    raw = normalizeRawSnapshot(await executeCommand(target, 'resume', {
      sequenceStart: nextRecordingSequence(session.snapshot.events) - 1,
    }), false);
  }
  if (raw.startedAt) {
    const expired = Boolean(raw.options?.expiresAt && raw.options.expiresAt <= Date.now());
    const merged = mergeSessionSnapshot(target, raw, session?.snapshot, expired
      ? { active: false, documentAvailable: true, endedReason: 'expired' }
      : session?.snapshot.status.active
        ? { active: true, documentAvailable: true, endedReason: undefined }
        : undefined);
    if (expired) {
      ownedRecordings.delete(targetKey(target));
    }
    await writeSession(merged, session?.owner);
    if (merged.status.active && !ownedRecordings.has(targetKey(target))) {
      ownedRecordings.set(targetKey(target), { target, owner: session?.owner || { kind: 'local' } });
    }
    return merged.status;
  }
  return session?.snapshot.status || statusFrom(target, raw);
}

export async function getBrowserRecording(target: BrowserTarget, limit = MAX_ENTRIES, allowSensitive = false): Promise<BrowserRecordingSnapshot> {
  const session = await readSession(target);
  let raw = normalizeRawSnapshot(await executeCommand(target, 'get', { limit: Math.max(1, Math.min(Math.floor(limit), MAX_ENTRIES)) }), allowSensitive);
  if (session?.snapshot.status.active && raw.startedAt && !raw.active
    && raw.recordingId === session.snapshot.status.recordingId
    && (!raw.options?.expiresAt || raw.options.expiresAt > Date.now())) {
    raw = normalizeRawSnapshot(await executeCommand(target, 'resume', {
      sequenceStart: nextRecordingSequence(session.snapshot.events) - 1,
    }), allowSensitive);
  }
  if (!raw.startedAt) {
    if (session) return recordingSnapshotForScope(session.snapshot, allowSensitive);
  }
  const expired = Boolean(raw.options?.expiresAt && raw.options.expiresAt <= Date.now());
  const snapshot = mergeSessionSnapshot(target, raw, session?.snapshot, expired
    ? { active: false, documentAvailable: true, endedReason: 'expired' }
    : session?.snapshot.status.active
      ? { active: true, documentAvailable: true, endedReason: undefined }
      : undefined);
  if (expired) {
    ownedRecordings.delete(targetKey(target));
  }
  await writeSession(snapshot, session?.owner);
  return recordingSnapshotForScope(snapshot, allowSensitive);
}

export async function clearBrowserRecording(target: BrowserTarget, allowSensitive = false): Promise<BrowserRecordingSnapshot> {
  const raw = normalizeRawSnapshot(await executeCommand(target, 'clear').catch(() => ({
    version: PAGE_RECORDER_PROTOCOL_VERSION, active: false, count: 0, droppedCount: 0, events: [], callables: [],
  })), allowSensitive);
  ownedRecordings.delete(targetKey(target));
  await removeSession(target);
  return snapshotFrom(target, raw);
}

export async function stopBrowserRecording(target: BrowserTarget, allowSensitive = false): Promise<BrowserRecordingSnapshot> {
  const session = await readSession(target);
  const raw = normalizeRawSnapshot(await executeCommand(target, 'stop').catch(() => ({
    version: PAGE_RECORDER_PROTOCOL_VERSION, active: false, count: 0, droppedCount: 0, events: [], callables: [],
  })), allowSensitive);
  ownedRecordings.delete(targetKey(target));
  const snapshot = raw.startedAt
    ? mergeSessionSnapshot(target, raw, session?.snapshot, { active: false, documentAvailable: true, endedReason: 'user' })
    : session
      ? snapshotFromEvents(session.snapshot.status.target, {
        ...session.snapshot.status,
        active: false,
        endedReason: 'user',
      }, session.snapshot.events, [])
      : snapshotFrom(target, raw);
  await writeSession(snapshot, session?.owner);
  return recordingSnapshotForScope(snapshot, allowSensitive);
}

export async function createRecordedPageCallable(
  target: BrowserTarget,
  input: { callHandleId: string; name: string },
): Promise<BrowserPageCallable> {
  const raw = await executeCommand(target, 'callable.create', input);
  const callable = normalizeCallable(raw, target);
  if (!callable) throw new ExtensionError('callable_invalid', '页面返回了无效函数');
  return callable;
}

export async function armBrowserRecordingDeepBreak(
  target: BrowserTarget,
  matcher: Extract<BrowserDeepCaptureMatcher, { kind: 'crypto' | 'boundary' }>,
): Promise<void> {
  await executeCommand(target, 'deep.arm', matcher);
}

export async function disarmBrowserRecordingDeepBreak(target: BrowserTarget): Promise<void> {
  await executeCommand(target, 'deep.disarm').catch(() => undefined);
}

export async function stopBrowserRecordingsForGrant(grantId: string): Promise<void> {
  await ensureSessionsRestored();
  const targets = new Map<string, BrowserTarget>();
  for (const [key, item] of ownedRecordings) {
    if (item.owner.kind === 'grant' && item.owner.grantId === grantId) targets.set(key, item.target);
  }
  for (const [key, owner] of sessionOwners) {
    if (owner.kind !== 'grant' || owner.grantId !== grantId) continue;
    const target = latestSnapshots.get(key)?.status.target;
    if (target) targets.set(key, target);
  }
  await Promise.allSettled([...targets.values()].map((target) => clearBrowserRecording(target)));
}

export function initializeBrowserRecordingService(): void {
  if (serviceInitialized) return;
  serviceInitialized = true;
  void ensureSessionsRestored().then(async () => {
    const targets = [...ownedRecordings.values()]
      .filter((item) => expiredGrantOwner(item.owner))
      .map((item) => item.target);
    await Promise.allSettled(targets.map((target) => clearBrowserRecording(target)));
  }).catch((error) => {
    console.error('Browser recording lifecycle restoration failed', error);
  });
}

export async function recordingAnalysisWindow(target: BrowserTarget, centerTimestamp: number): Promise<Array<Pick<
  BrowserRecordingEvent,
  'kind' | 'operation' | 'crypto' | 'direction' | 'scriptUrl' | 'byteLength' | 'resultByteLength' | 'timestamp'
>>> {
  const snapshot = await getBrowserRecording(target, MAX_ENTRIES, false).catch(() => undefined);
  return (snapshot?.events || []).filter((item) => Math.abs(item.timestamp - centerTimestamp) <= 60_000).map((item) => ({
    kind: item.kind,
    operation: item.operation,
    crypto: item.crypto,
    direction: item.direction,
    scriptUrl: item.scriptUrl,
    byteLength: item.byteLength,
    resultByteLength: item.resultByteLength,
    timestamp: item.timestamp,
  }));
}

async function archiveBeforeNavigation(details: NavigationDetails): Promise<void> {
  const keyTarget: BrowserTarget = { tabId: details.tabId, frameId: details.frameId };
  const key = targetKey(keyTarget);
  const stored = await readSession(keyTarget);
  const known = ownedRecordings.get(key);
  const pageTarget = known?.target || stored?.snapshot.status.target || keyTarget;
  let snapshot = stored?.snapshot;
  let raw: RawRecorderSnapshot | undefined;

  try {
    raw = normalizeRawSnapshot(await executeCommand(pageTarget, 'get', { limit: MAX_ENTRIES }), true);
    if (raw.startedAt) snapshot = mergeSessionSnapshot(pageTarget, raw, snapshot);
  } catch {
    // The renderer may commit before the final snapshot reaches the service
    // worker. The latest bounded session still preserves prior evidence.
  }

  if (!snapshot?.status.startedAt || (!snapshot.status.active && !raw?.active)) return;
  const owner = known?.owner || stored?.owner || { kind: 'local' as const };
  ownedRecordings.set(key, { target: pageTarget, owner });
  const fromUrl = snapshot.status.pageUrl || await currentPageUrl(pageTarget);
  const navigation: BrowserRecordingNavigation = {
    phase: 'started',
    kind: 'document',
    fromUrl,
    toUrl: details.url.slice(0, 8_192),
    sameDocument: false,
    previousDocumentId: pageTarget.documentId,
  };

  try {
    const recorded = normalizeRawSnapshot(await executeCommand(pageTarget, 'navigation.record', {
      navigation,
      documentId: pageTarget.documentId,
      operation: navigationOperation(navigation),
      label: navigationLabel(navigation),
    }), true);
    if (recorded.startedAt) {
      snapshot = mergeSessionSnapshot(pageTarget, recorded, snapshot, {
        active: true,
        documentAvailable: true,
        endedReason: undefined,
      });
    }
  } catch {
    // A synthetic browser event below records the boundary when the page wins
    // the navigation race before MAIN-world execution completes.
  }

  await executeCommand(pageTarget, 'stop').catch(() => undefined);
  const pageNavigation = [...snapshot.events].reverse().find((event) => (
    event.kind === 'navigation' && event.navigation?.phase === 'started' && event.navigation.toUrl === navigation.toUrl
  ));
  const continuesAcrossDocuments = owner.kind === 'local';
  const archived = applyNavigation(snapshot, pageTarget, navigation, details.timeStamp || Date.now(), {
    eventId: pageNavigation?.id,
    active: continuesAcrossDocuments,
    documentAvailable: false,
    callables: [],
  });
  if (!continuesAcrossDocuments) {
    archived.status.endedReason = 'authorization';
    ownedRecordings.delete(key);
  }
  await writeSession(archived, owner);
  notifyRecordingChanged(details.tabId, 'navigation');
}

async function continueRecordingOnDocument(
  details: NavigationDetails,
  phase: 'committed' | 'completed',
): Promise<void> {
  const target: BrowserTarget = {
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
  };
  const key = targetKey(target);
  const stored = await readSession(target);
  if (!stored?.snapshot.status.active || !stored.snapshot.status.recordingId) return;
  const previous = stored.snapshot;
  const previousNavigation = previous.status.navigation;
  const hasTransitionEvidence = Boolean(details.transitionType || details.transitionQualifiers?.length);
  const kind = hasTransitionEvidence
    ? navigationKind(details)
    : previousNavigation?.kind || 'document';
  const navigation: BrowserRecordingNavigation = {
    phase,
    kind,
    fromUrl: previousNavigation?.fromUrl || previous.status.pageUrl,
    toUrl: details.url.slice(0, 8_192),
    sameDocument: false,
    transitionType: details.transitionType || previousNavigation?.transitionType,
    transitionQualifiers: details.transitionQualifiers?.length
      ? details.transitionQualifiers
      : previousNavigation?.transitionQualifiers,
    previousDocumentId: previousNavigation?.previousDocumentId || previous.status.target.documentId,
    documentId: details.documentId,
  };
  let staged = applyNavigation(previous, target, navigation, details.timeStamp || Date.now(), {
    eventId: previousNavigation?.eventId,
    active: true,
    documentAvailable: false,
    callables: [],
  });
  const options = staged.status.options || DEFAULT_OPTIONS;
  if (options.expiresAt && options.expiresAt <= Date.now()) {
    staged = snapshotFromEvents(target, {
      ...staged.status,
      active: false,
      documentAvailable: false,
      endedReason: 'expired',
    }, staged.events, []);
    ownedRecordings.delete(key);
    await writeSession(staged, stored.owner);
    notifyRecordingChanged(details.tabId, 'updated');
    return;
  }

  try {
    await install(target);
    let raw = normalizeRawSnapshot(await executeCommand(target, 'get', { limit: MAX_ENTRIES }), true);
    const wasRestored = phase === 'committed'
      && kind === 'back-forward'
      && !previous.status.documentAvailable
      && raw.startedAt
      && raw.recordingId === staged.status.recordingId;
    const sequenceStart = nextRecordingSequence(staged.events) - 1;
    if (raw.startedAt && raw.recordingId === staged.status.recordingId) {
      raw = normalizeRawSnapshot(await executeCommand(target, 'resume', { sequenceStart }), true);
    } else {
      raw = normalizeRawSnapshot(await executeCommand(target, 'start', {
        ...options,
        recordingId: staged.status.recordingId,
        startedAt: staged.status.startedAt,
        sequenceStart,
      }), true);
    }
    if (!raw.startedAt) throw new ExtensionError('recorder_unavailable', '新页面录制器尚未就绪');
    const liveNavigation: BrowserRecordingNavigation = {
      ...navigation,
      phase: wasRestored || previousNavigation?.phase === 'restored' ? 'restored' : phase,
    };
    staged = applyNavigation(staged, target, liveNavigation, details.timeStamp || Date.now(), {
      eventId: staged.status.navigation?.eventId,
      active: true,
      documentAvailable: true,
      callables: [],
    });
    const live = mergeSessionSnapshot(target, raw, staged, {
      active: true,
      documentAvailable: true,
      pageUrl: details.url.slice(0, 8_192),
      endedReason: undefined,
      navigation: staged.status.navigation,
    });
    const owner = ownedRecordings.get(key)?.owner || stored.owner || { kind: 'local' as const };
    ownedRecordings.set(key, { target, owner });
    await writeSession(live, owner);
    notifyRecordingChanged(details.tabId, wasRestored ? 'restored' : 'updated');
  } catch {
    await writeSession(staged, stored.owner);
    notifyRecordingChanged(details.tabId, 'updated');
  }
}

async function recordSameDocumentNavigation(
  details: NavigationDetails,
  kind: 'history' | 'fragment',
): Promise<void> {
  const target: BrowserTarget = { tabId: details.tabId, frameId: details.frameId, documentId: details.documentId };
  const stored = await readSession(target);
  if (!stored?.snapshot.status.active || !stored.snapshot.status.recordingId) return;
  const navigation: BrowserRecordingNavigation = {
    phase: 'same-document',
    kind,
    fromUrl: stored.snapshot.status.pageUrl,
    toUrl: details.url.slice(0, 8_192),
    sameDocument: true,
    transitionType: details.transitionType,
    transitionQualifiers: details.transitionQualifiers,
    previousDocumentId: stored.snapshot.status.target.documentId,
    documentId: details.documentId || stored.snapshot.status.target.documentId,
  };
  let snapshot = stored.snapshot;
  try {
    const raw = normalizeRawSnapshot(await executeCommand(target, 'navigation.record', {
      navigation,
      documentId: navigation.documentId,
      operation: navigationOperation(navigation),
      label: navigationLabel(navigation),
    }), true);
    if (raw.startedAt) {
      snapshot = mergeSessionSnapshot(target, raw, snapshot, {
        active: true,
        documentAvailable: true,
        pageUrl: navigation.toUrl,
        endedReason: undefined,
      });
    }
  } catch {
    // Restricted documents still receive a synthetic browser-level boundary.
  }
  const pageNavigation = [...snapshot.events].reverse().find((event) => (
    event.kind === 'navigation' && event.navigation?.toUrl === navigation.toUrl
  ));
  snapshot = applyNavigation(snapshot, target, navigation, details.timeStamp || Date.now(), {
    eventId: pageNavigation?.id,
    active: true,
    documentAvailable: true,
  });
  await writeSession(snapshot, stored.owner);
  notifyRecordingChanged(details.tabId, 'updated');
}

async function failNavigation(details: NavigationDetails): Promise<void> {
  const keyTarget: BrowserTarget = { tabId: details.tabId, frameId: details.frameId };
  const stored = await readSession(keyTarget);
  if (!stored?.snapshot.status.active || !stored.snapshot.status.navigation) return;
  const target = stored.snapshot.status.target;
  const navigation: BrowserRecordingNavigation = {
    ...stored.snapshot.status.navigation,
    phase: 'failed',
    error: details.error?.slice(0, 512) || '页面跳转失败',
  };
  let snapshot = applyNavigation(stored.snapshot, target, navigation, details.timeStamp || Date.now(), {
    eventId: stored.snapshot.status.navigation.eventId,
    active: true,
    documentAvailable: false,
    callables: [],
  });
  try {
    const raw = normalizeRawSnapshot(await executeCommand(target, 'resume', {
      sequenceStart: nextRecordingSequence(snapshot.events) - 1,
    }), true);
    if (raw.startedAt) {
      snapshot = mergeSessionSnapshot(target, raw, snapshot, {
        active: true,
        documentAvailable: true,
        pageUrl: navigation.fromUrl,
        navigation: snapshot.status.navigation,
      });
    }
  } catch { /* The failure boundary remains visible even if the old renderer vanished. */ }
  await writeSession(snapshot, stored.owner);
  notifyRecordingChanged(details.tabId, 'updated');
}

browser.webNavigation.onBeforeNavigate.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => archiveBeforeNavigation({ ...details, transitionQualifiers: undefined }));
});

browser.webNavigation.onCommitted.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => continueRecordingOnDocument({
    ...details,
    transitionQualifiers: details.transitionQualifiers ? [...details.transitionQualifiers] : undefined,
  }, 'committed'));
});

browser.webNavigation.onDOMContentLoaded.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => continueRecordingOnDocument(details, 'committed'));
});

browser.webNavigation.onCompleted.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => continueRecordingOnDocument(details, 'completed'));
});

browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => recordSameDocumentNavigation(details, 'history'));
});

browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => recordSameDocumentNavigation(details, 'fragment'));
});

browser.webNavigation.onErrorOccurred.addListener((details) => {
  const target = { tabId: details.tabId, frameId: details.frameId };
  enqueueLifecycle(target, () => failNavigation(details));
});

browser.tabs.onRemoved.addListener((tabId) => {
  removedTabs.add(tabId);
  for (const key of lifecycleQueues.keys()) {
    if (key.startsWith(`${tabId}:`)) lifecycleQueues.delete(key);
  }
  void removeSessionsForTab(tabId);
});

browser.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) removedTabs.delete(tab.id);
});
