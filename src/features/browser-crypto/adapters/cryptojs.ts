import { callableOperationKind, cryptoFamily } from './common';
import type {
  CryptoAdapterInvocationPlan,
  CryptoAdapterOperation,
  CryptoAdapterScope,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { cryptoJsManifest } from './catalog';

const PATHS = [
  'AES.encrypt', 'AES.decrypt', 'DES.encrypt', 'DES.decrypt', 'TripleDES.encrypt', 'TripleDES.decrypt',
  'RC4.encrypt', 'RC4.decrypt', 'Rabbit.encrypt', 'Rabbit.decrypt', 'MD5', 'SHA1', 'SHA224', 'SHA256',
  'SHA384', 'SHA512', 'SHA3', 'RIPEMD160', 'HmacMD5', 'HmacSHA1', 'HmacSHA224', 'HmacSHA256',
  'HmacSHA384', 'HmacSHA512', 'PBKDF2', 'EvpKDF',
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

function memberName(cryptoJs: Record<string, unknown>, group: 'mode' | 'pad', value: unknown): string | undefined {
  const members = cryptoJs[group];
  if (!members || typeof members !== 'object') return undefined;
  try {
    return Object.entries(members as Record<string, unknown>).find(([, candidate]) => candidate === value)?.[0]?.slice(0, 80);
  } catch {
    return undefined;
  }
}

function optionsMetadata(
  cryptoJs: Record<string, unknown>,
  value: unknown,
  toolkit: CryptoAdapterToolkit,
): { summary?: string; mode?: string; padding?: string } {
  if (!value || typeof value !== 'object') return {};
  const mode = memberName(cryptoJs, 'mode', ownValue(value, 'mode'));
  const padding = memberName(cryptoJs, 'pad', ownValue(value, 'padding'));
  const iv = ownValue(value, 'iv');
  const parts: string[] = [];
  if (mode) parts.push(`mode=${mode}`);
  if (padding) parts.push(`padding=${padding}`);
  if (iv !== undefined) parts.push(`ivBytes=${toolkit.byteLength(iv) || 0}`);
  return { summary: parts.length ? parts.join(' ').slice(0, 240) : undefined, mode, padding };
}

function describe(
  scope: CryptoAdapterScope,
  path: string,
  args: unknown[],
  toolkit: CryptoAdapterToolkit,
): CryptoAdapterInvocationPlan {
  const cryptoJs = (scope.window as unknown as { CryptoJS?: Record<string, unknown> }).CryptoJS || {};
  const normalized = path.toLowerCase();
  const encrypting = normalized.includes('encrypt');
  const options = normalized.includes('encrypt') || normalized.includes('decrypt')
    ? optionsMetadata(cryptoJs, args[2], toolkit)
    : {};
  let roles: Array<'data' | 'key' | 'salt' | 'options' | 'unknown'> = ['data'];
  if (normalized.includes('hmac')) roles = ['data', 'key'];
  else if (normalized.includes('pbkdf2') || normalized.includes('evpkdf')) roles = ['data', 'salt', 'options'];
  else if (normalized.includes('.encrypt') || normalized.includes('.decrypt')) roles = ['data', 'key', 'options'];
  const callableKind = callableOperationKind(path);
  return {
    crypto: {
      adapterId: cryptoJsManifest.id,
      providerKind: cryptoJsManifest.providerKind,
      family: cryptoFamily(path, path),
      operation: path,
      algorithm: path,
      mode: options.mode,
      padding: options.padding,
      inputEncoding: 'auto',
      outputEncoding: encrypting ? 'base64' : 'auto',
      state: { model: 'stateless', phase: 'one-shot' },
    },
    inputIndex: 0,
    callableKind,
    outputEncoding: encrypting ? 'base64' : 'auto',
    arguments: args.slice(0, 8).map((value, index) => toolkit.argument(
      index,
      roles[index] || 'unknown',
      value,
      index === 0,
      Boolean(callableKind),
      roles[index] === 'options' ? options.summary : undefined,
    )),
    outputEvidence(value) {
      const output = toolkit.defaultOutputEvidence(value);
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || output.length >= 48) return output;
      try {
        const toString = (value as { toString?: unknown }).toString;
        if (typeof toString !== 'function') return output;
        const text = Reflect.apply(toString, value, []);
        if (typeof text !== 'string' || !text || text === '[object Object]') return output;
        const extra = toolkit.collectEvidence(text, '$output:string')[0];
        if (extra && !output.some((item) => item.path === extra.path && item.fingerprint === extra.fingerprint)) output.push(extra);
      } catch {
        // Compatible CryptoJS result objects are best-effort evidence only.
      }
      return output.slice(0, 48);
    },
    adaptInput(value) {
      const originalInput = args[0];
      if (originalInput && typeof originalInput === 'object'
        && typeof (originalInput as { sigBytes?: unknown }).sigBytes === 'number') {
        const bytes = toolkit.bytesForInput(value);
        const encoder = (cryptoJs as { enc?: { Base64?: { parse?(input: string): unknown } } }).enc?.Base64;
        if (bytes && typeof encoder?.parse === 'function') return encoder.parse(toolkit.bytesToBase64(bytes));
      }
      return toolkit.defaultAdaptInput(value, originalInput);
    },
  };
}

export const cryptoJsAdapter: PageCryptoAdapter = {
  manifest: cryptoJsManifest,
  discover(scope): CryptoAdapterOperation[] {
    const cryptoJs = (scope.window as unknown as { CryptoJS?: Record<string, unknown> }).CryptoJS;
    if (!cryptoJs) return [];
    const output: CryptoAdapterOperation[] = [];
    for (const path of PATHS) {
      const segments = path.split('.');
      let owner: Record<string, unknown> | undefined = cryptoJs;
      for (const segment of segments.slice(0, -1)) {
        const next = owner?.[segment];
        if (!next || (typeof next !== 'object' && typeof next !== 'function')) {
          owner = undefined;
          break;
        }
        owner = next as Record<string, unknown>;
      }
      if (!owner) continue;
      output.push({
        id: `cryptojs.${path}`,
        operation: path,
        owner,
        key: segments.at(-1)!,
        resultMode: 'sync',
        describe: (_thisArg, args, toolkit) => describe(scope, path, args, toolkit),
        createWrapper: (_original, invoke) => function recordedCryptoJs(this: unknown, ...args: unknown[]) {
          return invoke(this, args);
        },
      });
    }
    return output;
  },
};
