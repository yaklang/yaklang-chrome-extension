import type { BrowserRecordingCrypto, BrowserRecordingValueEvidence } from '@/types/models';
import type {
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { openPgpManifest } from './catalog';
import { asRecord, callableProxy, hasMethod } from './modern-common';

interface MessageEvidence {
  correlationId: string;
  evidence: BrowserRecordingValueEvidence[];
  sourceKind: 'text' | 'binary' | 'stream' | 'unknown';
}

interface HighLevelDefinition {
  key: 'encrypt' | 'decrypt' | 'sign' | 'verify';
  family: BrowserRecordingCrypto['family'];
  keyKind: NonNullable<BrowserRecordingCrypto['key']>['kind'];
}

const HIGH_LEVEL_OPERATIONS: HighLevelDefinition[] = [
  { key: 'encrypt', family: 'asymmetric', keyKind: 'public' },
  { key: 'decrypt', family: 'asymmetric', keyKind: 'private' },
  { key: 'sign', family: 'signature', keyKind: 'private' },
  { key: 'verify', family: 'signature', keyKind: 'public' },
];

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function streamLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  try { return typeof (value as { getReader?: unknown }).getReader === 'function'; } catch { return false; }
}

function sourceFromOptions(value: unknown): { value?: unknown; path: string; kind: MessageEvidence['sourceKind'] } {
  for (const [key, kind] of [
    ['text', 'text'],
    ['binary', 'binary'],
    ['armoredMessage', 'text'],
    ['binaryMessage', 'binary'],
    ['cleartextMessage', 'text'],
  ] as const) {
    const source = ownValue(value, key);
    if (source !== undefined) return {
      value: source,
      path: `$input.${key}`,
      kind: streamLike(source) ? 'stream' : kind,
    };
  }
  return { path: '$input', kind: 'unknown' };
}

function messageOperation(
  root: Record<string, unknown>,
  key: 'createMessage' | 'createCleartextMessage' | 'readMessage' | 'readCleartextMessage',
  messages: WeakMap<object, MessageEvidence>,
): CryptoAdapterOperation | undefined {
  if (!hasMethod(root, key)) return undefined;
  return {
    id: `openpgp.${key}`,
    operation: key,
    owner: root,
    key,
    resultMode: 'promise',
    describe: (_thisArg, args, toolkit) => {
      const source = sourceFromOptions(args[0]);
      const correlationId = toolkit.unique('openpgp-message');
      const evidence = source.value === undefined
        ? []
        : toolkit.collectEvidence(source.value, source.path).slice(0, 48);
      return {
        crypto: {
          adapterId: openPgpManifest.id,
          providerKind: openPgpManifest.providerKind,
          family: 'unknown',
          operation: key,
          algorithm: 'OpenPGP',
          inputEncoding: source.kind === 'text' ? 'utf8' : 'auto',
          outputEncoding: 'auto',
          state: {
            model: source.kind === 'stream' ? 'stream' : 'async-ready',
            phase: 'create',
            correlationId,
          },
        },
        inputIndex: 0,
        arguments: args.slice(0, 3).map((argument, index) => toolkit.argument(
          index, index === 0 ? 'data' : 'options', argument, false, false,
          index === 0 ? `source=${source.kind}` : undefined,
        )),
        inputEvidence: () => evidence,
        outputEvidence: () => [],
        discoverResult: (result) => {
          if (result && typeof result === 'object') messages.set(result, { correlationId, evidence, sourceKind: source.kind });
          return [];
        },
      };
    },
    createWrapper: callableProxy,
  };
}

function keyCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return value == null ? 0 : 1;
}

