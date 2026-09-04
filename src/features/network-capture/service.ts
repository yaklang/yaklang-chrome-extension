import { browser, type Browser } from 'wxt/browser';
import { NETWORK_CAPTURE_STORAGE_KEY } from '@/protocol/storage';
import type {
  BrowserTarget, NetworkBody, NetworkCaptureOptions, NetworkCaptureStatus, NetworkHeader,
  NetworkRequestExport, NetworkRequestRecord,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const DEFAULT_OPTIONS: NetworkCaptureOptions = {
  captureHeaders: false,
  captureBody: false,
  maxEntries: 100,
  maxBodyBytes: 32 * 1024,
};
const MAX_ENTRIES = 200;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_COUNT = 256;
const MAX_HEADER_VALUE_LENGTH = 16 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
export const NETWORK_CAPTURE_SESSION_MAX_BYTES = 5 * 1024 * 1024;
export const NETWORK_CAPTURE_GLOBAL_MAX_BYTES = 8 * 1024 * 1024;
export const NETWORK_CAPTURE_GLOBAL_MAX_ENTRIES = 1_000;
export const NETWORK_CAPTURE_MAX_SESSIONS = 64;
const MAX_DEFERRED_CAPTURE_EVENTS = 128;
const CAPTURED_RESOURCE_TYPES = [
  'xmlhttprequest',
  'ping',
  'other',
  'main_frame',
  'sub_frame',
  'websocket',
] as const;

type CapturePersistence = 'pending' | 'persisted' | 'memory-only' | 'degraded';
type CaptureOwner = { kind: 'local' } | {
  kind: 'grant'; grantId: string; expiresAt: number; followSameOriginNavigation?: boolean;
};

interface CaptureSession {
  target: BrowserTarget;
  origin: string;
  isolationBoundary: string;
  startedAt: number;
  droppedCount: number;
  options: NetworkCaptureOptions;
  records: NetworkRequestRecord[];
  owner: CaptureOwner;
  retainedBytes: number;
  recordBytes: Map<string, number>;
  revision: number;
  persistence: CapturePersistence;
  persistenceError?: string;
}

interface PersistedCaptureSession {
  target: BrowserTarget;
  origin: string;
  isolationBoundary: string;
  startedAt: number;
  droppedCount: number;
  options: NetworkCaptureOptions;
  records: NetworkRequestRecord[];
  owner: CaptureOwner;
}

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const captureSessions = new Map<number, CaptureSession>();
const sessionStorage = (browser.storage as unknown as { session?: SessionStorageArea }).session;
let persistTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let persistInFlight = false;
let mutationRevision = 0;
let totalRecordCount = 0;
let totalRetainedBytes = 0;
let notifyTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
const pendingNotificationTabs = new Set<number>();
const deferredCaptureEvents: Array<() => void> = [];
const deferredCaptureDrops = new Map<number, number>();
let restoreComplete = false;

function normalizedOptions(input?: Partial<NetworkCaptureOptions>): NetworkCaptureOptions {
  return {
    captureHeaders: input?.captureHeaders === true,
    captureBody: input?.captureBody === true,
    maxEntries: Math.min(Math.max(input?.maxEntries || DEFAULT_OPTIONS.maxEntries, 10), MAX_ENTRIES),
    maxBodyBytes: Math.min(Math.max(input?.maxBodyBytes || DEFAULT_OPTIONS.maxBodyBytes, 1024), MAX_BODY_BYTES),
  };
}

function isNetworkRequestRecord(value: unknown): value is NetworkRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<NetworkRequestRecord>;
  return typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 160
    && typeof record.requestId === 'string' && record.requestId.length > 0 && record.requestId.length <= 512
    && Number.isSafeInteger(record.tabId) && Number.isSafeInteger(record.frameId)
    && typeof record.url === 'string' && record.url.length <= 16_384
    && typeof record.method === 'string' && record.method.length <= 64
    && typeof record.resourceType === 'string' && record.resourceType.length <= 160
    && typeof record.startedAt === 'number'
    && typeof record.requestHeadersCaptured === 'boolean'
    && typeof record.requestBodyCaptured === 'boolean'
    && Array.isArray(record.redirects);
}

