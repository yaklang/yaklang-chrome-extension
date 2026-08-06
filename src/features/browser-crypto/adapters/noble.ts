import type { BrowserRecordingCallArgument, BrowserRecordingCrypto } from '@/types/models';
import type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { nobleManifest } from './catalog';
import { asRecord, callableProxy, opaqueKey, uniqueRecords } from './modern-common';

interface FactoryDefinition {
  key: string;
  algorithm: string;
  mode: string;
}

const CIPHER_FACTORIES: FactoryDefinition[] = [
  { key: 'gcm', algorithm: 'AES-GCM', mode: 'gcm' },
  { key: 'gcmsiv', algorithm: 'AES-GCM-SIV', mode: 'gcm-siv' },
  { key: 'cbc', algorithm: 'AES-CBC', mode: 'cbc' },
  { key: 'ctr', algorithm: 'AES-CTR', mode: 'ctr' },
  { key: 'ecb', algorithm: 'AES-ECB', mode: 'ecb' },
  { key: 'cfb', algorithm: 'AES-CFB', mode: 'cfb' },
  { key: 'chacha20poly1305', algorithm: 'ChaCha20-Poly1305', mode: 'aead' },
  { key: 'xchacha20poly1305', algorithm: 'XChaCha20-Poly1305', mode: 'aead' },
];

interface DirectCipherDefinition {
  key: string;
  algorithm: string;
}

const DIRECT_CIPHERS: DirectCipherDefinition[] = [
  { key: 'chacha20', algorithm: 'ChaCha20' },
  { key: 'xchacha20', algorithm: 'XChaCha20' },
  { key: 'salsa20', algorithm: 'Salsa20' },
  { key: 'xsalsa20', algorithm: 'XSalsa20' },
];

const HASHES: Array<{ key: string; algorithm: string }> = [
  { key: 'sha256', algorithm: 'SHA-256' },
  { key: 'sha512', algorithm: 'SHA-512' },
  { key: 'sha3_256', algorithm: 'SHA3-256' },
  { key: 'sha3_512', algorithm: 'SHA3-512' },
  { key: 'blake2b', algorithm: 'BLAKE2b' },
  { key: 'blake2s', algorithm: 'BLAKE2s' },
  { key: 'blake3', algorithm: 'BLAKE3' },
];

function child(owner: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  try { return owner ? asRecord(owner[key]) : undefined; } catch { return undefined; }
}

function isMethod(owner: Record<string, unknown>, key: string): boolean {
  try { return typeof owner[key] === 'function'; } catch { return false; }
}

function cipherInstanceOperations(
  value: unknown,
  definition: FactoryDefinition,
  correlationId: string,
  key: BrowserRecordingCrypto['key'],
): CryptoAdapterOperation[] {
  const owner = asRecord(value);
  if (!owner) return [];
  return (['encrypt', 'decrypt'] as const).flatMap((method) => isMethod(owner, method) ? [{
    id: `noble.${correlationId}.${definition.key}.${method}`,
    operation: `${definition.algorithm}.${method}`,
    owner,
    key: method,
    resultMode: 'sync' as const,
    describe: (_thisArg: unknown, args: unknown[], toolkit: CryptoAdapterToolkit): CryptoAdapterInvocationPlan => ({
      crypto: {
        adapterId: nobleManifest.id,
        providerKind: nobleManifest.providerKind,
        family: 'symmetric',
        operation: `${definition.algorithm}.${method}`,
        algorithm: definition.algorithm,
        mode: definition.mode,
        inputEncoding: 'auto',
        outputEncoding: 'auto',
        state: { model: 'receiver', phase: 'one-shot', correlationId },
        key,
      },
      inputIndex: 0,
      callableKind: method,
      outputEncoding: 'auto',
      arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(
        index, index === 0 ? 'data' : 'options', argument, index === 0, true,
      )),
      adaptInput: (input) => toolkit.defaultAdaptInput(input, args[0]),
    }),
    createWrapper: callableProxy,
  }] : []);
}

