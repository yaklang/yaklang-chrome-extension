import type { BrowserRecordingCrypto } from '@/types/models';
import type {
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { joseManifest } from './catalog';

type JoseFamily = 'signature' | 'asymmetric';

interface JoseBuilderDefinition {
  key: 'SignJWT' | 'CompactSign' | 'CompactEncrypt';
  family: JoseFamily;
  finalMethod: 'sign' | 'encrypt';
  setters: string[];
}

const BUILDERS: JoseBuilderDefinition[] = [
  {
    key: 'SignJWT', family: 'signature', finalMethod: 'sign',
    setters: ['setProtectedHeader', 'setIssuer', 'setSubject', 'setAudience', 'setJti', 'setNotBefore', 'setExpirationTime', 'setIssuedAt'],
  },
  {
    key: 'CompactSign', family: 'signature', finalMethod: 'sign',
    setters: ['setProtectedHeader'],
  },
  {
    key: 'CompactEncrypt', family: 'asymmetric', finalMethod: 'encrypt',
    setters: ['setProtectedHeader', 'setKeyManagementParameters', 'setContentEncryptionKey', 'setInitializationVector'],
  },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function method(owner: Record<string, unknown> | undefined, key: string): boolean {
  try { return Boolean(owner && typeof owner[key] === 'function'); } catch { return false; }
}

function callWrapper(invoke: (thisArg: unknown, args: unknown[]) => unknown): Function {
  return function recordedJose(this: unknown, ...args: unknown[]) { return invoke(this, args); };
}

function constructorWrapper(
  original: Function,
  invoke: (thisArg: unknown, args: unknown[]) => unknown,
): Function {
  return new Proxy(original, {
    apply(_target, thisArg, args) { return invoke(thisArg, args); },
    construct(_target, args) { return invoke(undefined, args) as object; },
  });
}

function keyMetadata(
  value: unknown,
  toolkit: CryptoAdapterToolkit,
  preferredKind: NonNullable<BrowserRecordingCrypto['key']>['kind'],
): BrowserRecordingCrypto['key'] {
  const key = record(value);
  if (!key) return { kind: preferredKind };
  let kind = preferredKind;
  let bits: number | undefined;
  const parts: string[] = [];
  try {
    if (key.type === 'private' || key.type === 'public' || key.type === 'secret') kind = key.type;
    const algorithm = record(key.algorithm);
    if (typeof algorithm?.name === 'string') parts.push(`name=${algorithm.name}`);
    if (typeof algorithm?.namedCurve === 'string') parts.push(`crv=${algorithm.namedCurve}`);
    if (Number.isSafeInteger(algorithm?.length)) bits = Number(algorithm?.length);
    for (const field of ['kty', 'crv', 'x', 'y', 'n', 'e', 'kid', 'use', 'alg']) {
      const item = key[field];
      if (typeof item === 'string' || typeof item === 'number') parts.push(`${field}=${String(item)}`);
    }
  } catch { /* CryptoKey and proxy metadata are best effort. */ }
  return { kind, bits, fingerprint: parts.length ? toolkit.fingerprint(parts.join('&')) : undefined };
}

function algorithmFromHeader(value: unknown): string | undefined {
  const header = record(value);
  if (!header) return undefined;
  const parts: string[] = [];
  try {
    if (typeof header.alg === 'string') parts.push(header.alg);
    if (typeof header.enc === 'string') parts.push(`enc=${header.enc}`);
    if (typeof header.zip === 'string') parts.push(`zip=${header.zip}`);
  } catch { return undefined; }
  return parts.length ? parts.join(' ').slice(0, 240) : undefined;
}

function crypto(
  definition: JoseBuilderDefinition,
  operation: string,
  phase: NonNullable<BrowserRecordingCrypto['state']>['phase'],
  correlationId: string,
  algorithm?: string,
  key?: BrowserRecordingCrypto['key'],
): BrowserRecordingCrypto {
  return {
    adapterId: joseManifest.id,
    providerKind: joseManifest.providerKind,
    family: definition.family,
    operation,
    algorithm,
    inputEncoding: 'auto',
    outputEncoding: 'auto',
    state: { model: 'async-ready', phase, correlationId },
    key,
  };
}

function builderOperations(
  value: unknown,
  definition: JoseBuilderDefinition,
  correlationId: string,
): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const context: { algorithm?: string; key?: BrowserRecordingCrypto['key'] } = {};
  const output: CryptoAdapterOperation[] = [];
  for (const setter of definition.setters) {
    if (!method(owner, setter)) continue;
    output.push({
      id: `jose.${correlationId}.${definition.key}.${setter}`,
      operation: `${definition.key}.${setter}`,
      owner,
      key: setter,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => {
        if (setter === 'setProtectedHeader') context.algorithm = algorithmFromHeader(args[0]) || context.algorithm;
        return {
          crypto: crypto(definition, `${definition.key}.${setter}`, 'update', correlationId, context.algorithm, context.key),
          inputIndex: -1,
          arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(index, index === 0 ? 'options' : 'unknown', argument, false, false)),
          outputEvidence: () => [],
        };
      },
      createWrapper: (_original, invoke) => callWrapper(invoke),
    });
  }
  if (method(owner, definition.finalMethod)) output.push({
    id: `jose.${correlationId}.${definition.key}.${definition.finalMethod}`,
    operation: `${definition.key}.${definition.finalMethod}`,
    owner,
    key: definition.finalMethod,
    resultMode: 'promise',
    describe: (_thisArg, args, toolkit) => {
      context.key = keyMetadata(args[0], toolkit, definition.finalMethod === 'sign' ? 'private' : 'unknown');
      return {
        crypto: crypto(definition, `${definition.key}.${definition.finalMethod}`, 'final', correlationId, context.algorithm, context.key),
        inputIndex: -1,
        arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(index, index === 0 ? 'key' : 'options', argument, false, false)),
        outputError: (result) => result === false || result === null ? `${definition.key}.${definition.finalMethod} returned no result` : undefined,
      };
    },
    createWrapper: (_original, invoke) => callWrapper(invoke),
  });
  return output;
}

