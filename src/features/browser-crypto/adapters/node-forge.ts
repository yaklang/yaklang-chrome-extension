import type { BrowserRecordingCrypto, BrowserRecordingValueEvidence } from '@/types/models';
import type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { nodeForgeManifest } from './catalog';

type ForgeKeyKind = 'public' | 'private';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function target(root: Record<string, unknown>, path: string): { owner: Record<string, unknown>; key: string } | undefined {
  const segments = path.split('.');
  let owner = root;
  for (const segment of segments.slice(0, -1)) {
    const next = record(owner[segment]);
    if (!next) return undefined;
    owner = next;
  }
  return { owner, key: segments.at(-1)! };
}

function method(owner: Record<string, unknown>, key: string): boolean {
  try { return typeof owner[key] === 'function'; } catch { return false; }
}

function wrapper(invoke: (thisArg: unknown, args: unknown[]) => unknown): Function {
  return function recordedNodeForge(this: unknown, ...args: unknown[]) { return invoke(this, args); };
}

function forgeBufferValue(value: unknown): unknown {
  const input = record(value);
  if (!input) return value;
  try {
    if (typeof input.bytes === 'function') {
      const lengthValue = typeof input.length === 'function' ? Reflect.apply(input.length as Function, value, []) : undefined;
      const length = Number.isFinite(lengthValue) ? Math.max(0, Math.min(Number(lengthValue), 262_144)) : undefined;
      return Reflect.apply(input.bytes as Function, value, length === undefined ? [] : [length]);
    }
  } catch {
    return value;
  }
  return value;
}

function bufferEvidence(value: unknown, path: string, toolkit: CryptoAdapterToolkit): BrowserRecordingValueEvidence[] {
  return toolkit.collectEvidence(forgeBufferValue(value), path);
}

function keyMetadata(value: unknown, kind: NonNullable<BrowserRecordingCrypto['key']>['kind'], toolkit: CryptoAdapterToolkit): BrowserRecordingCrypto['key'] {
  const input = record(value);
  let bits: number | undefined;
  let publicMaterial: string | undefined;
  try {
    const modulus = record(input?.n);
    if (typeof modulus?.bitLength === 'function') {
      const result = Reflect.apply(modulus.bitLength as Function, input?.n, []);
      if (Number.isSafeInteger(result) && result >= 256 && result <= 32_768) bits = Number(result);
    }
    if (typeof modulus?.toString === 'function') {
      publicMaterial = `${Reflect.apply(modulus.toString as Function, input?.n, [16])}:${String(input?.e || '')}`;
    }
  } catch {
    // Compatible forge builds may hide bigint internals.
  }
  if (!publicMaterial) {
    try {
      if (typeof value === 'string') publicMaterial = value;
      else {
        const bytes = toolkit.bytesForInput(forgeBufferValue(value));
        if (bytes) publicMaterial = toolkit.bytesToBase64(bytes);
      }
    } catch {
      publicMaterial = undefined;
    }
  }
  return { kind, bits, fingerprint: publicMaterial ? toolkit.fingerprint(publicMaterial) : undefined };
}

function crypto(
  family: BrowserRecordingCrypto['family'],
  operation: string,
  algorithm: string | undefined,
  model: NonNullable<BrowserRecordingCrypto['state']>['model'],
  phase: NonNullable<BrowserRecordingCrypto['state']>['phase'],
  correlationId: string,
  key?: BrowserRecordingCrypto['key'],
): BrowserRecordingCrypto {
  return {
    adapterId: nodeForgeManifest.id,
    providerKind: nodeForgeManifest.providerKind,
    family,
    operation,
    algorithm,
    inputEncoding: 'auto',
    outputEncoding: 'auto',
    state: { model, phase, correlationId },
    key,
  };
}

