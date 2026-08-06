import type {
  BrowserCryptoFamily,
  BrowserCryptoProviderKind,
  BrowserPageCallableValueEncoding,
  BrowserRecordingCrypto,
  BrowserDeepCaptureMatcher,
  BrowserRecordingEvent,
} from '@/types/models';
import { cryptoAdapterLabel } from './adapters/catalog';

const PROVIDER_KINDS: BrowserCryptoProviderKind[] = ['native', 'library', 'business', 'wasm', 'unknown'];
const FAMILIES: BrowserCryptoFamily[] = [
  'symmetric', 'asymmetric', 'digest', 'mac', 'signature', 'kdf', 'key-management', 'unknown',
];
const ENCODINGS: BrowserPageCallableValueEncoding[] = ['auto', 'utf8', 'hex', 'base64', 'json'];
const ADAPTER_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const OPERATION_ID = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,159}$/;

function optionalString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
}

export function normalizeBrowserRecordingCrypto(value: unknown): BrowserRecordingCrypto | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.adapterId !== 'string' || !ADAPTER_ID.test(input.adapterId)
    || !PROVIDER_KINDS.includes(input.providerKind as BrowserCryptoProviderKind)
    || !FAMILIES.includes(input.family as BrowserCryptoFamily)
    || typeof input.operation !== 'string' || !OPERATION_ID.test(input.operation)) return undefined;
  const keyInput = input.key && typeof input.key === 'object' ? input.key as Record<string, unknown> : undefined;
  const keyKinds: NonNullable<BrowserRecordingCrypto['key']>['kind'][] = ['public', 'private', 'secret', 'unknown'];
  const key = keyInput && keyKinds.includes(keyInput.kind as NonNullable<BrowserRecordingCrypto['key']>['kind'])
    ? {
      kind: keyInput.kind as NonNullable<BrowserRecordingCrypto['key']>['kind'],
      bits: Number.isSafeInteger(keyInput.bits) && Number(keyInput.bits) >= 1 && Number(keyInput.bits) <= 1_048_576
        ? Number(keyInput.bits) : undefined,
      fingerprint: optionalString(keyInput.fingerprint, 160),
    }
    : undefined;
  const stateInput = input.state && typeof input.state === 'object' ? input.state as Record<string, unknown> : undefined;
  const stateModels: NonNullable<BrowserRecordingCrypto['state']>['model'][] = [
    'stateless', 'receiver', 'session', 'stream', 'async-ready',
  ];
  const phases: NonNullable<BrowserRecordingCrypto['state']>['phase'][] = ['create', 'init', 'update', 'final', 'one-shot'];
  const state = stateInput && stateModels.includes(stateInput.model as NonNullable<BrowserRecordingCrypto['state']>['model'])
    ? {
      model: stateInput.model as NonNullable<BrowserRecordingCrypto['state']>['model'],
      correlationId: optionalString(stateInput.correlationId, 160),
      phase: phases.includes(stateInput.phase as NonNullable<BrowserRecordingCrypto['state']>['phase'])
        ? stateInput.phase as NonNullable<BrowserRecordingCrypto['state']>['phase']
        : undefined,
    }
    : undefined;
  return {
    adapterId: input.adapterId,
    providerKind: input.providerKind as BrowserCryptoProviderKind,
    family: input.family as BrowserCryptoFamily,
    operation: input.operation,
    algorithm: optionalString(input.algorithm, 240),
    mode: optionalString(input.mode, 120),
    padding: optionalString(input.padding, 120),
    inputEncoding: ENCODINGS.includes(input.inputEncoding as BrowserPageCallableValueEncoding)
      ? input.inputEncoding as BrowserPageCallableValueEncoding : undefined,
    outputEncoding: ENCODINGS.includes(input.outputEncoding as BrowserPageCallableValueEncoding)
      ? input.outputEncoding as BrowserPageCallableValueEncoding : undefined,
    state,
    key,
  };
}

export function cryptoEventLabel(event: Pick<BrowserRecordingEvent, 'operation' | 'crypto'>): string {
  const crypto = event.crypto;
  if (!crypto) return event.operation;
  return `${cryptoAdapterLabel(crypto.adapterId)} ${crypto.algorithm || crypto.operation || event.operation}`;
}

export function isForwardCryptoEvent(event: BrowserRecordingEvent): boolean {
  if (event.kind !== 'crypto' || !event.crypto) return false;
  const operation = `${event.operation} ${event.crypto.operation}`.toLowerCase();
  if (operation.includes('decrypt') || operation.includes('verify') || operation.includes('decode')) return false;
  return ['encrypt', 'sign', 'digest', 'hmac', 'sha', 'md5', 'ripemd', 'pbkdf', 'evpkdf']
    .some((name) => operation.includes(name));
}

export function isReverseCryptoEvent(event: BrowserRecordingEvent): boolean {
  if (event.kind !== 'crypto' || !event.crypto) return false;
  const operation = `${event.operation} ${event.crypto.operation}`.toLowerCase();
  if (operation.includes('verify')) return false;
  return ['decrypt', 'decipher', 'unseal', '.open', 'box.open', 'secretbox.open']
    .some((name) => operation.includes(name));
}

export function cryptoDeepCaptureMatcher(event: Pick<
  BrowserRecordingEvent,
  'kind' | 'crypto' | 'wrapperHandleId' | 'scriptUrl'
>): BrowserDeepCaptureMatcher | undefined {
  if (event.kind !== 'crypto' || !event.crypto || !event.wrapperHandleId) return undefined;
  return {
    kind: 'crypto',
    adapterId: event.crypto.adapterId,
    operation: event.crypto.operation,
    wrapperHandleId: event.wrapperHandleId,
    scriptUrl: event.scriptUrl,
  };
}