function builderConstructor(
  root: Record<string, unknown>,
  definition: JoseBuilderDefinition,
): CryptoAdapterOperation | undefined {
  if (!method(root, definition.key)) return undefined;
  return {
    id: `jose.${definition.key}.constructor`,
    operation: `${definition.key}.create`,
    owner: root,
    key: definition.key,
    invocationMode: 'construct',
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => {
      const correlationId = toolkit.unique('jose-session');
      return {
        crypto: crypto(definition, `${definition.key}.create`, 'create', correlationId),
        inputIndex: 0,
        arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(index, index === 0 ? 'data' : 'options', argument, false, false)),
        outputEvidence: () => [],
        discoverResult: (value) => builderOperations(value, definition, correlationId),
      };
    },
    createWrapper: constructorWrapper,
  };
}

interface AsyncOperationDefinition {
  key: string;
  operation: string;
  family: BrowserRecordingCrypto['family'];
  roles: Array<'data' | 'key' | 'options'>;
  keyKind: NonNullable<BrowserRecordingCrypto['key']>['kind'];
}

const ASYNC_OPERATIONS: AsyncOperationDefinition[] = [
  { key: 'compactVerify', operation: 'CompactVerify.verify', family: 'signature', roles: ['data', 'key', 'options'], keyKind: 'public' },
  { key: 'jwtVerify', operation: 'JWT.verify', family: 'signature', roles: ['data', 'key', 'options'], keyKind: 'public' },
  { key: 'compactDecrypt', operation: 'CompactDecrypt.decrypt', family: 'asymmetric', roles: ['data', 'key', 'options'], keyKind: 'private' },
  { key: 'jwtDecrypt', operation: 'JWT.decrypt', family: 'asymmetric', roles: ['data', 'key', 'options'], keyKind: 'private' },
  { key: 'importJWK', operation: 'JWK.import', family: 'key-management', roles: ['key', 'options', 'options'], keyKind: 'unknown' },
  { key: 'exportJWK', operation: 'JWK.export', family: 'key-management', roles: ['key'], keyKind: 'unknown' },
];

function asyncOperation(root: Record<string, unknown>, definition: AsyncOperationDefinition): CryptoAdapterOperation | undefined {
  if (!method(root, definition.key)) return undefined;
  return {
    id: `jose.${definition.key}`,
    operation: definition.operation,
    owner: root,
    key: definition.key,
    resultMode: 'promise',
    describe: (_thisArg, args, toolkit) => {
      const keyIndex = definition.roles.indexOf('key');
      return {
        crypto: {
          adapterId: joseManifest.id,
          providerKind: joseManifest.providerKind,
          family: definition.family,
          operation: definition.operation,
          inputEncoding: 'auto',
          outputEncoding: 'auto',
          state: { model: 'async-ready', phase: 'one-shot' },
          key: keyIndex >= 0 ? keyMetadata(args[keyIndex], toolkit, definition.keyKind) : undefined,
        },
        inputIndex: -1,
        arguments: args.slice(0, 6).map((argument, index) => toolkit.argument(index, definition.roles[index] || 'unknown', argument, false, false)),
        outputEvidence: definition.family === 'key-management' ? () => [] : undefined,
        outputError: (result) => result === false || result === null ? `${definition.operation} returned no result` : undefined,
      };
    },
    createWrapper: (_original, invoke) => callWrapper(invoke),
  };
}

export const joseAdapter: PageCryptoAdapter = {
  manifest: joseManifest,
  discover(scope): CryptoAdapterOperation[] {
    const root = record((scope.window as unknown as { jose?: unknown }).jose);
    if (!root) return [];
    return [
      ...BUILDERS.map((definition) => builderConstructor(root, definition)),
      ...ASYNC_OPERATIONS.map((definition) => asyncOperation(root, definition)),
    ].filter((operation): operation is CryptoAdapterOperation => Boolean(operation));
  },
};