function outputBufferOperations(
  buffer: unknown,
  correlationId: string,
  family: BrowserRecordingCrypto['family'],
  algorithm: string | undefined,
  operationPrefix: string,
): CryptoAdapterOperation[] {
  const owner = record(buffer);
  if (!owner) return [];
  return ['getBytes', 'bytes', 'toHex'].filter((key) => method(owner, key)).map((key) => ({
    id: `node-forge.${correlationId}.${operationPrefix}.${key}`,
    operation: `${operationPrefix}.output.${key}`,
    owner,
    key,
    resultMode: 'sync' as const,
    describe: (_thisArg: unknown, args: unknown[], toolkit: CryptoAdapterToolkit): CryptoAdapterInvocationPlan => ({
      crypto: crypto(family, `${operationPrefix}.output.${key}`, algorithm, 'stream', 'final', correlationId),
      inputIndex: -1,
      arguments: args.slice(0, 2).map((value, index) => toolkit.argument(index, 'options', value, false, false)),
      outputEvidence: (value) => toolkit.collectEvidence(value, '$output'),
    }),
    createWrapper: (_original: Function, invoke: (thisArg: unknown, args: unknown[]) => unknown) => wrapper(invoke),
  }));
}

function rsaOperations(
  value: unknown,
  kind: ForgeKeyKind,
  correlationId: string,
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const metadata = keyMetadata(value, kind, toolkit);
  const definitions: Array<{
    key: string;
    operation: string;
    family: BrowserRecordingCrypto['family'];
    callable?: CallableOperationKind;
    roles: Array<'data' | 'signature' | 'options'>;
  }> = kind === 'public' ? [
    { key: 'encrypt', operation: 'rsa.encrypt', family: 'asymmetric', callable: 'encrypt', roles: ['data', 'options', 'options'] },
    { key: 'verify', operation: 'rsa.verify', family: 'signature', roles: ['data', 'signature', 'options'] },
  ] : [
    { key: 'decrypt', operation: 'rsa.decrypt', family: 'asymmetric', callable: 'decrypt', roles: ['data', 'options', 'options'] },
    { key: 'sign', operation: 'rsa.sign', family: 'signature', roles: ['data', 'options'] },
  ];
  return definitions.filter((definition) => method(owner, definition.key)).map((definition) => ({
    id: `node-forge.${correlationId}.${definition.operation}`,
    operation: definition.operation,
    owner,
    key: definition.key,
    resultMode: 'sync' as const,
    describe: (_thisArg: unknown, args: unknown[], adapterToolkit: CryptoAdapterToolkit): CryptoAdapterInvocationPlan => ({
      crypto: crypto(definition.family, definition.operation, 'RSA', 'receiver', 'one-shot', correlationId, metadata),
      inputIndex: 0,
      callableKind: definition.callable,
      arguments: args.slice(0, 8).map((argument, index) => adapterToolkit.argument(
        index, definition.roles[index] || 'unknown', argument, index === 0, Boolean(definition.callable),
      )),
      outputError: (result) => result === false || result === null ? 'node-forge RSA returned no result' : undefined,
      adaptInput: (input) => adapterToolkit.defaultAdaptInput(input, args[0]),
    }),
    createWrapper: (_original: Function, invoke: (thisArg: unknown, args: unknown[]) => unknown) => wrapper(invoke),
  }));
}

function cipherSessionOperations(
  value: unknown,
  direction: 'encrypt' | 'decrypt',
  algorithm: string | undefined,
  correlationId: string,
): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const family: BrowserRecordingCrypto['family'] = 'symmetric';
  const output: CryptoAdapterOperation[] = [];
  const definitions = [
    { key: 'start', phase: 'init' as const, inputIndex: -1, role: 'options' as const },
    { key: 'update', phase: 'update' as const, inputIndex: 0, role: 'data' as const },
    { key: 'finish', phase: 'final' as const, inputIndex: -1, role: 'options' as const },
  ];
  for (const definition of definitions) {
    if (!method(owner, definition.key)) continue;
    const operation = `cipher.${direction}.${definition.key}`;
    output.push({
      id: `node-forge.${correlationId}.${operation}`,
      operation,
      owner,
      key: definition.key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => ({
        crypto: crypto(family, operation, algorithm, 'stream', definition.phase, correlationId),
        inputIndex: definition.inputIndex,
        arguments: args.slice(0, 8).map((argument, index) => toolkit.argument(
          index, index === 0 ? definition.role : 'options', argument, false, false,
        )),
        outputEvidence: definition.key === 'finish'
          ? () => bufferEvidence(owner.output, '$receiver.output', toolkit)
          : () => [],
        inputEvidence: definition.key === 'update'
          ? (input) => bufferEvidence(input, '$input', toolkit)
          : undefined,
        discoverResult: definition.key === 'start'
          ? () => outputBufferOperations(owner.output, correlationId, family, algorithm, `cipher.${direction}`)
          : undefined,
        outputError: definition.key === 'finish'
          ? (result) => result === false ? 'node-forge cipher authentication or padding failed' : undefined
          : undefined,
      }),
      createWrapper: (_original, invoke) => wrapper(invoke),
    });
  }
  output.push(...outputBufferOperations(owner.output, correlationId, family, algorithm, `cipher.${direction}`));
  return output;
}

