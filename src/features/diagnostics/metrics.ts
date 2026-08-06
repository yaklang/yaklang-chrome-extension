import { browser } from 'wxt/browser';
import { RUNTIME_METRICS_STORAGE_KEY } from '@/protocol/storage';
import type { RuntimeMetricAggregate, RuntimeMetrics, RuntimeQueueMetric } from '@/types/models';
import { auditQueueDiagnostics } from './audit';
import { agentRuntimeQueueDiagnostics } from '@/features/agent-runtime/service';

type RuntimeMetricsCore = Omit<RuntimeMetrics, 'queues'>;

interface MetricsDelta {
  serviceWorkerStarts: number;
  bridgeConnectAttempts: number;
  bridgeConnections: number;
  bridgeDisconnects: number;
  bridgeErrors: number;
  heartbeatSamples: number;
  heartbeatLatencyTotalMs: number;
  heartbeatLatencyMaxMs: number;
  capabilities: Record<string, RuntimeMetricAggregate>;
}

const FLUSH_DELAY_MS = 500;
const FLUSH_THRESHOLD = 64;
const MAX_PENDING_MUTATIONS = 10_000;
const MAX_CAPABILITY_METHODS = 256;
const OTHER_CAPABILITY = '__other__';

let current: RuntimeMetricsCore | undefined;
let restorePromise: Promise<void> | undefined;
let delta = emptyDelta();
let pendingMutations = 0;
let droppedCount = 0;
let persistenceErrors = 0;
let persistenceError: string | undefined;
let flushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let flushQueue: Promise<void> = Promise.resolve();

function defaultsCore(): RuntimeMetricsCore {
  const now = Date.now();
  return {
    version: 1, firstSeenAt: now, updatedAt: now, serviceWorkerStarts: 0,
    bridgeConnectAttempts: 0, bridgeConnections: 0, bridgeDisconnects: 0, bridgeErrors: 0,
    heartbeatSamples: 0, heartbeatLatencyTotalMs: 0, heartbeatLatencyMaxMs: 0, capabilities: {},
  };
}

function emptyDelta(): MetricsDelta {
  return {
    serviceWorkerStarts: 0,
    bridgeConnectAttempts: 0,
    bridgeConnections: 0,
    bridgeDisconnects: 0,
    bridgeErrors: 0,
    heartbeatSamples: 0,
    heartbeatLatencyTotalMs: 0,
    heartbeatLatencyMaxMs: 0,
    capabilities: {},
  };
}

function normalizeCore(input: unknown): RuntimeMetricsCore {
  if (!input || typeof input !== 'object') return defaultsCore();
  const value = input as Partial<RuntimeMetricsCore>;
  const fallback = defaultsCore();
  const capabilities = value.capabilities && typeof value.capabilities === 'object'
    ? Object.fromEntries(Object.entries(value.capabilities).slice(0, MAX_CAPABILITY_METHODS))
    : {};
  return { ...fallback, ...value, version: 1, capabilities };
}

async function ensureRestored(): Promise<void> {
  if (current) return;
  if (!restorePromise) {
    restorePromise = browser.storage.local.get(RUNTIME_METRICS_STORAGE_KEY).then((stored) => {
      current = normalizeCore(stored[RUNTIME_METRICS_STORAGE_KEY]);
    }).catch((error) => {
      current = defaultsCore();
      persistenceErrors += 1;
      persistenceError = error instanceof Error ? error.message : String(error);
    });
  }
  await restorePromise;
}

function addAggregate(left: RuntimeMetricAggregate | undefined, right: RuntimeMetricAggregate): RuntimeMetricAggregate {
  return {
    count: (left?.count || 0) + right.count,
    errorCount: (left?.errorCount || 0) + right.errorCount,
    totalDurationMs: (left?.totalDurationMs || 0) + right.totalDurationMs,
    maxDurationMs: Math.max(left?.maxDurationMs || 0, right.maxDurationMs),
  };
}

function applyDelta(core: RuntimeMetricsCore, input: MetricsDelta): RuntimeMetricsCore {
  const capabilities = { ...core.capabilities };
  for (const [method, aggregate] of Object.entries(input.capabilities)) {
    capabilities[method] = addAggregate(capabilities[method], aggregate);
  }
  return {
    ...core,
    updatedAt: Date.now(),
    serviceWorkerStarts: core.serviceWorkerStarts + input.serviceWorkerStarts,
    bridgeConnectAttempts: core.bridgeConnectAttempts + input.bridgeConnectAttempts,
    bridgeConnections: core.bridgeConnections + input.bridgeConnections,
    bridgeDisconnects: core.bridgeDisconnects + input.bridgeDisconnects,
    bridgeErrors: core.bridgeErrors + input.bridgeErrors,
    heartbeatSamples: core.heartbeatSamples + input.heartbeatSamples,
    heartbeatLatencyTotalMs: core.heartbeatLatencyTotalMs + input.heartbeatLatencyTotalMs,
    heartbeatLatencyMaxMs: Math.max(core.heartbeatLatencyMaxMs, input.heartbeatLatencyMaxMs),
    capabilities,
  };
}

