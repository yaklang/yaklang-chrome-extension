import type { BridgeEnvelope } from '@/types/messages';
import type { BridgePublicKey } from '@/types/models';

const DATABASE_NAME = 'yakit-browser-bridge-identity-v1';
const STORE_NAME = 'identities';

interface StoredBrowserIdentity {
  installationId: string;
  privateKey: CryptoKey;
  publicKey: BridgePublicKey;
  createdAt: number;
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'installationId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开浏览器配对身份数据库'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('浏览器配对身份数据库操作失败'));
  });
}

async function readIdentity(installationId: string): Promise<StoredBrowserIdentity | undefined> {
  const database = await openIdentityDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    return await requestResult(transaction.objectStore(STORE_NAME).get(installationId)) as StoredBrowserIdentity | undefined;
  } finally {
    database.close();
  }
}

async function writeIdentity(identity: StoredBrowserIdentity): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).put(identity));
  } finally {
    database.close();
  }
}

export async function clearBrowserBridgeIdentity(installationId: string): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    await requestResult(transaction.objectStore(STORE_NAME).delete(installationId));
  } finally {
    database.close();
  }
}

function normalizePublicJWK(value: JsonWebKey): BridgePublicKey {
  if (value.kty !== 'EC' || value.crv !== 'P-256' || !value.x || !value.y) throw new Error('浏览器配对公钥不是 ECDSA P-256');
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}

export async function getOrCreateBrowserBridgeIdentity(installationId: string): Promise<StoredBrowserIdentity> {
  const existing = await readIdentity(installationId);
  if (existing?.privateKey && existing.publicKey) return existing;
  const generated = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [publicJWK, privatePKCS8] = await Promise.all([
    crypto.subtle.exportKey('jwk', generated.publicKey),
    crypto.subtle.exportKey('pkcs8', generated.privateKey),
  ]);
  const privateKey = await crypto.subtle.importKey('pkcs8', privatePKCS8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const identity: StoredBrowserIdentity = {
    installationId,
    privateKey,
    publicKey: normalizePublicJWK(publicJWK),
    createdAt: Date.now(),
  };
  await writeIdentity(identity);
  return identity;
}

function bytesToBase64URL(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64URLToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBridgeNonce(): string {
  return bytesToBase64URL(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signBridgePayload(privateKey: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(payload));
  return bytesToBase64URL(new Uint8Array(signature));
}

export async function verifyBridgePayload(publicKey: BridgePublicKey, payload: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    base64URLToBytes(signature).buffer as ArrayBuffer,
    new TextEncoder().encode(payload),
  );
}

export function engineChallengePayload(input: {
  engineIdentityId: string;
  engineInstanceId: string;
  challenge: string;
  timestamp: number;
}): string {
  return [
    'yak-browser-bridge-v3', 'engine-challenge', input.engineIdentityId, input.engineInstanceId,
    input.challenge, String(input.timestamp),
  ].join('\n');
}

export function clientAuthPayload(input: {
  origin: string;
  engineIdentityId: string;
  engineInstanceId: string;
  challenge: string;
  envelope: BridgeEnvelope;
}): string {
  const fields = [
    'yak-browser-bridge-v3', 'client-auth', input.origin, input.engineIdentityId, input.engineInstanceId,
    input.challenge, input.envelope.installationId || '', input.envelope.client || '', input.envelope.version || '',
    [...(input.envelope.capabilities || [])].sort().join(','),
    String(input.envelope.capabilityCatalog?.version || ''),
    input.envelope.capabilityCatalog?.hash || '',
    input.envelope.taskId || '', input.envelope.grantId || '',
    input.envelope.resumeSessionId || '',
  ];
  if (input.envelope.managedInstance) {
    fields.push(
      input.envelope.managedInstance.manager,
      input.envelope.managedInstance.instanceId,
      input.envelope.managedInstance.badge,
    );
  }
  return fields.join('\n');
}

export async function pairingVerificationCode(input: {
  engineIdentityId: string;
  requestId: string;
  origin: string;
  installationId: string;
  clientNonce: string;
  serverNonce: string;
  publicKey: BridgePublicKey;
  managedInstance?: BridgeEnvelope['managedInstance'];
}): Promise<string> {
  const fields = [
    'yak-browser-pairing-v1', input.engineIdentityId, input.requestId, input.origin, input.installationId,
    input.clientNonce, input.serverNonce, input.publicKey.kty, input.publicKey.crv, input.publicKey.x, input.publicKey.y,
  ];
  if (input.managedInstance) {
    fields.push(input.managedInstance.manager, input.managedInstance.instanceId, input.managedInstance.badge);
  }
  const payload = fields.join('\n');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)));
  let value = 0n;
  for (const byte of hash.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  return String(value % 1_000_000n).padStart(6, '0');
}

export function publicKeysEqual(left: BridgePublicKey, right: BridgePublicKey): boolean {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}
