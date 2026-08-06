import { browser } from 'wxt/browser';
import type {
  BrowserAuthContextHandle,
  BrowserIsolationContext,
  BrowserTarget,
} from '@/types/models';
import { capturePageContext } from '@/features/page-context/service';
import { getState } from '@/platform/storage/state';
import { ExtensionError } from '@/shared/errors';
import {
  authenticationFingerprint,
  authenticationStorageEntries,
} from './auth-fingerprint';
import {
  getBrowserIsolationProof,
  inspectBrowserIsolation,
} from './isolation';
import { AUTHORIZATION_WORKSPACE_TTL_MS } from './lifetime';

export const AUTH_CONTEXT_TTL_MS = AUTHORIZATION_WORKSPACE_TTL_MS;
const MAX_AUTH_CONTEXTS = 32;
const MAX_AUTH_CONTEXT_STORAGE_BYTES = 64 * 1_024;
const STORAGE_KEY = 'browser.authorization.auth-contexts.v1';
const HMAC_KEY_STORAGE_KEY = 'browser.authorization.hmac-key.v1';

const handles = new Map<string, BrowserAuthContextHandle>();
let handlesLoaded = false;
let hmacKeyPromise: Promise<CryptoKey> | undefined;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionHmacKey(): Promise<CryptoKey> {
  if (hmacKeyPromise) return hmacKeyPromise;
  hmacKeyPromise = (async () => {
    let raw: Uint8Array | undefined;
    try {
      const stored = await browser.storage.session.get(HMAC_KEY_STORAGE_KEY);
      const encoded = stored[HMAC_KEY_STORAGE_KEY];
      if (typeof encoded === 'string') {
        const candidate = base64ToBytes(encoded);
        if (candidate.byteLength === 32) raw = candidate;
      }
    } catch {
      // A fresh in-memory session key is sufficient when storage.session is unavailable.
    }
    if (!raw) {
      raw = crypto.getRandomValues(new Uint8Array(32));
      try {
        await browser.storage.session.set({ [HMAC_KEY_STORAGE_KEY]: bytesToBase64(raw) });
      } catch {
        // Keep the key in this service worker lifetime as the fallback.
      }
    }
    return crypto.subtle.importKey(
      'raw',
      Uint8Array.from(raw).buffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  })();
  return hmacKeyPromise;
}

async function hmac(value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await sessionHmacKey(),
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(signature));
}

function authRelated(name: string): boolean {
  return /(auth|token|jwt|session|login|csrf|xsrf|sid|credential|bearer)/i.test(name);
}

function validStoredHandle(value: unknown): value is BrowserAuthContextHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handle = value as Partial<BrowserAuthContextHandle>;
  return handle.version === 1
    && typeof handle.id === 'string'
    && handle.id.length > 0
    && handle.id.length <= 160
    && ['left', 'right'].includes(String(handle.slotId))
    && typeof handle.deviceId === 'string'
    && handle.deviceId.length > 0
    && handle.deviceId.length <= 320
    && typeof handle.installationId === 'string'
    && handle.installationId.length > 0
    && handle.installationId.length <= 320
    && typeof handle.isolationContextId === 'string'
    && handle.isolationContextId.length > 0
    && handle.isolationContextId.length <= 320
    && typeof handle.isolationProofId === 'string'
    && handle.isolationProofId.length > 0
    && handle.isolationProofId.length <= 160
    && typeof handle.cookieStoreId === 'string'
    && handle.cookieStoreId.length > 0
    && handle.cookieStoreId.length <= 320
    && typeof handle.origin === 'string'
    && handle.origin.length > 0
    && handle.origin.length <= 8_192
    && typeof handle.grantId === 'string'
    && handle.grantId.length > 0
    && handle.grantId.length <= 160
    && typeof handle.fingerprint === 'string'
    && /^hmac-sha256:[a-f0-9]{64}$/.test(handle.fingerprint)
    && (handle.accountLabel === undefined
      || (typeof handle.accountLabel === 'string' && handle.accountLabel.length <= 80))
    && Boolean(handle.target)
    && Number.isSafeInteger(handle.target?.tabId)
    && Number(handle.target?.tabId) > 0
    && Number.isSafeInteger(handle.target?.frameId)
    && Number(handle.target?.frameId) >= 0
    && typeof handle.target?.documentId === 'string'
    && handle.target.documentId.length > 0
    && handle.target.documentId.length <= 160
    && Boolean(handle.authentication)
    && ['authenticated', 'unauthenticated', 'unknown'].includes(String(handle.authentication?.status))
    && Number.isSafeInteger(handle.authentication?.cookieCount)
    && Number(handle.authentication?.cookieCount) >= 0
    && Number.isSafeInteger(handle.authentication?.storageEntryCount)
    && Number(handle.authentication?.storageEntryCount) >= 0
    && Array.isArray(handle.authentication?.authCookieNames)
    && handle.authentication.authCookieNames.length <= 100
    && handle.authentication.authCookieNames.every((name) => typeof name === 'string' && name.length <= 500)
    && Array.isArray(handle.authentication?.authStorageKeys)
    && handle.authentication.authStorageKeys.length <= 100
    && handle.authentication.authStorageKeys.every((key) => typeof key === 'string' && key.length <= 520)
    && typeof handle.createdAt === 'number'
    && typeof handle.expiresAt === 'number'
    && handle.expiresAt > handle.createdAt
    && handle.expiresAt - handle.createdAt <= AUTH_CONTEXT_TTL_MS;
}