function digestSessionOperations(
  value: unknown,
  algorithm: string,
  correlationId: string,
): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const output: CryptoAdapterOperation[] = [];
  for (const definition of [
    { key: 'start', phase: 'init' as const, inputIndex: -1 },
    { key: 'update', phase: 'update' as const, inputIndex: 0 },
    { key: 'digest', phase: 'final' as const, inputIndex: -1 },
  ]) {
    if (!method(owner, definition.key)) continue;
    const operation = `digest.${definition.key}`;
    output.push({
      id: `node-forge.${correlationId}.${operation}`,
      operation,
      owner,
      key: definition.key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => ({
        crypto: crypto('digest', operation, algorithm, 'session', definition.phase, correlationId),
        inputIndex: definition.inputIndex,
        arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(index, index === 0 ? 'data' : 'options', argument, false, false)),
        outputEvidence: definition.key === 'digest'
          ? (result) => bufferEvidence(result, '$output', toolkit)
          : () => [],
        inputEvidence: definition.key === 'update'
          ? (input) => bufferEvidence(input, '$input', toolkit)
          : undefined,
        discoverResult: definition.key === 'digest'
          ? (result) => outputBufferOperations(result, correlationId, 'digest', algorithm, 'digest')
          : undefined,
      }),
      createWrapper: (_original, invoke) => wrapper(invoke),
    });
  }
  return output;
}

function hmacSessionOperations(value: unknown, correlationId: string): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const context: { algorithm?: string; key?: BrowserRecordingCrypto['key'] } = {};
  const output: CryptoAdapterOperation[] = [];
  for (const definition of [
    { key: 'start', phase: 'init' as const, inputIndex: -1 },
    { key: 'update', phase: 'update' as const, inputIndex: 0 },
    { key: 'digest', phase: 'final' as const, inputIndex: -1 },
  ]) {
    if (!method(owner, definition.key)) continue;
    const operation = `hmac.${definition.key}`;
    output.push({
      id: `node-forge.${correlationId}.${operation}`,
      operation,
      owner,
      key: definition.key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => {
        if (definition.key === 'start') {
          context.algorithm = typeof args[0] === 'string' ? args[0].slice(0, 80) : 'HMAC';
          context.key = keyMetadata(args[1], 'secret', toolkit);
        }
        return {
          crypto: crypto('mac', operation, context.algorithm || 'HMAC', 'session', definition.phase, correlationId, context.key),
          inputIndex: definition.inputIndex,
          arguments: args.slice(0, 4).map((argument, index) => toolkit.argument(
            index, definition.key === 'start' && index === 1 ? 'key' : index === 0 ? 'data' : 'options', argument, false, false,
          )),
          outputEvidence: definition.key === 'digest'
            ? (result) => bufferEvidence(result, '$output', toolkit)
            : () => [],
          inputEvidence: definition.key === 'update'
            ? (input) => bufferEvidence(input, '$input', toolkit)
            : undefined,
          discoverResult: definition.key === 'digest'
            ? (result) => outputBufferOperations(result, correlationId, 'mac', context.algorithm || 'HMAC', 'hmac')
            : undefined,
        };
      },
      createWrapper: (_original, invoke) => wrapper(invoke),
    });
  }
  return output;
}

