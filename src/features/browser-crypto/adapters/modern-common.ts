import type { BrowserRecordingCrypto } from '@/types/models';
import type { CryptoAdapterToolkit } from './contract';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

export function hasMethod(owner: Record<string, unknown> | undefined, key: string): boolean {
  try { return Boolean(owner && typeof owner[key] === 'function'); } catch { return false; }
}

export function callableProxy(
  original: Function,
  invoke: (thisArg: unknown, args: unknown[]) => unknown,
): Function {
  return new Proxy(original, {
    apply(_target, thisArg, args) { return invoke(thisArg, args); },
  });
}

export function opaqueKey(
  value: unknown,
  kind: NonNullable<BrowserRecordingCrypto['key']>['kind'],
  toolkit: CryptoAdapterToolkit,
): BrowserRecordingCrypto['key'] {
  let material: string | undefined;
  let bits: number | undefined;
  try {
    if (typeof value === 'string') {
      material = value;
      bits = toolkit.byteLength(value) ? toolkit.byteLength(value)! * 8 : undefined;
    } else {
      const bytes = toolkit.bytesForInput(value);
      if (bytes) {
        material = toolkit.bytesToBase64(bytes);
        bits = bytes.byteLength * 8;
      }
    }
  } catch {
    material = undefined;
    bits = undefined;
  }
  return {
    kind,
    bits,
    fingerprint: material ? toolkit.fingerprint(material) : undefined,
  };
}

export function uniqueRecords(values: unknown[]): Record<string, unknown>[] {
  const seen = new Set<Record<string, unknown>>();
  const output: Record<string, unknown>[] = [];
  for (const value of values) {
    const item = asRecord(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  return output;
}