function isCaptureSession(value: unknown): value is PersistedCaptureSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<PersistedCaptureSession>;
  return Boolean(
    session.target && Number.isSafeInteger(session.target.tabId) && Number.isSafeInteger(session.target.frameId)
    && typeof session.origin === 'string' && /^https?:\/\//i.test(session.origin)
    && typeof session.isolationBoundary === 'string' && session.isolationBoundary.length > 0
    && typeof session.startedAt === 'number' && Array.isArray(session.records)
    && session.records.every(isNetworkRequestRecord),
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function recordSize(record: NetworkRequestRecord): number {
  try {
    return encodedBytes(record);
  } catch {
    return NETWORK_CAPTURE_SESSION_MAX_BYTES + 1;
  }
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function isolationBoundaryForTab(tab: Browser.tabs.Tab): string {
  const cookieStoreId = typeof (tab as Browser.tabs.Tab & { cookieStoreId?: unknown }).cookieStoreId === 'string'
    ? String((tab as Browser.tabs.Tab & { cookieStoreId?: string }).cookieStoreId)
    : 'default';
  return `${tab.incognito ? 'private' : 'regular'}:${cookieStoreId}`;
}

async function captureBoundary(target: BrowserTarget): Promise<{
  target: BrowserTarget;
  origin: string;
  isolationBoundary: string;
}> {
  const [frame, tab] = await Promise.all([
    browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId }),
    browser.tabs.get(target.tabId),
  ]);
  const origin = frame?.url ? originOf(frame.url) : undefined;
  if (!frame || !origin) throw new ExtensionError('target_unavailable', '网络捕获只能绑定到可访问的 HTTP(S) 文档');
  if (target.documentId && frame.documentId && target.documentId !== frame.documentId) {
    throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新选择');
  }
  return {
    target: { tabId: target.tabId, frameId: target.frameId, documentId: frame.documentId || target.documentId },
    origin,
    isolationBoundary: isolationBoundaryForTab(tab),
  };
}

function persistedSession(session: CaptureSession): PersistedCaptureSession {
  return {
    target: session.target,
    origin: session.origin,
    isolationBoundary: session.isolationBoundary,
    startedAt: session.startedAt,
    droppedCount: session.droppedCount,
    options: session.options,
    records: session.records,
    owner: session.owner,
  };
}

function notifySessions(sessions: Iterable<CaptureSession>): void {
  for (const session of sessions) notifyChanged(session.target.tabId);
}

function schedulePersist(): void {
  if (!sessionStorage || persistTimer || persistInFlight) return;
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = undefined;
    const snapshotRevision = mutationRevision;
    const snapshot = [...captureSessions.values()].map(persistedSession);
    persistInFlight = true;
    void Promise.resolve().then(() => sessionStorage.set({ [NETWORK_CAPTURE_STORAGE_KEY]: snapshot })).then(() => {
      const changed: CaptureSession[] = [];
      for (const session of captureSessions.values()) {
        if (session.revision > snapshotRevision || session.persistence === 'persisted') continue;
        session.persistence = 'persisted';
        session.persistenceError = undefined;
        changed.push(session);
      }
      notifySessions(changed);
    }).catch((error) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      const changed: CaptureSession[] = [];
      for (const session of captureSessions.values()) {
        session.persistence = 'degraded';
        session.persistenceError = message;
        changed.push(session);
      }
      notifySessions(changed);
    }).finally(() => {
      persistInFlight = false;
      if (mutationRevision > snapshotRevision) schedulePersist();
    });
  }, 250);
}

function markDirty(sessions: Iterable<CaptureSession> = []): void {
  mutationRevision += 1;
  for (const session of sessions) {
    session.revision = mutationRevision;
    if (!sessionStorage) {
      session.persistence = 'memory-only';
      session.persistenceError = undefined;
    } else if (session.persistence !== 'degraded') {
      session.persistence = 'pending';
      session.persistenceError = undefined;
    }
  }
  schedulePersist();
}

function unregisterSessionRecords(session: CaptureSession): void {
  totalRecordCount = Math.max(0, totalRecordCount - session.records.length);
  totalRetainedBytes = Math.max(0, totalRetainedBytes - session.retainedBytes);
  session.records = [];
  session.recordBytes.clear();
  session.retainedBytes = 0;
}

