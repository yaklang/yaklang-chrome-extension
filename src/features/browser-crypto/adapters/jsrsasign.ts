import type { BrowserRecordingCrypto } from '@/types/models';
import type {
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { jsrsasignManifest } from './catalog';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function method(owner: Record<string, unknown> | undefined, key: string): boolean {
  try { return Boolean(owner && typeof owner[key] === 'function'); } catch { return false; }
}

function stringProperty(value: unknown, key: string): string | undefined {
  const input = record(value);
  try { return typeof input?.[key] === 'string' ? String(input[key]).slice(0, 160) : undefined; } catch { return undefined; }
}

function callWrapper(invoke: (thisArg: unknown, args: unknown[]) => unknown): Function {
  return function recordedJsrsasign(this: unknown, ...args: unknown[]) { return invoke(this, args); };
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

function publicKeyMaterial(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const key = record(value);
  if (!key) return undefined;
  const fields = ['kty', 'crv', 'x', 'y', 'n', 'e', 'kid', 'use', 'alg'];
  const parts: string[] = [];
  for (const field of fields) {
    try {
      const item = key[field];
      if (typeof item === 'string' || typeof item === 'number') parts.push(`${field}=${String(item)}`);
    } catch { /* Proxy-backed key metadata is optional. */ }
  }
  try {
    const modulus = record(key.n);
    if (typeof modulus?.toString === 'function') parts.push(`n=${Reflect.apply(modulus.toString as Function, key.n, [16])}`);
    if (key.e !== undefined) parts.push(`e=${String(key.e)}`);
  } catch { /* Big integer internals differ by release. */ }
  return parts.length ? parts.join('&') : undefined;
}

function keyMetadata(
  value: unknown,
  toolkit: CryptoAdapterToolkit,
  preferredKind: NonNullable<BrowserRecordingCrypto['key']>['kind'] = 'unknown',
): BrowserRecordingCrypto['key'] {
  const text = typeof value === 'string' ? value : '';
  const kind = /PRIVATE KEY/.test(text) || Boolean(record(value)?.d) ? 'private'
    : /PUBLIC KEY|CERTIFICATE/.test(text) ? 'public'
      : preferredKind;
  let bits: number | undefined;
  try {
    const modulus = record(record(value)?.n);
    const result = typeof modulus?.bitLength === 'function'
      ? Reflect.apply(modulus.bitLength as Function, record(value)?.n, [])
      : undefined;
    if (Number.isSafeInteger(result) && Number(result) >= 256 && Number(result) <= 32_768) bits = Number(result);
  } catch { /* Key size is optional. */ }
  const material = publicKeyMaterial(value);
  return { kind, bits, fingerprint: material ? toolkit.fingerprint(material) : undefined };
}

function signatureCrypto(
  operation: string,
  algorithm: string | undefined,
  correlationId: string,
  phase: NonNullable<BrowserRecordingCrypto['state']>['phase'],
  key?: BrowserRecordingCrypto['key'],
): BrowserRecordingCrypto {
  return {
    adapterId: jsrsasignManifest.id,
    providerKind: jsrsasignManifest.providerKind,
    family: 'signature',
    operation,
    algorithm,
    inputEncoding: operation.toLowerCase().includes('hex') ? 'hex' : 'utf8',
    outputEncoding: 'hex',
    state: { model: 'session', phase, correlationId },
    key,
  };
}

function signatureSessionOperations(
  value: unknown,
  correlationId: string,
  initialAlgorithm: string | undefined,
): CryptoAdapterOperation[] {
  const owner = record(value);
  if (!owner) return [];
  const context: { algorithm?: string; key?: BrowserRecordingCrypto['key'] } = { algorithm: initialAlgorithm };
  const output: CryptoAdapterOperation[] = [];

  for (const key of ['init', 'initSign', 'initVerifyByPublicKey', 'initVerifyByCertificatePEM']) {
    if (!method(owner, key)) continue;
    output.push({
      id: `jsrsasign.${correlationId}.Signature.${key}`,
      operation: `Signature.${key}`,
      owner,
      key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => {
        context.key = keyMetadata(args[0], toolkit, key.includes('Verify') ? 'public' : 'unknown');
        return {
          crypto: signatureCrypto(`Signature.${key}`, context.algorithm, correlationId, 'init', context.key),
          inputIndex: -1,
          arguments: args.slice(0, 3).map((argument, index) => toolkit.argument(
            index, index === 0 ? 'key' : 'options', argument, false, false,
          )),
          outputEvidence: () => [],
        };
      },
      createWrapper: (_original, invoke) => callWrapper(invoke),
    });
  }

  if (method(owner, 'setAlgAndProvider')) output.push({
    id: `jsrsasign.${correlationId}.Signature.setAlgAndProvider`,
    operation: 'Signature.setAlgAndProvider',
    owner,
    key: 'setAlgAndProvider',
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => {
      if (typeof args[0] === 'string') context.algorithm = args[0].slice(0, 160);
      return {
        crypto: signatureCrypto('Signature.setAlgAndProvider', context.algorithm, correlationId, 'init', context.key),
        inputIndex: -1,
        arguments: args.slice(0, 2).map((argument, index) => toolkit.argument(index, 'algorithm', argument, false, false)),
        outputEvidence: () => [],
      };
    },
    createWrapper: (_original, invoke) => callWrapper(invoke),
  });

  for (const key of ['updateString', 'updateHex']) {
    if (!method(owner, key)) continue;
    output.push({
      id: `jsrsasign.${correlationId}.Signature.${key}`,
      operation: `Signature.${key}`,
      owner,
      key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => ({
        crypto: signatureCrypto(`Signature.${key}`, context.algorithm, correlationId, 'update', context.key),
        inputIndex: 0,
        arguments: args.slice(0, 2).map((argument, index) => toolkit.argument(index, index === 0 ? 'data' : 'options', argument, false, false)),
      }),
      createWrapper: (_original, invoke) => callWrapper(invoke),
    });
  }

  for (const key of ['sign', 'signString', 'signHex', 'verify']) {
    if (!method(owner, key)) continue;
    const verify = key === 'verify';
    const inputIndex = key === 'signString' || key === 'signHex' ? 0 : -1;
    output.push({
      id: `jsrsasign.${correlationId}.Signature.${key}`,
      operation: `Signature.${key}`,
      owner,
      key,
      resultMode: 'sync',
      describe: (_thisArg, args, toolkit) => ({
        crypto: signatureCrypto(`Signature.${key}`, context.algorithm, correlationId, 'final', context.key),
        inputIndex,
        arguments: args.slice(0, 3).map((argument, index) => toolkit.argument(
          index, verify && index === 0 ? 'signature' : index === inputIndex ? 'data' : 'options', argument, false, false,
        )),
        outputError: (result) => verify && result === false ? 'jsrsasign signature verification failed' : undefined,
      }),
      createWrapper: (_original, invoke) => callWrapper(invoke),
    });
  }
  return output;
}

function signatureConstructor(root: Record<string, unknown>): CryptoAdapterOperation | undefined {
  const crypto = record(root.crypto);
  if (!method(crypto, 'Signature')) return undefined;
  return {
    id: 'jsrsasign.Signature.constructor',
    operation: 'Signature.create',
    owner: crypto!,
    key: 'Signature',
    invocationMode: 'construct',
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit): CryptoAdapterInvocationPlan => {
      const correlationId = toolkit.unique('jsrsasign-signature');
      const algorithm = stringProperty(args[0], 'alg') || (typeof args[0] === 'string' ? args[0].slice(0, 160) : undefined);
      return {
        crypto: signatureCrypto('Signature.create', algorithm, correlationId, 'create'),
        inputIndex: -1,
        arguments: args.slice(0, 3).map((argument, index) => toolkit.argument(index, index === 0 ? 'options' : 'unknown', argument, false, false)),
        outputEvidence: () => [],
        discoverResult: (value) => signatureSessionOperations(value, correlationId, algorithm),
      };
    },
    createWrapper: constructorWrapper,
  };
}

function oneShotOperation(
  owner: Record<string, unknown>,
  key: string,
  operation: string,
  family: BrowserRecordingCrypto['family'],
  roles: Array<'algorithm' | 'options' | 'data' | 'key' | 'signature'>,
  inputIndex: number,
  callable: 'sign' | undefined,
): CryptoAdapterOperation | undefined {
  if (!method(owner, key)) return undefined;
  return {
    id: `jsrsasign.${operation}`,
    operation,
    owner,
    key,
    resultMode: 'sync',
    describe: (_thisArg, args, toolkit) => {
      const algorithmIndex = roles.indexOf('algorithm');
      const keyIndex = roles.indexOf('key');
      const algorithm = algorithmIndex >= 0 && typeof args[algorithmIndex] === 'string' ? args[algorithmIndex].slice(0, 160) : undefined;
      return {
        crypto: {
          adapterId: jsrsasignManifest.id,
          providerKind: jsrsasignManifest.providerKind,
          family,
          operation,
          algorithm,
          inputEncoding: 'auto',
          outputEncoding: operation.includes('sign') ? 'auto' : undefined,
          state: { model: 'stateless', phase: 'one-shot' },
          key: keyIndex >= 0 ? keyMetadata(args[keyIndex], toolkit, operation.includes('sign') ? 'private' : 'public') : undefined,
        },
        inputIndex,
        callableKind: callable,
        arguments: args.slice(0, 8).map((argument, index) => toolkit.argument(
          index, roles[index] || 'unknown', argument, index === inputIndex, Boolean(callable),
        )),
        outputEvidence: family === 'key-management' ? () => [] : undefined,
        outputError: (result) => result === false || result === null ? `${operation} returned no result` : undefined,
        adaptInput: inputIndex >= 0 ? (value) => toolkit.defaultAdaptInput(value, args[inputIndex]) : undefined,
      };
    },
    createWrapper: (_original, invoke) => callWrapper(invoke),
  };
}

export const jsrsasignAdapter: PageCryptoAdapter = {
  manifest: jsrsasignManifest,
  discover(scope): CryptoAdapterOperation[] {
    const globals = scope.window as unknown as { KJUR?: Record<string, unknown>; KEYUTIL?: Record<string, unknown> };
    const kjur = globals.KJUR;
    if (!kjur && !globals.KEYUTIL) return [];
    const operations: Array<CryptoAdapterOperation | undefined> = [];
    if (kjur) operations.push(signatureConstructor(kjur));
    const jws = record(record(record(kjur)?.jws)?.JWS);
    if (jws) {
      operations.push(
        oneShotOperation(jws, 'sign', 'JWS.sign', 'signature', ['algorithm', 'options', 'data', 'key', 'options'], 2, 'sign'),
        oneShotOperation(jws, 'verify', 'JWS.verify', 'signature', ['data', 'key', 'options'], -1, undefined),
        oneShotOperation(jws, 'verifyJWT', 'JWT.verify', 'signature', ['data', 'key', 'options'], -1, undefined),
        oneShotOperation(jws, 'getJWKthumbprint', 'JWK.thumbprint', 'key-management', ['key'], -1, undefined),
      );
    }
    const keyutil = globals.KEYUTIL;
    if (keyutil) {
      operations.push(
        oneShotOperation(keyutil, 'getKey', 'KEYUTIL.getKey', 'key-management', ['key', 'options', 'options'], -1, undefined),
        oneShotOperation(keyutil, 'getJWK', 'KEYUTIL.getJWK', 'key-management', ['key', 'options', 'options'], -1, undefined),
        oneShotOperation(keyutil, 'getPEM', 'KEYUTIL.getPEM', 'key-management', ['key', 'options', 'options'], -1, undefined),
      );
    }
    return operations.filter((operation): operation is CryptoAdapterOperation => Boolean(operation));
  },
};
