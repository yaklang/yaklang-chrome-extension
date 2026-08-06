import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_METRICS_STORAGE_KEY } from '@/protocol/storage';

const fixture = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  failSet: false,
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(async () => undefined),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: fixture.get.mockImplementation(async (key: string) => (
          key in fixture.store ? { [key]: structuredClone(fixture.store[key]) } : {}
        )),
        set: fixture.set.mockImplementation(async (items: Record<string, unknown>) => {
          if (fixture.failSet) throw new Error('fixture metrics write failed');
          Object.assign(fixture.store, structuredClone(items));
        }),
        remove: fixture.remove,
      },
    },
  },
}));

describe('aggregated runtime metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    fixture.failSet = false;
    for (const key of Object.keys(fixture.store)) delete fixture.store[key];
    fixture.get.mockClear();
    fixture.set.mockClear();
  });

  it('aggregates a high-frequency capability burst into one storage write', async () => {
    const metrics = await import('./metrics');
    for (let index = 0; index < 100; index += 1) {
      metrics.recordCapabilityMetric('browser.context.capture', index, index % 10 === 0);
    }
    expect((await metrics.getRuntimeMetrics()).capabilities['browser.context.capture']).toMatchObject({
      count: 100, errorCount: 10, maxDurationMs: 99,
    });
    expect(metrics.metricQueueDiagnostics()).toMatchObject({ pending: 100, persistence: 'pending' });

    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.set).toHaveBeenCalledTimes(1);
    const stored = fixture.store[RUNTIME_METRICS_STORAGE_KEY] as { capabilities: Record<string, { count: number }> };
    expect(stored.capabilities['browser.context.capture'].count).toBe(100);
    expect(metrics.metricQueueDiagnostics()).toMatchObject({ pending: 0, persistence: 'persisted' });
  });

  it('caps metric cardinality and aggregates excess methods into one bucket', async () => {
    const metrics = await import('./metrics');
    for (let index = 0; index < 400; index += 1) metrics.recordCapabilityMetric(`method.${index}`, 1, false);
    const snapshot = await metrics.getRuntimeMetrics();
    expect(Object.keys(snapshot.capabilities).length).toBeLessThanOrEqual(256);
    expect(snapshot.capabilities.__other__?.count).toBeGreaterThan(0);
  });

  it('keeps deltas after storage failure and reports recovery', async () => {
    const metrics = await import('./metrics');
    fixture.failSet = true;
    metrics.recordHeartbeat(12);
    await vi.advanceTimersByTimeAsync(501);
    expect(metrics.metricQueueDiagnostics()).toMatchObject({
      pending: 1, persistenceErrors: 1, persistence: 'degraded', error: 'fixture metrics write failed',
    });
    fixture.failSet = false;
    metrics.recordHeartbeat(18);
    await vi.advanceTimersByTimeAsync(501);
    expect(metrics.metricQueueDiagnostics()).toMatchObject({ pending: 0, persistenceErrors: 1, persistence: 'persisted' });
    const stored = fixture.store[RUNTIME_METRICS_STORAGE_KEY] as { heartbeatSamples: number; heartbeatLatencyTotalMs: number };
    expect(stored).toMatchObject({ heartbeatSamples: 2, heartbeatLatencyTotalMs: 30 });
  });
});