function deleteSession(tabId: number): CaptureSession | undefined {
  const session = captureSessions.get(tabId);
  if (!session) return undefined;
  unregisterSessionRecords(session);
  captureSessions.delete(tabId);
  return session;
}

function addRestoredSession(value: PersistedCaptureSession): boolean {
  if (value.owner?.kind === 'grant' && value.owner.expiresAt <= Date.now()) return false;
  const records: NetworkRequestRecord[] = [];
  const seenIds = new Set<string>();
  for (let index = value.records.length - 1; index >= 0 && records.length < MAX_ENTRIES; index -= 1) {
    const record = value.records[index];
    if (seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    records.unshift(record);
  }
  const recordBytes = new Map<string, number>();
  let retainedBytes = 0;
  for (const record of records) {
    const bytes = recordSize(record);
    recordBytes.set(record.id, bytes);
    retainedBytes += bytes;
  }
  const session: CaptureSession = {
    target: value.target,
    origin: value.origin,
    isolationBoundary: value.isolationBoundary,
    startedAt: value.startedAt,
    droppedCount: Number.isSafeInteger(value.droppedCount) ? Math.max(0, value.droppedCount) : 0,
    options: normalizedOptions(value.options),
    records,
    owner: value.owner?.kind === 'grant' && typeof value.owner.grantId === 'string' && typeof value.owner.expiresAt === 'number'
      ? { ...value.owner, followSameOriginNavigation: value.owner.followSameOriginNavigation === true }
      : { kind: 'local' },
    retainedBytes,
    recordBytes,
    revision: 0,
    persistence: 'persisted',
  };
  const existing = captureSessions.get(session.target.tabId);
  if (existing) unregisterSessionRecords(existing);
  captureSessions.set(session.target.tabId, session);
  totalRecordCount += records.length;
  totalRetainedBytes += retainedBytes;
  const ownerWasValid = value.owner?.kind === 'local'
    || (value.owner?.kind === 'grant'
      && typeof value.owner.grantId === 'string'
      && typeof value.owner.expiresAt === 'number'
      && (value.owner.followSameOriginNavigation === undefined
        || typeof value.owner.followSameOriginNavigation === 'boolean'));
  return records.length === value.records.length && ownerWasValid && !existing;
}

async function restoreSessions(): Promise<void> {
  if (!sessionStorage) return;
  let repaired = false;
  try {
    const stored = await sessionStorage.get(NETWORK_CAPTURE_STORAGE_KEY);
    const sessions = stored[NETWORK_CAPTURE_STORAGE_KEY];
    if (!Array.isArray(sessions)) return;
    for (const value of sessions) {
      if (!isCaptureSession(value)) {
        repaired = true;
        continue;
      }
      if (!addRestoredSession(value)) repaired = true;
    }
    const changed = enforceBudgets();
    if (changed.size > 0) repaired = true;
    if (captureSessions.size > NETWORK_CAPTURE_MAX_SESSIONS) repaired = true;
    while (captureSessions.size > NETWORK_CAPTURE_MAX_SESSIONS) {
      const oldest = [...captureSessions.values()].sort((left, right) => left.startedAt - right.startedAt || left.target.tabId - right.target.tabId)[0];
      if (!oldest) break;
      deleteSession(oldest.target.tabId);
    }
    if (repaired) markDirty(captureSessions.values());
  } catch {
    // Session persistence is an optimization; capture still works in memory.
  }
}

const restorePromise = restoreSessions().finally(() => {
  restoreComplete = true;
  for (const replay of deferredCaptureEvents.splice(0)) replay();
  const changed = new Set<CaptureSession>();
  for (const [tabId, count] of deferredCaptureDrops) {
    const session = captureSessions.get(tabId);
    if (!session) continue;
    session.droppedCount += count;
    changed.add(session);
    notifyChanged(tabId);
  }
  deferredCaptureDrops.clear();
  if (changed.size > 0) markDirty(changed);
});

function dispatchCaptureEvent<T extends { tabId: number }>(handler: (details: T) => unknown, details: T): void {
  if (restoreComplete) {
    handler(details);
    return;
  }
  if (deferredCaptureEvents.length >= MAX_DEFERRED_CAPTURE_EVENTS) {
    deferredCaptureDrops.set(details.tabId, (deferredCaptureDrops.get(details.tabId) || 0) + 1);
    return;
  }
  let snapshot = details;
  try {
    snapshot = structuredClone(details);
  } catch { /* WebRequest details remain valid for the current event-loop turn. */ }
  deferredCaptureEvents.push(() => handler(snapshot));
}

function notifyChanged(tabId: number): void {
  pendingNotificationTabs.add(tabId);
  if (notifyTimer) return;
  notifyTimer = globalThis.setTimeout(() => {
    notifyTimer = undefined;
    const tabIds = [...pendingNotificationTabs];
    pendingNotificationTabs.clear();
    for (const changedTabId of tabIds) {
      void browser.runtime.sendMessage({ action: 'network.capture.changed', payload: { tabId: changedTabId } }).catch(() => undefined);
    }
  }, 100);
}

function matchingSession(details: Pick<Browser.webRequest.WebRequestDetails, 'tabId' | 'frameId' | 'type' | 'url' | 'initiator'> & { documentId?: string }): CaptureSession | undefined {
  const session = captureSessions.get(details.tabId);
  if (!session || details.frameId !== session.target.frameId) return undefined;
  if (session.owner.kind === 'grant' && session.owner.expiresAt <= Date.now()) {
    deleteSession(details.tabId);
    markDirty();
    notifyChanged(details.tabId);
    return undefined;
  }
  const isFrameNavigation = details.type === 'main_frame' || details.type === 'sub_frame';
  if (isFrameNavigation && originOf(details.url) !== session.origin) return undefined;
  if (!isFrameNavigation && session.target.documentId && details.documentId && session.target.documentId !== details.documentId) return undefined;
  if (!isFrameNavigation && !details.documentId && details.initiator
    && originOf(details.initiator) !== session.origin) return undefined;
  return session;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBody(bytes: Uint8Array, byteLength: number, truncated: boolean): NetworkBody {
  try {
    return { encoding: 'utf8', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes), byteLength, truncated };
  } catch {
    return { encoding: 'base64', data: bytesToBase64(bytes), byteLength, truncated };
  }
}

function requestBody(details: Browser.webRequest.OnBeforeRequestDetails, maxBytes: number): NetworkBody | undefined {
  const raw = details.requestBody?.raw || [];
  if (raw.length > 0) {
    const parts = raw.flatMap((part) => part.bytes ? [new Uint8Array(part.bytes)] : []);
    const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
    const output = new Uint8Array(Math.min(byteLength, maxBytes));
    let offset = 0;
    for (const part of parts) {
      if (offset >= output.length) break;
      const slice = part.subarray(0, output.length - offset);
      output.set(slice, offset);
      offset += slice.length;
    }
    const body = encodeBody(output, byteLength, byteLength > output.length);
    if (parts.length !== raw.length) body.reconstructed = true;
    return body;
  }
  const formData = details.requestBody?.formData;
  if (!formData) return undefined;
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries(formData)) {
    for (const value of values) params.append(key, typeof value === 'string' ? value : '[binary]');
  }
  const bytes = new TextEncoder().encode(params.toString());
  return { ...encodeBody(bytes.subarray(0, maxBytes), bytes.byteLength, bytes.byteLength > maxBytes), reconstructed: true };
}

