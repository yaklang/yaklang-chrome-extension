import { browser } from 'wxt/browser';
import type {
  BrowserAuthContextAttestation,
  BrowserTarget,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import {
  AUTH_CONTEXT_TTL_MS,
  captureAuthContextSnapshot,
  validateAuthContextBinding,
} from './auth-context';

const MAX_ATTESTATIONS = 32;
const MAX_ATTESTATION_STORAGE_BYTES = 64 * 1_024;
const STORAGE_KEY = 'browser.authorization.auth-attestations.v1';
const attestations = new Map<string, BrowserAuthContextAttestation>();
let loaded = false;

function validStoredAttestation(value: unknown): value is BrowserAuthContextAttestation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attestation = value as Partial<BrowserAuthContextAttestation>;
  return attestation.version === 1
    && typeof attestation.id === 'string'
    && attestation.id.length > 0
    && attestation.id.length <= 160
    && typeof attestation.deviceId === 'string'
    && attestation.deviceId.length > 0
    && attestation.deviceId.length <= 320
    && typeof attestation.installationId === 'string'
    && attestation.installationId.length > 0
    && attestation.installationId.length <= 320
    && typeof attestation.isolationContextId === 'string'
    && attestation.isolationContextId.length > 0
    && attestation.isolationContextId.length <= 320
    && typeof attestation.cookieStoreId === 'string'
    && attestation.cookieStoreId.length > 0
    && attestation.cookieStoreId.length <= 320
    && typeof attestation.origin === 'string'
    && attestation.origin.length > 0
    && attestation.origin.length <= 8_192
    && typeof attestation.grantId === 'string'
    && attestation.grantId.length > 0
    && attestation.grantId.length <= 160
    && typeof attestation.fingerprint === 'string'
    && /^hmac-sha256:[a-f0-9]{64}$/.test(attestation.fingerprint)
    && Boolean(attestation.target)
    && Number.isSafeInteger(attestation.target?.tabId)
    && Number(attestation.target?.tabId) > 0
    && Number.isSafeInteger(attestation.target?.frameId)
    && Number(attestation.target?.frameId) >= 0
    && typeof attestation.target?.documentId === 'string'
    && attestation.target.documentId.length > 0
    && attestation.target.documentId.length <= 160
    && Boolean(attestation.authentication)
    && ['authenticated', 'unauthenticated', 'unknown'].includes(String(attestation.authentication?.status))
    && Number.isSafeInteger(attestation.authentication?.cookieCount)
    && Number(attestation.authentication?.cookieCount) >= 0
    && Number.isSafeInteger(attestation.authentication?.storageEntryCount)
    && Number(attestation.authentication?.storageEntryCount) >= 0
    && Array.isArray(attestation.authentication?.authCookieNames)
    && attestation.authentication.authCookieNames.length <= 100
    && attestation.authentication.authCookieNames.every(
      (name) => typeof name === 'string' && name.length <= 500,
    )
    && Array.isArray(attestation.authentication?.authStorageKeys)
    && attestation.authentication.authStorageKeys.length <= 100
    && attestation.authentication.authStorageKeys.every(
      (key) => typeof key === 'string' && key.length <= 520,
    )
    && typeof attestation.createdAt === 'number'
    && typeof attestation.expiresAt === 'number'
    && attestation.expiresAt > attestation.createdAt
    && attestation.expiresAt - attestation.createdAt <= AUTH_CONTEXT_TTL_MS;
}

function purge(now = Date.now(), reserve = 0): boolean {
  let changed = false;
  for (const [id, attestation] of attestations) {
    if (attestation.expiresAt <= now) {
      attestations.delete(id);
      changed = true;
    }
  }
  while (attestations.size > MAX_ATTESTATIONS - reserve) {
    const oldest = attestations.keys().next().value as string | undefined;
    if (!oldest) break;
    attestations.delete(oldest);
    changed = true;
  }
  return changed;
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await browser.storage.session.get(STORAGE_KEY);
    const values = stored[STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-MAX_ATTESTATIONS)) {
      if (validStoredAttestation(value)) attestations.set(value.id, value);
    }
    purge();
  } catch {
    // The bounded in-memory registry remains valid for this service-worker lifetime.
  }
}

async function save(): Promise<void> {
  try {
    const retained: BrowserAuthContextAttestation[] = [];
    for (const attestation of [...attestations.values()].reverse()) {
      const candidate = [attestation, ...retained];
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_ATTESTATION_STORAGE_BYTES) break;
      retained.unshift(attestation);
    }
    attestations.clear();
    for (const attestation of retained) attestations.set(attestation.id, attestation);
    await browser.storage.session.set({ [STORAGE_KEY]: retained });
  } catch {
    // The bounded in-memory registry remains available when storage.session cannot persist.
  }
}

export async function captureAuthContextAttestation(input: {
  target: BrowserTarget;
  grantId: string;
  grantExpiresAt: number;
}): Promise<BrowserAuthContextAttestation> {
  await load();
  const now = Date.now();
  const snapshot = await captureAuthContextSnapshot(input.target);
  const attestation: BrowserAuthContextAttestation = {
    version: 1,
    id: crypto.randomUUID(),
    ...snapshot,
    grantId: input.grantId,
    createdAt: now,
    expiresAt: Math.min(now + AUTH_CONTEXT_TTL_MS, input.grantExpiresAt),
  };
  if (attestation.expiresAt <= now) {
    throw new ExtensionError('grant_expired', '浏览器共享会话已经过期');
  }
  purge(now, 1);
  attestations.set(attestation.id, attestation);
  await save();
  return attestation;
}

export async function getAuthContextAttestation(
  id: string,
  grantId: string,
): Promise<BrowserAuthContextAttestation> {
  await load();
  if (purge()) await save();
  const attestation = attestations.get(id);
  if (!attestation || attestation.grantId !== grantId) {
    throw new ExtensionError(
      'auth_context_stale',
      '认证上下文证明不存在、已过期或不属于当前共享会话',
    );
  }
  try {
    await validateAuthContextBinding(attestation);
    return attestation;
  } catch (error) {
    attestations.delete(id);
    await save();
    if (error instanceof ExtensionError && error.code === 'auth_context_stale') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtensionError('auth_context_stale', `认证上下文证明实时复核失败：${message}`);
  }
}
