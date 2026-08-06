import type { BrowserRecordingCallArgument, BrowserRecordingCrypto } from '@/types/models';
import type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { tweetNaclManifest } from './catalog';
import { asRecord, callableProxy, opaqueKey } from './modern-common';

interface TweetNaclOperationDefinition {
  path: string;
  operation: string;
  family: BrowserRecordingCrypto['family'];
  algorithm: string;
  callableKind: CallableOperationKind;
  inputIndex: number;
  roles: BrowserRecordingCallArgument['role'][];
  keyIndex?: number;
  keyKind?: NonNullable<BrowserRecordingCrypto['key']>['kind'];
  failureOnEmpty?: boolean;
}

const OPERATIONS: TweetNaclOperationDefinition[] = [
  { path: 'secretbox', operation: 'secretbox.encrypt', family: 'symmetric', algorithm: 'XSalsa20-Poly1305', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'nonce', 'key'], keyIndex: 2, keyKind: 'secret' },
  { path: 'secretbox.open', operation: 'secretbox.decrypt', family: 'symmetric', algorithm: 'XSalsa20-Poly1305', callableKind: 'decrypt', inputIndex: 0, roles: ['data', 'nonce', 'key'], keyIndex: 2, keyKind: 'secret', failureOnEmpty: true },
  { path: 'box', operation: 'box.encrypt', family: 'asymmetric', algorithm: 'X25519-XSalsa20-Poly1305', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'nonce', 'key', 'key'], keyIndex: 3, keyKind: 'private' },
  { path: 'box.open', operation: 'box.decrypt', family: 'asymmetric', algorithm: 'X25519-XSalsa20-Poly1305', callableKind: 'decrypt', inputIndex: 0, roles: ['data', 'nonce', 'key', 'key'], keyIndex: 3, keyKind: 'private', failureOnEmpty: true },
  { path: 'sign', operation: 'ed25519.sign-attached', family: 'signature', algorithm: 'Ed25519', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'private' },
  { path: 'sign.open', operation: 'ed25519.open-signed', family: 'signature', algorithm: 'Ed25519', callableKind: 'verify', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'public', failureOnEmpty: true },
  { path: 'sign.detached', operation: 'ed25519.sign', family: 'signature', algorithm: 'Ed25519', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'private' },
  { path: 'sign.detached.verify', operation: 'ed25519.verify', family: 'signature', algorithm: 'Ed25519', callableKind: 'verify', inputIndex: 0, roles: ['data', 'signature', 'key'], keyIndex: 2, keyKind: 'public', failureOnEmpty: true },
  { path: 'hash', operation: 'sha512.digest', family: 'digest', algorithm: 'SHA-512', callableKind: 'digest', inputIndex: 0, roles: ['data'] },
];

function resolve(root: Record<string, unknown>, path: string): { owner: Record<string, unknown>; key: string } | undefined {
  const segments = path.split('.');
  let owner = root;
  for (const segment of segments.slice(0, -1)) {
    const next = asRecord(owner[segment]);
    if (!next) return undefined;
    owner = next;
  }
  const key = segments.at(-1)!;
  try { return typeof owner[key] === 'function' ? { owner, key } : undefined; } catch { return undefined; }
}

function describe(
  definition: TweetNaclOperationDefinition,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const nonceIndex = definition.roles.indexOf('nonce');
  const nonceSummary = nonceIndex >= 0 ? `nonceBytes=${toolkit.byteLength(args[nonceIndex]) || 0}` : undefined;
  return {
    crypto: {
      adapterId: tweetNaclManifest.id,
      providerKind: tweetNaclManifest.providerKind,
      family: definition.family,
      operation: definition.operation,
      algorithm: definition.algorithm,
      inputEncoding: 'auto',
      outputEncoding: 'auto',
      state: { model: 'stateless', phase: 'one-shot' },
      key: definition.keyIndex === undefined
        ? undefined
        : opaqueKey(args[definition.keyIndex], definition.keyKind || 'unknown', toolkit),
    },
    inputIndex: definition.inputIndex,
    callableKind: definition.callableKind,
    outputEncoding: 'auto',
    arguments: args.slice(0, 8).map((value, index) => toolkit.argument(
      index,
      definition.roles[index] || 'unknown',
      value,
      index === definition.inputIndex,
      true,
      index === nonceIndex ? nonceSummary : undefined,
    )),
    outputError: definition.failureOnEmpty
      ? (value) => value === false || value === null ? `${definition.algorithm} verification failed` : undefined
      : undefined,
    adaptInput: (value) => toolkit.defaultAdaptInput(value, args[definition.inputIndex]),
  };
}

export const tweetNaclAdapter: PageCryptoAdapter = {
  manifest: tweetNaclManifest,
  discover(scope): CryptoAdapterOperation[] {
    const globals = scope.window as unknown as { nacl?: unknown; tweetnacl?: unknown };
    const root = asRecord(globals.nacl) || asRecord(globals.tweetnacl);
    if (!root) return [];
    return OPERATIONS.flatMap((definition) => {
      const target = resolve(root, definition.path);
      return target ? [{
        id: `tweetnacl.${definition.path}`,
        operation: definition.operation,
        owner: target.owner,
        key: target.key,
        resultMode: 'sync' as const,
        describe: (_thisArg: unknown, args: unknown[], toolkit: CryptoAdapterToolkit) => describe(definition, args, toolkit),
        createWrapper: callableProxy,
      }] : [];
    });
  },
};