function normalizeHeaders(headers?: Browser.webRequest.HttpHeader[]): NetworkHeader[] | undefined {
  if (!headers) return undefined;
  const output: NetworkHeader[] = [];
  let remaining = MAX_HEADER_BYTES;
  for (const header of headers.slice(0, MAX_HEADER_COUNT)) {
    const name = header.name.slice(0, 256);
    const sourceValue = header.value || (header.binaryValue ? `[binary:${header.binaryValue.byteLength}]` : '');
    const value = sourceValue.slice(0, Math.min(MAX_HEADER_VALUE_LENGTH, Math.max(remaining - name.length, 0)));
    if (remaining <= name.length) break;
    output.push({ name, value });
    remaining -= name.length + value.length;
  }
  return output;
}

function findRecord(session: CaptureSession, requestId: string): NetworkRequestRecord | undefined {
  for (let index = session.records.length - 1; index >= 0; index -= 1) {
    if (session.records[index].requestId === requestId) return session.records[index];
  }
  return undefined;
}

function refreshRecordAccounting(session: CaptureSession, record: NetworkRequestRecord): void {
  const previousBytes = session.recordBytes.get(record.id);
  const nextBytes = recordSize(record);
  session.recordBytes.set(record.id, nextBytes);
  if (previousBytes === undefined) {
    totalRecordCount += 1;
    session.retainedBytes += nextBytes;
    totalRetainedBytes += nextBytes;
    return;
  }
  const delta = nextBytes - previousBytes;
  session.retainedBytes += delta;
  totalRetainedBytes += delta;
}

