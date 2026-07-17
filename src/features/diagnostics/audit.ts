import { browser } from 'wxt/browser';
import type { AuditEvent } from '@/types/models';
import { AUDIT_STORAGE_KEY } from '@/protocol/storage';

const MAX_AUDIT_EVENTS = 500;
let auditQueue: Promise<void> = Promise.resolve();

export type NewAuditEvent = Omit<AuditEvent, 'id' | 'timestamp'>;

export function appendAuditEvent(input: NewAuditEvent): Promise<void> {
  const operation = auditQueue.then(async () => {
    const stored = await browser.storage.local.get(AUDIT_STORAGE_KEY);
    const current = Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] as AuditEvent[] : [];
    const event: AuditEvent = { id: crypto.randomUUID(), timestamp: Date.now(), ...input };
    await browser.storage.local.set({ [AUDIT_STORAGE_KEY]: [...current, event].slice(-MAX_AUDIT_EVENTS) });
  });
  auditQueue = operation.catch(() => undefined);
  return operation;
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  const stored = await browser.storage.local.get(AUDIT_STORAGE_KEY);
  const current = Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] as AuditEvent[] : [];
  return current.slice(-Math.min(Math.max(limit, 1), MAX_AUDIT_EVENTS)).reverse();
}

export async function clearAuditEvents(): Promise<void> {
  const operation = auditQueue.then(() => browser.storage.local.remove(AUDIT_STORAGE_KEY));
  auditQueue = operation.catch(() => undefined);
  return operation;
}