function factoryOperation(
  owner: Record<string, unknown>,
  definition: FactoryDefinition,
  ownerIndex: number,
): CryptoAdapterOperation {
  return {
    id: `noble.factory.${ownerIndex}.${definition.key}`,
    operation: `${definition.algorithm}.create`,
    owner,
    key: definition.key,
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => {
      const correlationId = toolkit.unique('noble-cipher');
      const key = opaqueKey(args[0], 'secret', toolkit);
      const nonceBytes = toolkit.byteLength(args[1]);
      const aadBytes = toolkit.byteLength(args[2]);
      return {
        crypto: {
          adapterId: nobleManifest.id,
          providerKind: nobleManifest.providerKind,
          family: 'symmetric',
          operation: `${definition.algorithm}.create`,
          algorithm: definition.algorithm,
          mode: definition.mode,
          inputEncoding: 'auto',
          outputEncoding: 'auto',
          state: { model: 'session', phase: 'create', correlationId },
          key,
        },
        inputIndex: -1,
        arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(
          index,
          index === 0 ? 'key' : index === 1 ? 'nonce' : index === 2 ? 'aad' : 'options',
          argument,
          false,
          false,
          index === 1 && nonceBytes !== undefined
            ? `nonceBytes=${nonceBytes}${aadBytes !== undefined ? ` aadBytes=${aadBytes}` : ''}`
            : undefined,
        )),
        outputEvidence: () => [],
        discoverResult: (result) => cipherInstanceOperations(result, definition, correlationId, key),
      };
    },
    createWrapper: callableProxy,
  };
}

function directCipherOperation(
  owner: Record<string, unknown>,
  definition: DirectCipherDefinition,
  ownerIndex: number,
): CryptoAdapterOperation {
  return {
    id: `noble.stream.${ownerIndex}.${definition.key}`,
    operation: `${definition.algorithm}.transform`,
    owner,
    key: definition.key,
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => ({
      crypto: {
        adapterId: nobleManifest.id,
        providerKind: nobleManifest.providerKind,
        family: 'symmetric',
        operation: `${definition.algorithm}.transform`,
        algorithm: definition.algorithm,
        mode: 'stream',
        inputEncoding: 'auto',
        outputEncoding: 'auto',
        state: { model: 'stateless', phase: 'one-shot' },
        key: opaqueKey(args[0], 'secret', toolkit),
      },
      inputIndex: 2,
      callableKind: 'encrypt',
      outputEncoding: 'auto',
      arguments: args.slice(0, 6).map((argument, index) => toolkit.argument(
        index,
        index === 0 ? 'key' : index === 1 ? 'nonce' : index === 2 ? 'data' : 'options',
        argument,
        index === 2,
        true,
        index === 1 ? `nonceBytes=${toolkit.byteLength(argument) || 0}` : undefined,
      )),
      adaptInput: (input) => toolkit.defaultAdaptInput(input, args[2]),
    }),
    createWrapper: callableProxy,
  };
}

function hashOperation(
  owner: Record<string, unknown>,
  definition: { key: string; algorithm: string },
  ownerIndex: number,
): CryptoAdapterOperation {
  return {
    id: `noble.hash.${ownerIndex}.${definition.key}`,
    operation: `${definition.algorithm}.digest`,
    owner,
    key: definition.key,
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => ({
      crypto: {
        adapterId: nobleManifest.id,
        providerKind: nobleManifest.providerKind,
        family: 'digest',
        operation: `${definition.algorithm}.digest`,
        algorithm: definition.algorithm,
        inputEncoding: 'auto',
        outputEncoding: 'auto',
        state: { model: 'stateless', phase: 'one-shot' },
      },
      inputIndex: 0,
      callableKind: 'digest',
      outputEncoding: 'auto',
      arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(
        index, index === 0 ? 'data' : 'options', argument, index === 0, true,
      )),
      adaptInput: (input) => toolkit.defaultAdaptInput(input, args[0]),
    }),
    createWrapper: callableProxy,
  };
}