function removeRecordAt(session: CaptureSession, index: number): NetworkRequestRecord | undefined {
  const [removed] = session.records.splice(index, 1);
  if (!removed) return undefined;
  const bytes = session.recordBytes.get(removed.id) ?? recordSize(removed);
  session.recordBytes.delete(removed.id);
  session.retainedBytes = Math.max(0, session.retainedBytes - bytes);
  totalRecordCount = Math.max(0, totalRecordCount - 1);
  totalRetainedBytes = Math.max(0, totalRetainedBytes - bytes);
  session.droppedCount += 1;
  return removed;
}

function enforceBudgets(changed = new Set<CaptureSession>()): Set<CaptureSession> {
  for (const session of captureSessions.values()) {
    while (session.records.length > session.options.maxEntries
      || session.retainedBytes > NETWORK_CAPTURE_SESSION_MAX_BYTES) {
      if (!removeRecordAt(session, 0)) break;
      changed.add(session);
    }
  }
  while (totalRecordCount > NETWORK_CAPTURE_GLOBAL_MAX_ENTRIES
    || totalRetainedBytes > NETWORK_CAPTURE_GLOBAL_MAX_BYTES) {
    let candidate: { session: CaptureSession; index: number; record: NetworkRequestRecord } | undefined;
    for (const session of captureSessions.values()) {
      for (let index = 0; index < session.records.length; index += 1) {
        const record = session.records[index];
        if (!candidate
          || record.startedAt < candidate.record.startedAt
          || (record.startedAt === candidate.record.startedAt && session.target.tabId < candidate.session.target.tabId)
          || (record.startedAt === candidate.record.startedAt && session.target.tabId === candidate.session.target.tabId
            && record.id.localeCompare(candidate.record.id) < 0)) {
          candidate = { session, index, record };
        }
      }
    }
    if (!candidate || !removeRecordAt(candidate.session, candidate.index)) break;
    changed.add(candidate.session);
  }
  return changed;
}

function commit(session: CaptureSession, tabId: number, record: NetworkRequestRecord): void {
  refreshRecordAccounting(session, record);
  const changed = enforceBudgets(new Set([session]));
  markDirty(changed);
  notifyChanged(tabId);
  for (const affected of changed) {
    if (affected.target.tabId !== tabId) notifyChanged(affected.target.tabId);
  }
}

function onBeforeRequest(details: Browser.webRequest.OnBeforeRequestDetails): Browser.webRequest.BlockingResponse | undefined {
  const session = matchingSession(details);
  if (!session) return undefined;
  let record = findRecord(session, details.requestId);
  if (!record) {
    record = {
      id: crypto.randomUUID(), requestId: details.requestId, tabId: details.tabId, frameId: details.frameId,
      documentId: details.documentId, url: details.url, method: details.method, resourceType: details.type,
      initiator: details.initiator, startedAt: details.timeStamp, requestHeadersCaptured: session.options.captureHeaders,
      requestBodyCaptured: session.options.captureBody, redirects: [],
    };
    session.records.push(record);
  } else {
    record.url = details.url;
    record.method = details.method;
    record.startedAt = details.timeStamp;
  }
  if (session.options.captureBody) record.requestBody = requestBody(details, session.options.maxBodyBytes);
  commit(session, details.tabId, record);
  return undefined;
}

function onBeforeSendHeaders(details: Browser.webRequest.OnBeforeSendHeadersDetails): Browser.webRequest.BlockingResponse | undefined {
  const session = matchingSession(details);
  if (!session?.options.captureHeaders) return undefined;
  const record = findRecord(session, details.requestId);
  if (!record) return undefined;
  record.requestHeaders = normalizeHeaders(details.requestHeaders);
  commit(session, details.tabId, record);
  return undefined;
}

