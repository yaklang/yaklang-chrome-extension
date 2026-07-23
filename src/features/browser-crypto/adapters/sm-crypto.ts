import type { BrowserRecordingCrypto } from '@/types/models';
import type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { smCryptoManifest } from './catalog';

interface SMOperationDefinition {
  path: string;
  operation: string;
  family: BrowserRecordingCrypto['family'];
  algorithm: string;
  callableKind?: CallableOperationKind;
  roles: Array<'data' | 'key' | 'signature' | 'options' | 'unknown'>;
  keyKind?: NonNullable<BrowserRecordingCrypto['key']>['kind'];
  keyBits?: number;
  outputEncoding?: BrowserRecordingCrypto['outputEncoding'];
}

const OPERATIONS: SMOperationDefinition[] = [
  { path: 'sm2.doEncrypt', operation: 'sm2.encrypt', family: 'asymmetric', algorithm: 'SM2', callableKind: 'encrypt', roles: ['data', 'key', 'options'], keyKind: 'public', keyBits: 256, outputEncoding: 'hex' },
  { path: 'sm2.doDecrypt', operation: 'sm2.decrypt', family: 'asymmetric', algorithm: 'SM2', callableKind: 'decrypt', roles: ['data', 'key', 'options', 'options'], keyKind: 'private', keyBits: 256, outputEncoding: 'utf8' },
  { path: 'sm2.doSignature', operation: 'sm2.sign', family: 'signature', algorithm: 'SM2', callableKind: 'sign', roles: ['data', 'key', 'options'], keyKind: 'private', keyBits: 256, outputEncoding: 'hex' },
  { path: 'sm2.doVerifySignature', operation: 'sm2.verify', family: 'signature', algorithm: 'SM2', callableKind: 'verify', roles: ['data', 'signature', 'key', 'options'], keyKind: 'public', keyBits: 256, outputEncoding: 'auto' },
  { path: 'sm3', operation: 'sm3.digest', family: 'digest', algorithm: 'SM3', callableKind: 'digest', roles: ['data', 'options'], outputEncoding: 'hex' },
  { path: 'sm4.encrypt', operation: 'sm4.encrypt', family: 'symmetric', algorithm: 'SM4', callableKind: 'encrypt', roles: ['data', 'key', 'options'], keyKind: 'secret', keyBits: 128, outputEncoding: 'hex' },
  { path: 'sm4.decrypt', operation: 'sm4.decrypt', family: 'symmetric', algorithm: 'SM4', callableKind: 'decrypt', roles: ['data', 'key', 'options'], keyKind: 'secret', keyBits: 128, outputEncoding: 'utf8' },
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

function optionSummary(definition: SMOperationDefinition, args: unknown[], toolkit: CryptoAdapterToolkit): {
  mode?: string;
  padding?: string;
  summary?: string;
  inputEncoding?: BrowserRecordingCrypto['inputEncoding'];
  outputEncoding?: BrowserRecordingCrypto['outputEncoding'];
} {
  const optionValues = definition.roles
    .map((role, index) => role === 'options' ? args[index] : undefined)
    .filter((value) => value !== undefined);
  const parts: string[] = [];
  let mode: string | undefined;
  let padding: string | undefined;
  let inputEncoding: BrowserRecordingCrypto['inputEncoding'];
  let outputEncoding = definition.outputEncoding;
  for (const options of optionValues) {
    if (definition.algorithm === 'SM2' && typeof options === 'number') {
      mode = options === 0 ? 'C1C2C3' : options === 1 ? 'C1C3C2' : `cipherMode=${options}`;
      parts.push(mode);
      continue;
    }
    if (!options || typeof options !== 'object') continue;
    const rawMode = ownValue(options, 'mode');
    const rawPadding = ownValue(options, 'padding');
    const rawInput = ownValue(options, 'input');
    const rawOutput = ownValue(options, 'output');
    const iv = ownValue(options, 'iv');
    if (typeof rawMode === 'string') { mode = rawMode.slice(0, 40); parts.push(`mode=${mode}`); }
    if (typeof rawPadding === 'string') { padding = rawPadding.slice(0, 40); parts.push(`padding=${padding}`); }
    if (iv !== undefined) parts.push(`ivBytes=${toolkit.byteLength(iv) || 0}`);
    if (rawInput === 'utf8' || rawInput === 'hex' || rawInput === 'base64' || rawInput === 'auto') inputEncoding = rawInput;
    if (rawOutput === 'utf8' || rawOutput === 'hex' || rawOutput === 'base64' || rawOutput === 'auto') outputEncoding = rawOutput;
  }
  return { mode, padding, inputEncoding, outputEncoding, summary: parts.length ? parts.join(' ').slice(0, 240) : undefined };
}

function keyMetadata(
  definition: SMOperationDefinition,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): BrowserRecordingCrypto['key'] | undefined {
  const keyIndex = definition.roles.indexOf('key');
  if (keyIndex < 0) return undefined;
  const value = args[keyIndex];
  let material: string | undefined;
  try {
    if (typeof value === 'string') material = value;
    else {
      const bytes = toolkit.bytesForInput(value);
      if (bytes) material = toolkit.bytesToBase64(bytes);
    }
  } catch {
    material = undefined;
  }
  return {
    kind: definition.keyKind || 'unknown',
    bits: definition.keyBits,
    fingerprint: material ? toolkit.fingerprint(material) : undefined,
  };
}

function operationOwner(root: Record<string, unknown>, path: string): { owner: Record<string, unknown>; key: string } | undefined {
  const segments = path.split('.');
  let owner = root;
  for (const segment of segments.slice(0, -1)) {
    const next = owner[segment];
    if (!next || (typeof next !== 'object' && typeof next !== 'function')) return undefined;
    owner = next as Record<string, unknown>;
  }
  return { owner, key: segments.at(-1)! };
}

function describe(
  definition: SMOperationDefinition,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const options = optionSummary(definition, args, toolkit);
  const sm3Key = definition.operation === 'sm3.digest' ? ownValue(args[1], 'key') : undefined;
  const actualFamily = sm3Key === undefined ? definition.family : 'mac';
  const actualOperation = sm3Key === undefined ? definition.operation : 'sm3.hmac';
  const actualCallableKind = sm3Key === undefined ? definition.callableKind : 'sign';
  let sm3KeyMaterial: string | undefined;
  if (typeof sm3Key === 'string') sm3KeyMaterial = sm3Key;
  else if (sm3Key !== undefined) {
    try {
      const bytes = toolkit.bytesForInput(sm3Key);
      if (bytes) sm3KeyMaterial = toolkit.bytesToBase64(bytes);
    } catch { /* HMAC key metadata is optional. */ }
  }
  return {
    crypto: {
      adapterId: smCryptoManifest.id,
      providerKind: smCryptoManifest.providerKind,
      family: actualFamily,
      operation: actualOperation,
      algorithm: definition.algorithm,
      mode: options.mode,
      padding: options.padding,
      inputEncoding: options.inputEncoding || 'auto',
      outputEncoding: options.outputEncoding,
      state: { model: 'stateless', phase: 'one-shot' },
      key: sm3Key === undefined ? keyMetadata(definition, args, toolkit) : {
        kind: 'secret',
        fingerprint: sm3KeyMaterial ? toolkit.fingerprint(sm3KeyMaterial) : undefined,
      },
    },
    inputIndex: 0,
    callableKind: actualCallableKind,
    outputEncoding: options.outputEncoding,
    arguments: args.slice(0, 8).map((value, index) => toolkit.argument(
      index,
      definition.roles[index] || 'unknown',
      value,
      index === 0,
      Boolean(actualCallableKind),
      definition.roles[index] === 'options' ? options.summary : undefined,
    )),
    outputError: (value) => value === false || value === null ? `${definition.algorithm} returned no result` : undefined,
    adaptInput: (value) => toolkit.defaultAdaptInput(value, args[0]),
  };
}

export const smCryptoAdapter: PageCryptoAdapter = {
  manifest: smCryptoManifest,
  discover(scope): CryptoAdapterOperation[] {
    const globals = scope.window as unknown as {
      smCrypto?: Record<string, unknown>;
      sm2?: Record<string, unknown>;
      sm3?: Function;
      sm4?: Record<string, unknown>;
    };
    const root = globals.smCrypto || {
      sm2: globals.sm2,
      sm3: globals.sm3,
      sm4: globals.sm4,
    };
    if (!root.sm2 && !root.sm3 && !root.sm4) return [];
    const output: CryptoAdapterOperation[] = [];
    for (const definition of OPERATIONS) {
      const resolved = !globals.smCrypto && definition.path === 'sm3'
        ? { owner: scope.window as unknown as Record<string, unknown>, key: 'sm3' }
        : operationOwner(root, definition.path);
      if (!resolved) continue;
      output.push({
        id: `sm-crypto.${definition.operation}`,
        operation: definition.operation,
        owner: resolved.owner,
        key: resolved.key,
        resultMode: 'sync',
        describe: (_thisArg, args, toolkit) => describe(definition, args, toolkit),
        createWrapper: (_original, invoke) => function recordedSmCrypto(this: unknown, ...args: unknown[]) {
          return invoke(this, args);
        },
      });
    }
    return output;
  },
};