function factoryOperation(
  root: Record<string, unknown>,
  path: string,
  operation: string,
  family: BrowserRecordingCrypto['family'],
  algorithm: (args: unknown[]) => string | undefined,
  discover: (value: unknown, args: unknown[], correlationId: string, toolkit: CryptoAdapterToolkit) => CryptoAdapterOperation[],
  roles: Array<'algorithm' | 'key' | 'options' | 'unknown'>,
): CryptoAdapterOperation | undefined {
  const resolved = target(root, path);
  if (!resolved) return undefined;
  return {
    id: `node-forge.${operation}`,
    operation,
    owner: resolved.owner,
    key: resolved.key,
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => {
      const correlationId = toolkit.unique('forge-session');
      const algorithmName = algorithm(args);
      const keyIndex = roles.indexOf('key');
      const factoryKey = family === 'symmetric' && keyIndex >= 0
        ? keyMetadata(args[keyIndex], 'secret', toolkit)
        : undefined;
      return {
        crypto: crypto(family, operation, algorithmName, 'session', 'create', correlationId, factoryKey),
        inputIndex: -1,
        arguments: args.slice(0, 8).map((argument, index) => toolkit.argument(
          index, roles[index] || 'unknown', argument, false, false,
          roles[index] === 'algorithm' && typeof argument === 'string' ? argument.slice(0, 120) : undefined,
        )),
        outputEvidence: () => [],
        discoverResult: (value) => discover(value, args, correlationId, toolkit),
      };
    },
    createWrapper: (_original, invoke) => wrapper(invoke),
  };
}

export const nodeForgeAdapter: PageCryptoAdapter = {
  manifest: nodeForgeManifest,
  discover(scope): CryptoAdapterOperation[] {
    const forge = (scope.window as unknown as { forge?: Record<string, unknown> }).forge;
    if (!forge) return [];
    const operations: Array<CryptoAdapterOperation | undefined> = [
      factoryOperation(forge, 'cipher.createCipher', 'cipher.create.encrypt', 'symmetric',
        (args) => typeof args[0] === 'string' ? args[0].slice(0, 120) : undefined,
        (value, args, correlationId) => cipherSessionOperations(value, 'encrypt', typeof args[0] === 'string' ? args[0].slice(0, 120) : undefined, correlationId),
        ['algorithm', 'key']),
      factoryOperation(forge, 'cipher.createDecipher', 'cipher.create.decrypt', 'symmetric',
        (args) => typeof args[0] === 'string' ? args[0].slice(0, 120) : undefined,
        (value, args, correlationId) => cipherSessionOperations(value, 'decrypt', typeof args[0] === 'string' ? args[0].slice(0, 120) : undefined, correlationId),
        ['algorithm', 'key']),
      factoryOperation(forge, 'hmac.create', 'hmac.create', 'mac', () => 'HMAC',
        (value, _args, correlationId) => hmacSessionOperations(value, correlationId), []),
      factoryOperation(forge, 'pki.publicKeyFromPem', 'pki.public-key.create', 'key-management', () => 'RSA',
        (value, _args, correlationId, toolkit) => rsaOperations(value, 'public', correlationId, toolkit), ['key']),
      factoryOperation(forge, 'pki.privateKeyFromPem', 'pki.private-key.create', 'key-management', () => 'RSA',
        (value, _args, correlationId, toolkit) => rsaOperations(value, 'private', correlationId, toolkit), ['key']),
    ];
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) {
      operations.push(factoryOperation(
        forge,
        `md.${algorithm}.create`,
        `digest.${algorithm}.create`,
        'digest',
        () => algorithm.toUpperCase(),
        (value, _args, correlationId) => digestSessionOperations(value, algorithm.toUpperCase(), correlationId),
        [],
      ));
    }
    return operations.filter((operation): operation is CryptoAdapterOperation => Boolean(operation));
  },
};