function onBeforeRedirect(details: Browser.webRequest.OnBeforeRedirectDetails): void {
  const session = matchingSession(details);
  if (!session) return;
  const record = findRecord(session, details.requestId);
  if (!record) return;
  record.redirects.push({ url: details.url, statusCode: details.statusCode, redirectUrl: details.redirectUrl, timestamp: details.timeStamp });
  record.statusCode = details.statusCode;
  record.statusLine = details.statusLine;
  commit(session, details.tabId, record);
}

function completeRecord(details: Browser.webRequest.OnCompletedDetails): void {
  const session = matchingSession(details);
  if (!session) return;
  const record = findRecord(session, details.requestId);
  if (!record) return;
  record.completedAt = details.timeStamp;
  record.durationMs = Math.max(0, Math.round((details.timeStamp - record.startedAt) * 100) / 100);
  record.statusCode = details.statusCode;
  record.statusLine = details.statusLine;
  record.fromCache = details.fromCache;
  record.ip = details.ip;
  if (session.options.captureHeaders) record.responseHeaders = normalizeHeaders(details.responseHeaders);
  const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value;
  const contentLength = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-length')?.value;
  record.responseContentType = contentType?.slice(0, 512);
  if (contentLength && Number.isSafeInteger(Number(contentLength))) record.responseSize = Number(contentLength);
  commit(session, details.tabId, record);
}

function errorRecord(details: Browser.webRequest.OnErrorOccurredDetails): void {
  const session = matchingSession(details);
  if (!session) return;
  const record = findRecord(session, details.requestId);
  if (!record) return;
  record.completedAt = details.timeStamp;
  record.durationMs = Math.max(0, Math.round((details.timeStamp - record.startedAt) * 100) / 100);
  record.error = details.error.slice(0, 512);
  commit(session, details.tabId, record);
}

browser.webRequest.onBeforeRequest.addListener((details) => {
  dispatchCaptureEvent(onBeforeRequest, details);
  return undefined;
}, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['requestBody']);
browser.webRequest.onBeforeSendHeaders.addListener((details) => {
  dispatchCaptureEvent(onBeforeSendHeaders, details);
  return undefined;
}, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['requestHeaders', 'extraHeaders']);
browser.webRequest.onBeforeRedirect.addListener((details) => {
  dispatchCaptureEvent(onBeforeRedirect, details);
}, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['responseHeaders', 'extraHeaders']);
browser.webRequest.onCompleted.addListener((details) => {
  dispatchCaptureEvent(completeRecord, details);
}, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['responseHeaders', 'extraHeaders']);
browser.webRequest.onErrorOccurred.addListener((details) => {
  dispatchCaptureEvent(errorRecord, details);
}, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] });

async function rebindCaptureAfterNavigation(details: {
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
}): Promise<void> {
  await restorePromise;
  const session = captureSessions.get(details.tabId);
  if (!session || session.target.frameId !== details.frameId
    || (session.owner.kind === 'grant' && !session.owner.followSameOriginNavigation)) return;
  if (details.documentId && session.target.documentId === details.documentId) return;
  let isolationBoundary: string | undefined;
  try {
    isolationBoundary = isolationBoundaryForTab(await browser.tabs.get(details.tabId));
  } catch {
    isolationBoundary = undefined;
  }
  if (captureSessions.get(details.tabId) !== session) return;
  const nextOrigin = originOf(details.url);
  if (!nextOrigin || nextOrigin !== session.origin || isolationBoundary !== session.isolationBoundary) {
    deleteSession(details.tabId);
    markDirty();
    notifyChanged(details.tabId);
    return;
  }
  session.target = {
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
  };
  markDirty([session]);
  notifyChanged(details.tabId);
}

browser.webNavigation.onCommitted.addListener((details) => {
  void rebindCaptureAfterNavigation(details).catch(() => undefined);
});
browser.tabs.onRemoved.addListener((tabId) => {
  if (!deleteSession(tabId)) return;
  markDirty();
  pendingNotificationTabs.delete(tabId);
});

function sameTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.tabId === right.tabId && left.frameId === right.frameId
    && (!left.documentId || !right.documentId || left.documentId === right.documentId);
}