function curveOperations(owner: Record<string, unknown>, algorithm: string, ownerIndex: number): CryptoAdapterOperation[] {
  const definitions: Array<{
    key: string;
    operation: string;
    callableKind: CallableOperationKind;
    inputIndex: number;
    roles: BrowserRecordingCallArgument['role'][];
    keyIndex: number;
    keyKind: NonNullable<BrowserRecordingCrypto['key']>['kind'];
    resultMode: 'sync' | 'promise';
  }> = [
    { key: 'sign', operation: 'sign', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key', 'options'], keyIndex: 1, keyKind: 'private', resultMode: 'sync' },
    { key: 'signAsync', operation: 'sign', callableKind: 'sign', inputIndex: 0, roles: ['data', 'key', 'options'], keyIndex: 1, keyKind: 'private', resultMode: 'promise' },
    { key: 'verify', operation: 'verify', callableKind: 'verify', inputIndex: 1, roles: ['signature', 'data', 'key', 'options'], keyIndex: 2, keyKind: 'public', resultMode: 'sync' },
    { key: 'verifyAsync', operation: 'verify', callableKind: 'verify', inputIndex: 1, roles: ['signature', 'data', 'key', 'options'], keyIndex: 2, keyKind: 'public', resultMode: 'promise' },
  ];
  return definitions.flatMap((definition) => isMethod(owner, definition.key) ? [{
    id: `noble.curve.${ownerIndex}.${algorithm}.${definition.key}`,
    operation: `${algorithm}.${definition.operation}`,
    owner,
    key: definition.key,
    resultMode: definition.resultMode,
    describe: (_thisArg: unknown, args: unknown[], toolkit: CryptoAdapterToolkit): CryptoAdapterInvocationPlan => ({
      crypto: {
        adapterId: nobleManifest.id,
        providerKind: nobleManifest.providerKind,
        family: 'signature',
        operation: `${algorithm}.${definition.operation}`,
        algorithm,
        inputEncoding: 'auto',
        outputEncoding: 'auto',
        state: { model: 'stateless', phase: 'one-shot' },
        key: opaqueKey(args[definition.keyIndex], definition.keyKind, toolkit),
      },
      inputIndex: definition.inputIndex,
      callableKind: definition.callableKind,
      outputEncoding: 'auto',
      arguments: args.slice(0, 6).map((argument, index) => toolkit.argument(
        index,
        definition.roles[index] || 'unknown',
        argument,
        index === definition.inputIndex,
        true,
      )),
      outputError: definition.callableKind === 'verify'
        ? (result) => result === false ? `${algorithm} verification failed` : undefined
        : undefined,
      adaptInput: (input) => toolkit.defaultAdaptInput(input, args[definition.inputIndex]),
    }),
    createWrapper: callableProxy,
  }] : []);
}

export const nobleAdapter: PageCryptoAdapter = {
  manifest: nobleManifest,
  discover(scope): CryptoAdapterOperation[] {
    const globals = scope.window as unknown as {
      noble?: unknown;
      nobleCiphers?: unknown;
      nobleHashes?: unknown;
      nobleCurves?: unknown;
    };
    const noble = asRecord(globals.noble);
    const cipherNamespace = asRecord(globals.nobleCiphers) || child(noble, 'ciphers');
    const hashNamespace = asRecord(globals.nobleHashes) || child(noble, 'hashes');
    const curveNamespace = asRecord(globals.nobleCurves) || child(noble, 'curves');
    const cipherOwners = uniqueRecords([
      cipherNamespace,
      child(cipherNamespace, 'aes'),
      child(cipherNamespace, 'chacha'),
      child(cipherNamespace, 'salsa'),
      noble,
      child(noble, 'aes'),
      child(noble, 'chacha'),
    ]);
    const hashOwners = uniqueRecords([
      hashNamespace,
      child(hashNamespace, 'sha2'),
      child(hashNamespace, 'sha3'),
      child(hashNamespace, 'blake'),
      child(noble, 'hash'),
    ]);
    const curveNames = ['ed25519', 'ed448', 'secp256k1', 'p256', 'p384', 'p521'];
    const curveOwners = curveNames.flatMap((name) => {
      const owner = child(curveNamespace, name) || child(noble, name);
      return owner ? [{ owner, name }] : [];
    });
    return [
      ...cipherOwners.flatMap((owner, index) => [
        ...CIPHER_FACTORIES.filter((definition) => isMethod(owner, definition.key))
          .map((definition) => factoryOperation(owner, definition, index)),
        ...DIRECT_CIPHERS.filter((definition) => isMethod(owner, definition.key))
          .map((definition) => directCipherOperation(owner, definition, index)),
      ]),
      ...hashOwners.flatMap((owner, index) => HASHES.filter((definition) => isMethod(owner, definition.key))
        .map((definition) => hashOperation(owner, definition, index))),
      ...curveOwners.flatMap(({ owner, name }, index) => curveOperations(owner, name, index)),
    ];
  },
};
