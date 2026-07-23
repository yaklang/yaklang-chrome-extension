import type { BrowserRecordingCallArgument } from '@/types/models';
import { algorithmSummary, callableOperationKind, cryptoFamily } from './common';
import type {
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { webCryptoManifest } from './catalog';

type WebCryptoOperation = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'digest' | 'deriveBits' | 'deriveKey'
  | 'generateKey' | 'importKey' | 'exportKey' | 'wrapKey' | 'unwrapKey';

const OPERATIONS: WebCryptoOperation[] = [
  'encrypt', 'decrypt', 'sign', 'verify', 'digest', 'deriveBits', 'deriveKey',
  'generateKey', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey',
];

const ROLES: Partial<Record<WebCryptoOperation, BrowserRecordingCallArgument['role'][]>> = {
  encrypt: ['algorithm', 'key', 'data'],
  decrypt: ['algorithm', 'key', 'data'],
  sign: ['algorithm', 'key', 'data'],
  verify: ['algorithm', 'key', 'signature', 'data'],
  digest: ['algorithm', 'data'],
  deriveBits: ['algorithm', 'key', 'unknown'],
  deriveKey: ['algorithm', 'key', 'algorithm', 'unknown', 'unknown'],
  generateKey: ['algorithm', 'unknown', 'unknown'],
  importKey: ['unknown', 'data', 'algorithm', 'unknown', 'unknown'],
  exportKey: ['unknown', 'key'],
  wrapKey: ['unknown', 'key', 'key', 'algorithm'],
  unwrapKey: ['data', 'key', 'algorithm', 'algorithm', 'unknown', 'unknown'],
};

function inputIndex(operation: WebCryptoOperation): number {
  if (operation === 'digest') return 1;
  if (['encrypt', 'decrypt', 'sign'].includes(operation)) return 2;
  return -1;
}

function describe(
  operation: WebCryptoOperation,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const input = inputIndex(operation);
  const algorithm = algorithmSummary(args[0], toolkit.byteLength);
  const callableKind = callableOperationKind(operation);
  return {
    crypto: {
      adapterId: webCryptoManifest.id,
      providerKind: webCryptoManifest.providerKind,
      family: cryptoFamily(operation, algorithm),
      operation,
      algorithm,
      inputEncoding: 'auto',
      outputEncoding: 'auto',
      state: { model: 'receiver', phase: 'one-shot' },
    },
    inputIndex: input,
    callableKind: input >= 0 ? callableKind : undefined,
    outputEncoding: 'auto',
    arguments: args.slice(0, 8).map((value, index) => {
      const role = ROLES[operation]?.[index] || 'unknown';
      return toolkit.argument(
        index,
        role,
        value,
        index === input,
        input >= 0 && Boolean(callableKind),
        role === 'algorithm' ? algorithmSummary(value, toolkit.byteLength) : undefined,
      );
    }),
  };
}

function wrapper(
  operation: WebCryptoOperation,
  invoke: (thisArg: unknown, args: unknown[]) => unknown,
): Function {
  switch (operation) {
    case 'encrypt': return function recordedEncrypt(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'decrypt': return function recordedDecrypt(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'sign': return function recordedSign(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'verify': return function recordedVerify(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'digest': return function recordedDigest(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'deriveBits': return function recordedDeriveBits(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'deriveKey': return function recordedDeriveKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'generateKey': return function recordedGenerateKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'importKey': return function recordedImportKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'exportKey': return function recordedExportKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'wrapKey': return function recordedWrapKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
    case 'unwrapKey': return function recordedUnwrapKey(this: SubtleCrypto, ...args: unknown[]) { return invoke(this, args); };
  }
}

export const webCryptoAdapter: PageCryptoAdapter = {
  manifest: webCryptoManifest,
  discover(scope): CryptoAdapterOperation[] {
    const subtle = scope.crypto?.subtle || scope.window.crypto?.subtle;
    if (!subtle) return [];
    const owner = Object.getPrototypeOf(subtle) as Record<string, unknown>;
    return OPERATIONS.map((operation) => ({
      id: `webcrypto.subtle.${operation}`,
      operation,
      owner,
      key: operation,
      resultMode: 'promise',
      describe: (_thisArg, args, toolkit) => describe(operation, args, toolkit),
      createWrapper: (_original, invoke) => wrapper(operation, invoke),
    }));
  },
};