function highLevelOperation(
  root: Record<string, unknown>,
  definition: HighLevelDefinition,
  messages: WeakMap<object, MessageEvidence>,
): CryptoAdapterOperation | undefined {
  if (!hasMethod(root, definition.key)) return undefined;
  return {
    id: `openpgp.${definition.key}`,
    operation: `OpenPGP.${definition.key}`,
    owner: root,
    key: definition.key,
    resultMode: 'promise',
    describe: (_thisArg, args, toolkit): CryptoAdapterInvocationPlan => {
      const options = args[0];
      const message = ownValue(options, 'message');
      const metadata = message && typeof message === 'object' ? messages.get(message) : undefined;
      const format = ownValue(options, 'format');
      const encryptionKeys = ownValue(options, 'encryptionKeys');
      const decryptionKeys = ownValue(options, 'decryptionKeys');
      const signingKeys = ownValue(options, 'signingKeys');
      const verificationKeys = ownValue(options, 'verificationKeys');
      const passwords = ownValue(options, 'passwords');
      const hasPasswords = keyCount(passwords) > 0;
      const keyValue = definition.key === 'encrypt' ? encryptionKeys
        : definition.key === 'decrypt' ? decryptionKeys
          : definition.key === 'sign' ? signingKeys : verificationKeys;
      const family = hasPasswords && (definition.key === 'encrypt' || definition.key === 'decrypt')
        ? 'symmetric'
        : definition.family;
      const summary = [
        typeof format === 'string' ? `format=${format.slice(0, 32)}` : undefined,
        keyCount(keyValue) ? `keys=${keyCount(keyValue)}` : undefined,
        hasPasswords ? `passwords=${keyCount(passwords)}` : undefined,
        metadata ? `source=${metadata.sourceKind}` : undefined,
      ].filter(Boolean).join(' ');
      return {
        crypto: {
          adapterId: openPgpManifest.id,
          providerKind: openPgpManifest.providerKind,
          family,
          operation: `OpenPGP.${definition.key}`,
          algorithm: hasPasswords ? 'OpenPGP password-based' : 'OpenPGP public-key',
          inputEncoding: metadata?.sourceKind === 'text' ? 'utf8' : 'auto',
          outputEncoding: format === 'binary' ? 'auto' : 'utf8',
          state: {
            model: metadata?.sourceKind === 'stream' ? 'stream' : 'async-ready',
            phase: 'final',
            correlationId: metadata?.correlationId,
          },
          key: keyCount(keyValue) || hasPasswords
            ? { kind: hasPasswords ? 'secret' : definition.keyKind }
            : undefined,
        },
        // OpenPGP's public API accepts a composite options object. Replacing that
        // object would discard message/key/stream state, so replay is promoted to
        // the enclosing business closure instead of exposing an unsafe primitive.
        inputIndex: 0,
        arguments: args.slice(0, 3).map((argument, index) => toolkit.argument(
          index, index === 0 ? 'data' : 'options', argument, false, false, index === 0 ? summary : undefined,
        )),
        inputEvidence: () => metadata?.evidence || [],
        outputEvidence: definition.key === 'decrypt'
          ? (result) => {
            const data = ownValue(result, 'data');
            return data === undefined ? toolkit.defaultOutputEvidence(result) : toolkit.collectEvidence(data, '$output.data');
          }
          : undefined,
        outputError: (result) => result === false || result === null ? `OpenPGP.${definition.key} returned no result` : undefined,
      };
    },
    createWrapper: callableProxy,
  };
}

export const openPgpAdapter: PageCryptoAdapter = {
  manifest: openPgpManifest,
  discover(scope): CryptoAdapterOperation[] {
    const root = asRecord((scope.window as unknown as { openpgp?: unknown }).openpgp);
    if (!root) return [];
    const messages = new WeakMap<object, MessageEvidence>();
    return [
      messageOperation(root, 'createMessage', messages),
      messageOperation(root, 'createCleartextMessage', messages),
      messageOperation(root, 'readMessage', messages),
      messageOperation(root, 'readCleartextMessage', messages),
      ...HIGH_LEVEL_OPERATIONS.map((definition) => highLevelOperation(root, definition, messages)),
    ].filter((operation): operation is CryptoAdapterOperation => Boolean(operation));
  },
};
