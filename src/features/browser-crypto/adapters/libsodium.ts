import type { BrowserRecordingCallArgument, BrowserRecordingCrypto } from '@/types/models';
import type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { libsodiumManifest } from './catalog';
import { asRecord, callableProxy, hasMethod, opaqueKey } from './modern-common';

interface SodiumOperationDefinition {
  key: string;
  operation: string;
  family: BrowserRecordingCrypto['family'];
  algorithm: string;
  callableKind?: CallableOperationKind;
  inputIndex: number;
  roles: BrowserRecordingCallArgument['role'][];
  keyIndex?: number;
  keyKind?: NonNullable<BrowserRecordingCrypto['key']>['kind'];
  failureOnEmpty?: boolean;
}

const OPERATIONS: SodiumOperationDefinition[] = [
  { key: 'crypto_secretbox_easy', operation: 'secretbox.encrypt', family: 'symmetric', algorithm: 'XSalsa20-Poly1305', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'nonce', 'key'], keyIndex: 2, keyKind: 'secret' },
  { key: 'crypto_secretbox_open_easy', operation: 'secretbox.decrypt', family: 'symmetric', algorithm: 'XSalsa20-Poly1305', callableKind: 'decrypt', inputIndex: 0, roles: ['data', 'nonce', 'key'], keyIndex: 2, keyKind: 'secret', failureOnEmpty: true },
  { key: 'crypto_box_easy', operation: 'box.encrypt', family: 'asymmetric', algorithm: 'X25519-XSalsa20-Poly1305', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'nonce', 'key', 'key'], keyIndex: 3, keyKind: 'private' },
  { key: 'crypto_box_open_easy', operation: 'box.decrypt', family: 'asymmetric', algorithm: 'X25519-XSalsa20-Poly1305', callableKind: 'decrypt', inputIndex: 0, roles: ['data', 'nonce', 'key', 'key'], keyIndex: 3, keyKind: 'private', failureOnEmpty: true },
  { key: 'crypto_box_seal', operation: 'sealed-box.encrypt', family: 'asymmetric', algorithm: 'X25519-SealedBox', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'public' },
  { key: 'crypto_box_seal_open', operation: 'sealed-box.decrypt', family: 'asymmetric', algorithm: 'X25519-SealedBox', callableKind: 'decrypt', inputIndex: 0, roles: ['data', 'key', 'key'], keyIndex: 2, keyKind: 'private', failureOnEmpty: true },
  { key: 'crypto_aead_xchacha20poly1305_ietf_encrypt', operation: 'aead.xchacha20poly1305.encrypt', family: 'symmetric', algorithm: 'XChaCha20-Poly1305-IETF', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'aad', 'options', 'nonce', 'key'], keyIndex: 4, keyKind: 'secret' },
  { key: 'crypto_aead_xchacha20poly1305_ietf_decrypt', operation: 'aead.xchacha20poly1305.decrypt', family: 'symmetric', algorithm: 'XChaCha20-Poly1305-IETF', callableKind: 'decrypt', inputIndex: 1, roles: ['options', 'data', 'aad', 'nonce', 'key'], keyIndex: 4, keyKind: 'secret', failureOnEmpty: true },
  { key: 'crypto_aead_chacha20poly1305_ietf_encrypt', operation: 'aead.chacha20poly1305.encrypt', family: 'symmetric', algorithm: 'ChaCha20-Poly1305-IETF', callableKind: 'encrypt', inputIndex: 0, roles: ['data', 'aad', 'options', 'nonce', 'key'], keyIndex: 4, keyKind: 'secret' },
  { key: 'crypto_aead_chacha20poly1305_ietf_decrypt', operation: 'aead.chacha20poly1305.decrypt', family: 'symmetric', algorithm: 'ChaCha20-Poly1305-IETF', callableKind: 'decrypt', inputIndex: 1, roles: ['options', 'data', 'aad', 'nonce', 'key'], keyIndex: 4, keyKind: 'secret', failureOnEmpty: true },
  { key: 'crypto_sign_detached', operation: 'ed25519.sign', family: 'signature', algorithm: 'Ed25519', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'private' },
  { key: 'crypto_sign_verify_detached', operation: 'ed25519.verify', family: 'signature', algorithm: 'Ed25519', callableKind: 'verify', inputIndex: 1, roles: ['signature', 'data', 'key'], keyIndex: 2, keyKind: 'public', failureOnEmpty: true },
  { key: 'crypto_hash_sha256', operation: 'sha256.digest', family: 'digest', algorithm: 'SHA-256', callableKind: 'digest', inputIndex: 0, roles: ['data'] },
  { key: 'crypto_hash_sha512', operation: 'sha512.digest', family: 'digest', algorithm: 'SHA-512', callableKind: 'digest', inputIndex: 0, roles: ['data'] },
  { key: 'crypto_auth', operation: 'hmacsha512256.sign', family: 'mac', algorithm: 'HMAC-SHA-512/256', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key'], keyIndex: 1, keyKind: 'secret' },
  { key: 'crypto_auth_verify', operation: 'hmacsha512256.verify', family: 'mac', algorithm: 'HMAC-SHA-512/256', callableKind: 'verify', inputIndex: 1, roles: ['signature', 'data', 'key'], keyIndex: 2, keyKind: 'secret', failureOnEmpty: true },
];

function describe(
  definition: SodiumOperationDefinition,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const nonceIndex = definition.roles.indexOf('nonce');
  const additionalDataIndex = definition.roles.indexOf('aad');
  const summary = [
    nonceIndex >= 0 ? `nonceBytes=${toolkit.byteLength(args[nonceIndex]) || 0}` : undefined,
    additionalDataIndex >= 0 && args[additionalDataIndex] != null
      ? `aadBytes=${toolkit.byteLength(args[additionalDataIndex]) || 0}`
      : undefined,
  ].filter(Boolean).join(' ');
  return {
    crypto: {
      adapterId: libsodiumManifest.id,
      providerKind: libsodiumManifest.providerKind,
      family: definition.family,
      operation: definition.operation,
      algorithm: definition.algorithm,
      inputEncoding: 'auto',
      outputEncoding: 'auto',
      state: { model: 'async-ready', phase: 'one-shot' },
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
      Boolean(definition.callableKind),
      (index === nonceIndex || index === additionalDataIndex) && summary ? summary : undefined,
    )),
    outputError: definition.failureOnEmpty
      ? (value) => value === false || value === null ? `${definition.algorithm} authentication failed` : undefined
      : undefined,
    adaptInput: (value) => toolkit.defaultAdaptInput(value, args[definition.inputIndex]),
  };
}

export const libsodiumAdapter: PageCryptoAdapter = {
  manifest: libsodiumManifest,
  ready(scope) {
    const root = asRecord((scope.window as unknown as { sodium?: unknown }).sodium);
    const ready = root?.ready;
    return ready && typeof (ready as { then?: unknown }).then === 'function'
      ? ready as PromiseLike<unknown>
      : undefined;
  },
  discover(scope): CryptoAdapterOperation[] {
    const root = asRecord((scope.window as unknown as { sodium?: unknown }).sodium);
    if (!root) return [];
    return OPERATIONS.filter((definition) => hasMethod(root, definition.key)).map((definition) => ({
      id: `libsodium.${definition.key}`,
      operation: definition.operation,
      owner: root,
      key: definition.key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => describe(definition, args, toolkit),
      createWrapper: callableProxy,
    }));
  },
};