async function sessionFor(target: BrowserTarget): Promise<CaptureSession | undefined> {
  const session = captureSessions.get(target.tabId);
  if (session?.owner.kind === 'grant' && session.owner.expiresAt <= Date.now()) {
    deleteSession(target.tabId);
    markDirty();
    notifyChanged(target.tabId);
    return undefined;
  }
  if (!session) return undefined;
  const sameFrame = session.target.tabId === target.tabId && session.target.frameId === target.frameId;
  const sameDocument = Boolean(
    session.target.documentId
    && target.documentId
    && session.target.documentId === target.documentId,
  );
  if (sameTarget(session.target, target) && (session.owner.kind === 'grant' || sameDocument)) return session;
  if (session.owner.kind !== 'local'
    || !sameFrame) return undefined;
  let boundary: Awaited<ReturnType<typeof captureBoundary>> | undefined;
  try {
    boundary = await captureBoundary(target);
  } catch {
    boundary = undefined;
  }
  if (captureSessions.get(target.tabId) !== session) return undefined;
  if (!boundary || boundary.origin !== session.origin || boundary.isolationBoundary !== session.isolationBoundary) {
    deleteSession(target.tabId);
    markDirty();
    notifyChanged(target.tabId);
    return undefined;
  }
  if (sameTarget(session.target, boundary.target)
    && session.target.documentId === boundary.target.documentId) return session;
  session.target = boundary.target;
  markDirty([session]);
  notifyChanged(target.tabId);
  return session;
}

export async function startNetworkCapture(
  target: BrowserTarget,
  options?: Partial<NetworkCaptureOptions>,
  owner: CaptureOwner = { kind: 'local' },
): Promise<NetworkCaptureStatus> {
  await restorePromise;
  if (owner.kind === 'grant' && owner.expiresAt <= Date.now()) {
    throw new ExtensionError('grant_expired', '浏览器共享会话已经过期，无法开始网络捕获');
  }
  const boundary = await captureBoundary(target);
  if (captureSessions.has(target.tabId)) deleteSession(target.tabId);
  while (captureSessions.size >= NETWORK_CAPTURE_MAX_SESSIONS) {
    const oldest = [...captureSessions.values()].sort((left, right) => left.startedAt - right.startedAt || left.target.tabId - right.target.tabId)[0];
    if (!oldest) break;
    deleteSession(oldest.target.tabId);
    notifyChanged(oldest.target.tabId);
  }
  const session: CaptureSession = {
    target: boundary.target,
    origin: boundary.origin,
    isolationBoundary: boundary.isolationBoundary,
    startedAt: Date.now(),
    droppedCount: 0,
    options: normalizedOptions(options),
    records: [],
    owner,
    retainedBytes: 0,
    recordBytes: new Map(),
    revision: 0,
    persistence: sessionStorage ? 'pending' : 'memory-only',
  };
  captureSessions.set(boundary.target.tabId, session);
  markDirty([session]);
  notifyChanged(boundary.target.tabId);
  return networkCaptureStatus(boundary.target);
}

export async function networkCaptureStatus(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session = await sessionFor(target);
  return session
    ? {
      active: true,
      target: session.target,
      startedAt: session.startedAt,
      count: session.records.length,
      droppedCount: session.droppedCount,
      options: session.options,
      retainedBytes: session.retainedBytes,
      globalCount: totalRecordCount,
      globalRetainedBytes: totalRetainedBytes,
      persistence: session.persistence,
      persistenceError: session.persistenceError,
    }
    : { active: false, target, count: 0, droppedCount: 0 };
}

export async function listNetworkRequests(target: BrowserTarget, limit = 100): Promise<NetworkRequestRecord[]> {
  await restorePromise;
  const session = await sessionFor(target);
  if (!session) return [];
  return structuredClone(session.records.slice(-Math.min(Math.max(limit, 1), MAX_ENTRIES)).reverse());
}

export async function clearNetworkRequests(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session = await sessionFor(target);
  if (session) {
    unregisterSessionRecords(session);
    session.droppedCount = 0;
    markDirty([session]);
    notifyChanged(target.tabId);
  }
  return networkCaptureStatus(target);
}

export async function stopNetworkCapture(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session = await sessionFor(target);
  if (session) {
    deleteSession(session.target.tabId);
    markDirty();
    notifyChanged(session.target.tabId);
  }
  return { active: false, target, count: 0, droppedCount: 0 };
}

