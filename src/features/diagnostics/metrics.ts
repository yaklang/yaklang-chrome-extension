import { browser } from 'wxt/browser';
import { RUNTIME_METRICS_STORAGE_KEY } from '@/protocol/storage';
import type { RuntimeMetrics } from '@/types/models';

let queue: Promise<void> = Promise.resolve();

function defaults(): RuntimeMetrics {
  const now = Date.now();
  return {
    version: 1, firstSeenAt: now, updatedAt: now, serviceWorkerStarts: 0,
    bridgeConnectAttempts: 0, bridgeConnections: 0, bridgeDisconnects: 0, bridgeErrors: 0,
    heartbeatSamples: 0, heartbeatLatencyTotalMs: 0, heartbeatLatencyMaxMs: 0, capabilities: {},
  };
}

export async function getRuntimeMetrics(): Promise<RuntimeMetrics> {
  const stored = (await browser.storage.local.get(RUNTIME_METRICS_STORAGE_KEY))[RUNTIME_METRICS_STORAGE_KEY];
  if (!stored || typeof stored !== 'object') return defaults();
  return { ...defaults(), ...(stored as Partial<RuntimeMetrics>), capabilities: (stored as RuntimeMetrics).capabilities || {} };
}

function mutate(updater: (current: RuntimeMetrics) => RuntimeMetrics): void {
  queue = queue.then(async () => {
    const next = updater(await getRuntimeMetrics());
    next.updatedAt = Date.now();
    await browser.storage.local.set({ [RUNTIME_METRICS_STORAGE_KEY]: next });
  }).catch(() => undefined);
}

export function recordServiceWorkerStart(): void {
  mutate((current) => ({ ...current, serviceWorkerStarts: current.serviceWorkerStarts + 1 }));
}

export function recordBridgeState(state: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
  mutate((current) => ({
    ...current,
    bridgeConnectAttempts: current.bridgeConnectAttempts + (state === 'connecting' ? 1 : 0),
    bridgeConnections: current.bridgeConnections + (state === 'connected' ? 1 : 0),
    bridgeDisconnects: current.bridgeDisconnects + (state === 'disconnected' ? 1 : 0),
    bridgeErrors: current.bridgeErrors + (state === 'error' ? 1 : 0),
  }));
}

export function recordHeartbeat(latencyMs: number): void {
  const bounded = Math.min(Math.max(Math.round(latencyMs), 0), 60_000);
  mutate((current) => ({
    ...current,
    heartbeatSamples: current.heartbeatSamples + 1,
    heartbeatLatencyTotalMs: current.heartbeatLatencyTotalMs + bounded,
    heartbeatLatencyMaxMs: Math.max(current.heartbeatLatencyMaxMs, bounded),
  }));
}

export function recordCapabilityMetric(method: string, durationMs: number, error: boolean): void {
  mutate((current) => {
    const previous = current.capabilities[method] || { count: 0, errorCount: 0, totalDurationMs: 0, maxDurationMs: 0 };
    const duration = Math.min(Math.max(Math.round(durationMs), 0), 60_000);
    return {
      ...current,
      capabilities: {
        ...current.capabilities,
        [method]: {
          count: previous.count + 1,
          errorCount: previous.errorCount + (error ? 1 : 0),
          totalDurationMs: previous.totalDurationMs + duration,
          maxDurationMs: Math.max(previous.maxDurationMs, duration),
        },
      },
    };
  });
}

export async function resetRuntimeMetrics(): Promise<RuntimeMetrics> {
  const next = defaults();
  await browser.storage.local.set({ [RUNTIME_METRICS_STORAGE_KEY]: next });
  return next;
}