function purgeHandles(now = Date.now(), reserve = 0): boolean {
  let changed = false;
  for (const [id, handle] of handles) {
    if (handle.expiresAt <= now) {
      handles.delete(id);
      changed = true;
    }
  }
  while (handles.size > MAX_AUTH_CONTEXTS - reserve) {
    const oldest = handles.keys().next().value as string | undefined;
    if (!oldest) break;
    handles.delete(oldest);
    changed = true;
  }
  return changed;
}

async function loadHandles(): Promise<void> {
  if (handlesLoaded) return;
  handlesLoaded = true;
  try {
    const stored = await browser.storage.session.get(STORAGE_KEY);
    const values = stored[STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-MAX_AUTH_CONTEXTS)) {
      if (validStoredHandle(value)) handles.set(value.id, value);
    }
    purgeHandles();
  } catch {
    // Keep the bounded memory registry on adapters without storage.session.
  }
}

async function saveHandles(): Promise<void> {
  try {
    const retained: BrowserAuthContextHandle[] = [];
    for (const handle of [...handles.values()].reverse()) {
      const candidate = [handle, ...retained];
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_AUTH_CONTEXT_STORAGE_BYTES) break;
      retained.unshift(handle);
    }
    handles.clear();
    for (const handle of retained) handles.set(handle.id, handle);
    await browser.storage.session.set({
      [STORAGE_KEY]: retained,
    });
  } catch {
    // Keep the bounded memory registry on adapters without storage.session.
  }
}

function isolationContext(
  contexts: BrowserIsolationContext[],
  isolationContextId: string | undefined,
): BrowserIsolationContext | undefined {
  return contexts.find((context) => context.contextId === isolationContextId);
}

export interface CapturedAuthContextSnapshot {
  deviceId: string;
  installationId: string;
  isolationContextId: string;
  cookieStoreId: string;
  origin: string;
  target: BrowserTarget & { documentId: string };
  fingerprint: string;
  authentication: BrowserAuthContextHandle['authentication'];
}

type AuthContextBinding = Pick<
  BrowserAuthContextHandle,
  | 'deviceId'
  | 'installationId'
  | 'isolationContextId'
  | 'cookieStoreId'
  | 'origin'
  | 'target'
  | 'fingerprint'
>;

export async function captureAuthContextSnapshot(
  target: BrowserTarget,
): Promise<CapturedAuthContextSnapshot> {
  const inspection = await inspectBrowserIsolation([target.tabId]);
  const tab = inspection.tabs[0];
  const context = isolationContext(inspection.contexts, tab?.isolationContextId);
  if (!tab || !context?.cookieStoreId || context.level === 'none') {
    throw new ExtensionError('isolation_unresolved', '目标页面没有可用的隔离上下文，不能创建认证快照');
  }
  const pageContext = await capturePageContext(
    { includeDom: false, includeStorage: true, includeCookies: true },
    target,
  );
  if (!pageContext.target.documentId) {
    throw new ExtensionError('stale_document', '目标页面缺少稳定 document 标识');
  }
  const state = await getState();
  const deviceId = state.bridge.pairedEngine?.deviceId;
  if (!deviceId) throw new ExtensionError('bridge_disconnected', '插件尚未与 Yak 引擎配对');
  const cookies = pageContext.cookies || [];
  const storage = authenticationStorageEntries(pageContext);
  return {
    deviceId,
    installationId: state.bridge.installationId,
    isolationContextId: context.contextId,
    cookieStoreId: context.cookieStoreId,
    origin: new URL(pageContext.document.url).origin,
    target: {
      tabId: pageContext.target.tabId,
      frameId: pageContext.target.frameId,
      documentId: pageContext.target.documentId,
    },
    fingerprint: await authenticationFingerprint(pageContext, hmac),
    authentication: {
      status: pageContext.authentication.status,
      cookieCount: cookies.length,
      storageEntryCount: storage.length,
      authCookieNames: cookies
        .filter((cookie) => authRelated(cookie.name))
        .map((cookie) => cookie.name)
        .slice(0, 100),
      authStorageKeys: storage
        .filter((entry) => authRelated(entry.key))
        .map((entry) => `${entry.area}:${entry.key}`)
        .slice(0, 100),
    },
  };
}

