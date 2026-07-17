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
const MAX_SESSION_BYTES = 5 * 1024 * 1024;
const CAPTURED_RESOURCE_TYPES = ['xmlhttprequest', 'ping', 'other', 'main_frame', 'sub_frame'] as const;

interface CaptureSession {
  target: BrowserTarget;
  startedAt: number;
  droppedCount: number;
  options: NetworkCaptureOptions;
  records: NetworkRequestRecord[];
  owner: { kind: 'local' } | { kind: 'grant'; grantId: string; expiresAt: number };
}

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const captureSessions = new Map<number, CaptureSession>();
const sessionStorage = (browser.storage as unknown as { session?: SessionStorageArea }).session;
let persistTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let notifyTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
const pendingNotificationTabs = new Set<number>();

function normalizedOptions(input?: Partial<NetworkCaptureOptions>): NetworkCaptureOptions {
  return {
    captureHeaders: input?.captureHeaders === true,
    captureBody: input?.captureBody === true,
    maxEntries: Math.min(Math.max(input?.maxEntries || DEFAULT_OPTIONS.maxEntries, 10), MAX_ENTRIES),
    maxBodyBytes: Math.min(Math.max(input?.maxBodyBytes || DEFAULT_OPTIONS.maxBodyBytes, 1024), MAX_BODY_BYTES),
  };
}

function isCaptureSession(value: unknown): value is CaptureSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<CaptureSession>;
  return Boolean(
    session.target && Number.isSafeInteger(session.target.tabId) && Number.isSafeInteger(session.target.frameId)
    && typeof session.startedAt === 'number' && Array.isArray(session.records),
  );
}

async function restoreSessions(): Promise<void> {
  if (!sessionStorage) return;
  try {
    const stored = await sessionStorage.get(NETWORK_CAPTURE_STORAGE_KEY);
    const sessions = stored[NETWORK_CAPTURE_STORAGE_KEY];
    if (!Array.isArray(sessions)) return;
    for (const value of sessions) {
      if (!isCaptureSession(value)) continue;
      const session: CaptureSession = {
        ...value,
        droppedCount: Number.isSafeInteger(value.droppedCount) ? value.droppedCount : 0,
        options: normalizedOptions(value.options),
        records: value.records.slice(-MAX_ENTRIES),
        owner: value.owner?.kind === 'grant' && typeof value.owner.grantId === 'string' && typeof value.owner.expiresAt === 'number'
          ? value.owner
          : { kind: 'local' },
      };
      captureSessions.set(session.target.tabId, session);
    }
  } catch {
    // Session persistence is an optimization; capture still works in memory.
  }
}

const restorePromise = restoreSessions();

function schedulePersist(): void {
  if (!sessionStorage || persistTimer) return;
  persistTimer = globalThis.setTimeout(() => {
    persistTimer = undefined;
    void sessionStorage.set({ [NETWORK_CAPTURE_STORAGE_KEY]: [...captureSessions.values()] }).catch(() => undefined);
  }, 250);
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

function matchingSession(details: Pick<Browser.webRequest.WebRequestDetails, 'tabId' | 'frameId' | 'type'> & { documentId?: string }): CaptureSession | undefined {
  const session = captureSessions.get(details.tabId);
  if (!session || details.frameId !== session.target.frameId) return undefined;
  if (session.owner.kind === 'grant' && session.owner.expiresAt <= Date.now()) {
    captureSessions.delete(details.tabId);
    schedulePersist();
    notifyChanged(details.tabId);
    return undefined;
  }
  const isFrameNavigation = details.type === 'main_frame' || details.type === 'sub_frame';
  if (!isFrameNavigation && session.target.documentId && details.documentId && session.target.documentId !== details.documentId) return undefined;
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

function commit(session: CaptureSession, tabId: number): void {
  while (session.records.length > session.options.maxEntries) {
    session.records.shift();
    session.droppedCount += 1;
  }
  let estimatedBytes = session.records.reduce((total, record) => total + JSON.stringify(record).length, 0);
  while (estimatedBytes > MAX_SESSION_BYTES && session.records.length > 1) {
    const removed = session.records.shift();
    estimatedBytes -= removed ? JSON.stringify(removed).length : 0;
    session.droppedCount += 1;
  }
  schedulePersist();
  notifyChanged(tabId);
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
  commit(session, details.tabId);
  return undefined;
}

function onBeforeSendHeaders(details: Browser.webRequest.OnBeforeSendHeadersDetails): Browser.webRequest.BlockingResponse | undefined {
  const session = matchingSession(details);
  if (!session?.options.captureHeaders) return undefined;
  const record = findRecord(session, details.requestId);
  if (!record) return undefined;
  record.requestHeaders = normalizeHeaders(details.requestHeaders);
  commit(session, details.tabId);
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
  commit(session, details.tabId);
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
  commit(session, details.tabId);
}

function errorRecord(details: Browser.webRequest.OnErrorOccurredDetails): void {
  const session = matchingSession(details);
  if (!session) return;
  const record = findRecord(session, details.requestId);
  if (!record) return;
  record.completedAt = details.timeStamp;
  record.durationMs = Math.max(0, Math.round((details.timeStamp - record.startedAt) * 100) / 100);
  record.error = details.error.slice(0, 512);
  commit(session, details.tabId);
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['requestBody']);
browser.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['requestHeaders', 'extraHeaders']);
browser.webRequest.onBeforeRedirect.addListener(onBeforeRedirect, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['responseHeaders', 'extraHeaders']);
browser.webRequest.onCompleted.addListener(completeRecord, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] }, ['responseHeaders', 'extraHeaders']);
browser.webRequest.onErrorOccurred.addListener(errorRecord, { urls: ['<all_urls>'], types: [...CAPTURED_RESOURCE_TYPES] });
browser.tabs.onRemoved.addListener((tabId) => {
  if (captureSessions.delete(tabId)) schedulePersist();
});