export async function stopNetworkCapturesForGrant(grantId: string): Promise<void> {
  await restorePromise;
  let changed = false;
  for (const [tabId, session] of captureSessions) {
    if (session.owner.kind !== 'grant' || session.owner.grantId !== grantId) continue;
    deleteSession(tabId);
    notifyChanged(tabId);
    changed = true;
  }
  if (changed) markDirty();
}

export async function rebindNetworkCapturesForGrant(
  grantId: string,
  targets: readonly BrowserTarget[],
): Promise<void> {
  await restorePromise;
  const targetsByFrame = new Map(
    targets.map((target) => [`${target.tabId}:${target.frameId}`, target] as const),
  );
  let changed = false;
  const dirtySessions = new Set<CaptureSession>();
  for (const [tabId, session] of captureSessions) {
    if (session.owner.kind !== 'grant' || session.owner.grantId !== grantId) continue;
    const target = targetsByFrame.get(`${session.target.tabId}:${session.target.frameId}`);
    if (!target) {
      deleteSession(tabId);
      notifyChanged(tabId);
      changed = true;
      continue;
    }
    if (sameTarget(session.target, target)) continue;
    session.target = {
      tabId: target.tabId,
      frameId: target.frameId,
      documentId: target.documentId,
    };
    dirtySessions.add(session);
    notifyChanged(tabId);
    changed = true;
  }
  if (changed) markDirty(dirtySessions);
}

function bodyBytes(body?: NetworkBody): Uint8Array {
  if (!body) return new Uint8Array();
  return body.encoding === 'base64' ? base64ToBytes(body.data) : new TextEncoder().encode(body.data);
}

export async function exportNetworkRequest(target: BrowserTarget, id: string): Promise<NetworkRequestExport> {
  await restorePromise;
  const session = await sessionFor(target);
  const record = session?.records.find((item) => item.id === id);
  if (!record) throw new ExtensionError('network_request_not_found', '网络请求不存在或已经被有界缓冲区淘汰');
  if (!record.requestHeadersCaptured || !record.requestHeaders) {
    throw new ExtensionError('network_headers_not_captured', '该请求未捕获实际请求头，无法生成可重放数据包');
  }
  const url = new URL(record.url);
  const headers = record.requestHeaders.filter((header) => !header.name.startsWith(':'));
  if (!headers.some((header) => header.name.toLowerCase() === 'host')) {
    headers.unshift({ name: 'Host', value: url.host });
  }
  const path = `${url.pathname || '/'}${url.search}`;
  const head = `${record.method} ${path} HTTP/1.1\r\n${headers.map((header) => `${header.name}: ${header.value}`).join('\r\n')}\r\n\r\n`;
  const headBytes = new TextEncoder().encode(head);
  const body = bodyBytes(record.requestBody);
  const packet = new Uint8Array(headBytes.length + body.length);
  packet.set(headBytes);
  packet.set(body, headBytes.length);
  const limitations: string[] = [];
  if (record.requestBody?.truncated) limitations.push(`请求体只保留前 ${body.length} 字节`);
  if (record.requestBody?.reconstructed) limitations.push('浏览器未提供完整原始请求体，当前内容由可用字段重建');
  if (!record.requestBody && !['GET', 'HEAD', 'OPTIONS'].includes(record.method.toUpperCase())) {
    limitations.push(record.requestBodyCaptured ? '浏览器未提供该请求体，重放数据包可能不完整' : '捕获时未启用请求体，重放数据包可能不完整');
  }
  const rawRequest = record.requestBody?.encoding === 'base64'
    ? `${head}[binary body: ${record.requestBody.byteLength} bytes]`
    : `${head}${record.requestBody?.data || ''}`;
  return { id: record.id, url: record.url, isHttps: url.protocol === 'https:', rawRequest, rawRequestBase64: bytesToBase64(packet), limitations };
}

export function redactNetworkRequests(records: NetworkRequestRecord[]): NetworkRequestRecord[] {
  return records.map(({ requestHeaders: _requestHeaders, responseHeaders: _responseHeaders, requestBody: _requestBody, ...record }) => ({
    ...record,
    requestHeadersCaptured: false,
    requestBodyCaptured: false,
  }));
}