export async function validateAuthContextBinding(binding: AuthContextBinding): Promise<void> {
  const state = await getState();
  if (state.bridge.pairedEngine?.deviceId !== binding.deviceId
    || state.bridge.installationId !== binding.installationId) {
    throw new ExtensionError('auth_context_stale', '插件安装身份或配对引擎已经变化');
  }
  const current = await captureAuthContextSnapshot(binding.target);
  if (current.isolationContextId !== binding.isolationContextId
    || current.cookieStoreId !== binding.cookieStoreId) {
    throw new ExtensionError('auth_context_stale', '目标页面的 Cookie Store 或隔离上下文已经变化');
  }
  if (current.target.documentId !== binding.target.documentId
    || current.origin !== binding.origin
    || current.fingerprint !== binding.fingerprint) {
    throw new ExtensionError('auth_context_stale', '目标文档、来源或认证材料已经变化');
  }
}

export async function captureAuthContextHandle(input: {
  slotId: 'left' | 'right';
  accountLabel?: string;
  isolationProofId: string;
  target: BrowserTarget;
  grantId: string;
  grantExpiresAt: number;
}): Promise<BrowserAuthContextHandle> {
  await loadHandles();
  const proof = await getBrowserIsolationProof(input.isolationProofId);
  if (proof.level === 'none') {
    throw new ExtensionError('isolation_unresolved', '当前证明没有建立两个身份的隔离关系，不能创建认证句柄');
  }
  const expectedTabId = input.slotId === 'left' ? proof.leftTabId : proof.rightTabId;
  if (input.target.tabId !== expectedTabId) {
    throw new ExtensionError('target_denied', '认证上下文目标与隔离证明中的身份槽位不一致');
  }
  const expectedContextId = input.slotId === 'left'
    ? proof.leftContextId
    : proof.rightContextId;
  const snapshot = await captureAuthContextSnapshot(input.target);
  if (snapshot.isolationContextId !== expectedContextId) {
    throw new ExtensionError('isolation_stale', '目标页面的隔离上下文已经变化，请重新执行预检');
  }
  const now = Date.now();
  const handle: BrowserAuthContextHandle = {
    version: 1,
    id: crypto.randomUUID(),
    slotId: input.slotId,
    accountLabel: input.accountLabel?.trim().slice(0, 80) || undefined,
    ...snapshot,
    isolationProofId: proof.id,
    grantId: input.grantId,
    createdAt: now,
    expiresAt: Math.min(now + AUTH_CONTEXT_TTL_MS, proof.expiresAt, input.grantExpiresAt),
  };
  if (handle.expiresAt <= now) throw new ExtensionError('grant_expired', '共享会话或隔离证明已经过期');
  purgeHandles(now, 1);
  handles.set(handle.id, handle);
  await saveHandles();
  return handle;
}

export async function getAuthContextHandle(id: string, grantId: string): Promise<BrowserAuthContextHandle> {
  await loadHandles();
  if (purgeHandles()) await saveHandles();
  const handle = handles.get(id);
  if (!handle || handle.grantId !== grantId) {
    throw new ExtensionError('auth_context_stale', '认证上下文句柄不存在、已过期或不属于当前共享会话');
  }
  try {
    const proof = await getBrowserIsolationProof(handle.isolationProofId);
    if (proof.level === 'none') throw new ExtensionError('auth_context_stale', '身份隔离证明已经失效');
    const expectedTabId = handle.slotId === 'left' ? proof.leftTabId : proof.rightTabId;
    const expectedContextId = handle.slotId === 'left' ? proof.leftContextId : proof.rightContextId;
    if (handle.target.tabId !== expectedTabId || handle.isolationContextId !== expectedContextId) {
      throw new ExtensionError('auth_context_stale', '认证句柄与当前隔离证明不一致');
    }
    await validateAuthContextBinding(handle);
    return handle;
  } catch (error) {
    handles.delete(id);
    await saveHandles();
    if (error instanceof ExtensionError && error.code === 'auth_context_stale') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtensionError('auth_context_stale', `认证上下文实时复核失败：${message}`);
  }
}