function sameTarget(left: BrowserTarget, right: BrowserTarget): boolean {
  return left.tabId === right.tabId && left.frameId === right.frameId
    && (!left.documentId || !right.documentId || left.documentId === right.documentId);
}

function sessionFor(target: BrowserTarget): CaptureSession | undefined {
  const session = captureSessions.get(target.tabId);
  if (session?.owner.kind === 'grant' && session.owner.expiresAt <= Date.now()) {
    captureSessions.delete(target.tabId);
    schedulePersist();
    return undefined;
  }
  return session && sameTarget(session.target, target) ? session : undefined;
}

export async function startNetworkCapture(
  target: BrowserTarget,
  options?: Partial<NetworkCaptureOptions>,
  owner: CaptureSession['owner'] = { kind: 'local' },
): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session: CaptureSession = { target, startedAt: Date.now(), droppedCount: 0, options: normalizedOptions(options), records: [], owner };
  captureSessions.set(target.tabId, session);
  schedulePersist();
  notifyChanged(target.tabId);
  return networkCaptureStatus(target);
}

export async function networkCaptureStatus(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session = sessionFor(target);
  return session
    ? { active: true, target: session.target, startedAt: session.startedAt, count: session.records.length, droppedCount: session.droppedCount, options: session.options }
    : { active: false, target, count: 0, droppedCount: 0 };
}

export async function listNetworkRequests(target: BrowserTarget, limit = 100): Promise<NetworkRequestRecord[]> {
  await restorePromise;
  const session = sessionFor(target);
  if (!session) return [];
  return structuredClone(session.records.slice(-Math.min(Math.max(limit, 1), MAX_ENTRIES)).reverse());
}

export async function clearNetworkRequests(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  const session = sessionFor(target);
  if (session) {
    session.records = [];
    session.droppedCount = 0;
    schedulePersist();
    notifyChanged(target.tabId);
  }
  return networkCaptureStatus(target);
}

export async function stopNetworkCapture(target: BrowserTarget): Promise<NetworkCaptureStatus> {
  await restorePromise;
  captureSessions.delete(target.tabId);
  schedulePersist();
  notifyChanged(target.tabId);
  return { active: false, target, count: 0, droppedCount: 0 };
}

export async function stopNetworkCapturesForGrant(grantId: string): Promise<void> {
  await restorePromise;
  let changed = false;
  for (const [tabId, session] of captureSessions) {
    if (session.owner.kind !== 'grant' || session.owner.grantId !== grantId) continue;
    captureSessions.delete(tabId);
    notifyChanged(tabId);
    changed = true;
  }
  if (changed) schedulePersist();
}

function bodyBytes(body?: NetworkBody): Uint8Array {
  if (!body) return new Uint8Array();
  return body.encoding === 'base64' ? base64ToBytes(body.data) : new TextEncoder().encode(body.data);
}

export async function exportNetworkRequest(target: BrowserTarget, id: string): Promise<NetworkRequestExport> {
  await restorePromise;
  const session = sessionFor(target);
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
