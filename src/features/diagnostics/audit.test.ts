import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_STORAGE_KEY } from '@/protocol/storage';

const fixture = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  failSet: false,
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: fixture.get.mockImplementation(async (key: string) => (
          key in fixture.store ? { [key]: structuredClone(fixture.store[key]) } : {}
        )),
        set: fixture.set.mockImplementation(async (items: Record<string, unknown>) => {
          if (fixture.failSet) throw new Error('fixture quota exceeded');
          Object.assign(fixture.store, structuredClone(items));
        }),
        remove: fixture.remove.mockImplementation(async (key: string) => { delete fixture.store[key]; }),
      },
    },
  },
}));

describe('buffered audit persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    fixture.failSet = false;
    for (const key of Object.keys(fixture.store)) delete fixture.store[key];
    fixture.get.mockClear();
    fixture.set.mockClear();
    fixture.remove.mockClear();
  });

  it('serves pending events from memory and writes a burst as one bounded batch', async () => {
    const audit = await import('./audit');
    for (let index = 0; index < 120; index += 1) {
      await audit.appendAuditEvent({ category: 'capability', action: `call.${index}`, outcome: 'success' });
    }

    expect(await audit.listAuditEvents(500)).toHaveLength(120);
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.set).not.toHaveBeenCalled();
    expect(audit.auditQueueDiagnostics()).toMatchObject({ pending: 120, dropped: 0, persistence: 'pending' });

    await vi.advanceTimersByTimeAsync(101);
    expect(fixture.set).toHaveBeenCalledTimes(1);
    expect((fixture.store[AUDIT_STORAGE_KEY] as unknown[])).toHaveLength(120);
    expect(audit.auditQueueDiagnostics()).toMatchObject({ pending: 0, persistence: 'persisted' });
  });

  it('bounds an unflushable burst and exposes dropped events', async () => {
    const audit = await import('./audit');
    for (let index = 0; index < 300; index += 1) {
      void audit.appendAuditEvent({ category: 'capability', action: `burst.${index}`, outcome: 'success' });
    }
    expect(audit.auditQueueDiagnostics()).toMatchObject({ pending: 256, dropped: 44 });
  });

  it('retains a failed batch in memory and clears degraded state after retry', async () => {
    const audit = await import('./audit');
    fixture.failSet = true;
    await audit.appendAuditEvent({ category: 'bridge', action: 'bridge.connect', outcome: 'error' });
    await vi.advanceTimersByTimeAsync(101);
    expect(audit.auditQueueDiagnostics()).toMatchObject({
      pending: 1, persistenceErrors: 1, persistence: 'degraded', error: 'fixture quota exceeded',
    });

    fixture.failSet = false;
    await audit.appendAuditEvent({ category: 'bridge', action: 'bridge.retry', outcome: 'success' });
    await vi.advanceTimersByTimeAsync(101);
    expect(audit.auditQueueDiagnostics()).toMatchObject({ pending: 0, persistenceErrors: 1, persistence: 'persisted' });
    expect(fixture.store[AUDIT_STORAGE_KEY]).toHaveLength(2);
  });
});
