import { browser } from 'wxt/browser';
import type { AuditEvent, RuntimeQueueMetric } from '@/types/models';
import { AUDIT_STORAGE_KEY } from '@/protocol/storage';

const MAX_AUDIT_EVENTS = 500;
const MAX_PENDING_EVENTS = 256;
const MAX_BATCH_EVENTS = 128;
const FLUSH_DELAY_MS = 100;

let persistedEvents: AuditEvent[] | undefined;
let restorePromise: Promise<void> | undefined;
let pendingEvents: AuditEvent[] = [];
let flushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let flushQueue: Promise<void> = Promise.resolve();
let droppedCount = 0;
let persistenceErrors = 0;
let persistenceError: string | undefined;

export type NewAuditEvent = Omit<AuditEvent, 'id' | 'timestamp'>;

function normalizeEvents(input: unknown): AuditEvent[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is AuditEvent => Boolean(item && typeof item === 'object'
    && typeof (item as AuditEvent).id === 'string'
    && typeof (item as AuditEvent).timestamp === 'number'
    && typeof (item as AuditEvent).action === 'string')).slice(-MAX_AUDIT_EVENTS);
}

async function ensureRestored(): Promise<void> {
  if (persistedEvents) return;
  if (!restorePromise) {
    restorePromise = browser.storage.local.get(AUDIT_STORAGE_KEY).then((stored) => {
      persistedEvents = normalizeEvents(stored[AUDIT_STORAGE_KEY]);
    }).catch((error) => {
      persistedEvents = [];
      persistenceErrors += 1;
      persistenceError = error instanceof Error ? error.message : String(error);
    });
  }
  await restorePromise;
}

function boundPending(): void {
  if (pendingEvents.length <= MAX_PENDING_EVENTS) return;
  const overflow = pendingEvents.length - MAX_PENDING_EVENTS;
  pendingEvents.splice(0, overflow);
  droppedCount += overflow;
}

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (flushTimer !== undefined) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = undefined;
    void flushAuditEvents().catch(() => undefined);
  }, delay);
}

async function flushOneBatch(): Promise<boolean> {
  await ensureRestored();
  if (!pendingEvents.length) return true;
  const batch = pendingEvents.splice(0, MAX_BATCH_EVENTS);
  const next = [...(persistedEvents || []), ...batch].slice(-MAX_AUDIT_EVENTS);
  try {
    await browser.storage.local.set({ [AUDIT_STORAGE_KEY]: next });
    persistedEvents = next;
    persistenceError = undefined;
    return true;
  } catch (error) {
    pendingEvents = [...batch, ...pendingEvents];
    boundPending();
    persistenceErrors += 1;
    persistenceError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function flushAuditEvents(): Promise<void> {
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
  let succeeded = false;
  const operation = flushQueue.then(async () => {
    succeeded = await flushOneBatch();
  });
  flushQueue = operation.catch(() => undefined);
  await operation;
  if (succeeded && pendingEvents.length) scheduleFlush(0);
}

export function appendAuditEvent(input: NewAuditEvent): Promise<void> {
  pendingEvents.push({ id: crypto.randomUUID(), timestamp: Date.now(), ...input });
  boundPending();
  if (pendingEvents.length >= MAX_BATCH_EVENTS) {
    if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
    flushTimer = undefined;
    scheduleFlush(0);
  } else {
    scheduleFlush();
  }
  return Promise.resolve();
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  await ensureRestored();
  const current = [...(persistedEvents || []), ...pendingEvents].slice(-MAX_AUDIT_EVENTS);
  return current.slice(-Math.min(Math.max(limit, 1), MAX_AUDIT_EVENTS)).reverse();
}

export async function clearAuditEvents(): Promise<void> {
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
  await ensureRestored();
  pendingEvents = [];
  persistedEvents = [];
  const operation = flushQueue.then(() => browser.storage.local.remove(AUDIT_STORAGE_KEY));
  flushQueue = operation.catch(() => undefined);
  await operation;
  persistenceError = undefined;
}

export function auditQueueDiagnostics(): RuntimeQueueMetric {
  return {
    pending: pendingEvents.length,
    dropped: droppedCount,
    persistenceErrors,
    persistence: persistenceError ? 'degraded' : pendingEvents.length ? 'pending' : 'persisted',
    error: persistenceError?.slice(0, 512),
  };
}
