import type { BrowserRecordingCrypto } from '@/types/models';
import type {
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { jsEncryptManifest } from './catalog';

type JSEncryptOperation = 'encrypt' | 'decrypt' | 'sign' | 'verify';

function keyMetadata(instance: unknown, toolkit: CryptoAdapterToolkit): BrowserRecordingCrypto['key'] {
  if (!instance || typeof instance !== 'object') return { kind: 'unknown' };
  const record = instance as Record<string, unknown>;
  const key = record.key && typeof record.key === 'object' ? record.key as Record<string, unknown> : undefined;
  let bits: number | undefined;
  try {
    const modulus = key?.n as { bitLength?: unknown } | undefined;
    if (typeof modulus?.bitLength === 'function') {
      const value = Reflect.apply(modulus.bitLength as Function, modulus, []);
      if (Number.isSafeInteger(value) && value >= 256 && value <= 32_768) bits = Number(value);
    }
  } catch {
    // Key metadata must never affect the page operation.
  }
  let fingerprint: string | undefined;
  try {
    const modulus = key?.n as { toString?: unknown } | undefined;
    if (typeof modulus?.toString === 'function') {
      const publicMaterial = `${Reflect.apply(modulus.toString as Function, modulus, [16])}:${String(key?.e || '')}`;
      if (publicMaterial.length > 1) fingerprint = toolkit.fingerprint(publicMaterial);
    }
  } catch {
    // Compatible implementations may not expose bounded public metadata.
  }
  return {
    kind: key?.d ? 'private' : key?.n ? 'public' : 'unknown',
    bits,
    fingerprint,
  };
}

function describe(
  operation: JSEncryptOperation,
  instance: unknown,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const encrypting = operation === 'encrypt' || operation === 'sign';
  const roles: Array<'data' | 'signature' | 'algorithm' | 'options' | 'unknown'> = operation === 'verify'
    ? ['data', 'signature', 'algorithm']
    : operation === 'sign'
      ? ['data', 'algorithm', 'options']
      : ['data'];
  return {
    crypto: {
      adapterId: jsEncryptManifest.id,
      providerKind: jsEncryptManifest.providerKind,
      family: operation === 'sign' || operation === 'verify' ? 'signature' : 'asymmetric',
      operation,
      algorithm: 'RSA',
      padding: operation === 'encrypt' || operation === 'decrypt' ? 'PKCS1-v1_5' : 'PKCS1-v1_5-signature',
      inputEncoding: operation === 'decrypt' ? 'base64' : 'utf8',
      outputEncoding: encrypting ? 'base64' : operation === 'decrypt' ? 'utf8' : 'auto',
      state: { model: 'receiver', phase: 'one-shot' },
      key: keyMetadata(instance, toolkit),
    },
    inputIndex: 0,
    callableKind: operation,
    outputEncoding: encrypting ? 'base64' : operation === 'decrypt' ? 'utf8' : 'auto',
    arguments: args.slice(0, 8).map((value, index) => toolkit.argument(
      index,
      roles[index] || 'unknown',
      value,
      index === 0,
      true,
      typeof value === 'function' ? value.name || 'function' : undefined,
    )),
    outputError: (value) => value === false || value === null ? 'JSEncrypt returned no result' : undefined,
    adaptInput: (value) => toolkit.defaultAdaptInput(value, args[0]),
  };
}

function wrapper(
  operation: JSEncryptOperation,
  invoke: (thisArg: unknown, args: unknown[]) => unknown,
): Function {
  switch (operation) {
    case 'encrypt': return function recordedJSEncryptEncrypt(this: unknown, ...args: unknown[]) { return invoke(this, args); };
    case 'decrypt': return function recordedJSEncryptDecrypt(this: unknown, ...args: unknown[]) { return invoke(this, args); };
    case 'sign': return function recordedJSEncryptSign(this: unknown, ...args: unknown[]) { return invoke(this, args); };
    case 'verify': return function recordedJSEncryptVerify(this: unknown, ...args: unknown[]) { return invoke(this, args); };
  }
}

export const jsEncryptAdapter: PageCryptoAdapter = {
  manifest: jsEncryptManifest,
  discover(scope): CryptoAdapterOperation[] {
    const constructor = (scope.window as unknown as { JSEncrypt?: { prototype?: Record<string, unknown> } }).JSEncrypt;
    const owner = constructor?.prototype;
    if (!owner) return [];
    return (['encrypt', 'decrypt', 'sign', 'verify'] as JSEncryptOperation[]).map((operation) => ({
      id: `jsencrypt.${operation}`,
      operation,
      owner,
      key: operation,
      resultMode: 'sync',
      describe: (thisArg, args, toolkit) => describe(operation, thisArg, args, toolkit),
      createWrapper: (_original, invoke) => wrapper(operation, invoke),
    }));
  },
};