function mergeDelta(target: MetricsDelta, source: MetricsDelta): MetricsDelta {
  const merged = { ...target, capabilities: { ...target.capabilities } };
  merged.serviceWorkerStarts += source.serviceWorkerStarts;
  merged.bridgeConnectAttempts += source.bridgeConnectAttempts;
  merged.bridgeConnections += source.bridgeConnections;
  merged.bridgeDisconnects += source.bridgeDisconnects;
  merged.bridgeErrors += source.bridgeErrors;
  merged.heartbeatSamples += source.heartbeatSamples;
  merged.heartbeatLatencyTotalMs += source.heartbeatLatencyTotalMs;
  merged.heartbeatLatencyMaxMs = Math.max(merged.heartbeatLatencyMaxMs, source.heartbeatLatencyMaxMs);
  for (const [method, aggregate] of Object.entries(source.capabilities)) {
    merged.capabilities[method] = addAggregate(merged.capabilities[method], aggregate);
  }
  return merged;
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (flushTimer !== undefined) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = undefined;
    void flushRuntimeMetrics().catch(() => undefined);
  }, delay);
}

function record(mutator: (pending: MetricsDelta) => void): void {
  if (pendingMutations >= MAX_PENDING_MUTATIONS) {
    droppedCount += 1;
    return;
  }
  mutator(delta);
  pendingMutations += 1;
  if (pendingMutations >= FLUSH_THRESHOLD) {
    if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
    flushTimer = undefined;
    scheduleFlush(0);
  } else scheduleFlush();
}

export function metricQueueDiagnostics(): RuntimeQueueMetric {
  return {
    pending: pendingMutations,
    dropped: droppedCount,
    persistenceErrors,
    persistence: persistenceError ? 'degraded' : pendingMutations ? 'pending' : 'persisted',
    error: persistenceError?.slice(0, 512),
  };
}

function withQueues(core: RuntimeMetricsCore): RuntimeMetrics {
  return {
    ...core,
    queues: {
      audit: auditQueueDiagnostics(),
      metrics: metricQueueDiagnostics(),
      agentActions: agentRuntimeQueueDiagnostics(),
    },
  };
}

export async function getRuntimeMetrics(): Promise<RuntimeMetrics> {
  await ensureRestored();
  return withQueues(applyDelta(current || defaultsCore(), delta));
}

export async function flushRuntimeMetrics(): Promise<void> {
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
  let succeeded = false;
  const operation = flushQueue.then(async () => {
    await ensureRestored();
    if (!pendingMutations) {
      succeeded = true;
      return;
    }
    const batch = delta;
    const batchCount = pendingMutations;
    delta = emptyDelta();
    pendingMutations = 0;
    const next = applyDelta(current || defaultsCore(), batch);
    try {
      await browser.storage.local.set({ [RUNTIME_METRICS_STORAGE_KEY]: next });
      current = next;
      persistenceError = undefined;
      succeeded = true;
    } catch (error) {
      delta = mergeDelta(batch, delta);
      pendingMutations = Math.min(MAX_PENDING_MUTATIONS, batchCount + pendingMutations);
      persistenceErrors += 1;
      persistenceError = error instanceof Error ? error.message : String(error);
    }
  });
  flushQueue = operation.catch(() => undefined);
  await operation;
  if (succeeded && pendingMutations) scheduleFlush();
}

export function recordServiceWorkerStart(): void {
  record((pending) => { pending.serviceWorkerStarts += 1; });
}

export function recordBridgeState(state: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
  record((pending) => {
    pending.bridgeConnectAttempts += state === 'connecting' ? 1 : 0;
    pending.bridgeConnections += state === 'connected' ? 1 : 0;
    pending.bridgeDisconnects += state === 'disconnected' ? 1 : 0;
    pending.bridgeErrors += state === 'error' ? 1 : 0;
  });
}

export function recordHeartbeat(latencyMs: number): void {
  const bounded = Math.min(Math.max(Math.round(latencyMs), 0), 60_000);
  record((pending) => {
    pending.heartbeatSamples += 1;
    pending.heartbeatLatencyTotalMs += bounded;
    pending.heartbeatLatencyMaxMs = Math.max(pending.heartbeatLatencyMaxMs, bounded);
  });
}

export function recordCapabilityMetric(method: string, durationMs: number, error: boolean): void {
  const normalized = method.trim().slice(0, 240) || OTHER_CAPABILITY;
  const knownMethods = new Set([
    ...Object.keys(current?.capabilities || {}),
    ...Object.keys(delta.capabilities),
  ]);
  const key = knownMethods.has(normalized) || knownMethods.size < MAX_CAPABILITY_METHODS - 1
    ? normalized
    : OTHER_CAPABILITY;
  const duration = Math.min(Math.max(Math.round(durationMs), 0), 60_000);
  record((pending) => {
    pending.capabilities[key] = addAggregate(pending.capabilities[key], {
      count: 1,
      errorCount: error ? 1 : 0,
      totalDurationMs: duration,
      maxDurationMs: duration,
    });
  });
}

export async function resetRuntimeMetrics(): Promise<RuntimeMetrics> {
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
  const operation = flushQueue.then(async () => {
    delta = emptyDelta();
    pendingMutations = 0;
    current = defaultsCore();
    restorePromise = Promise.resolve();
    await browser.storage.local.set({ [RUNTIME_METRICS_STORAGE_KEY]: current });
    persistenceError = undefined;
  });
  flushQueue = operation.catch(() => undefined);
  await operation;
  return withQueues(current || defaultsCore());
}
