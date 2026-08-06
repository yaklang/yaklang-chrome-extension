import type { BrowserRecordingValueEvidence } from '@/types/models';

export interface RecordingEvidenceOptions {
  captureValues: boolean;
  maxValueBytes: number;
}

export interface RecordingEvidenceRuntime {
  reseed(): void;
  dataType(value: unknown): string;
  asBytes(value: unknown): Uint8Array | undefined;
  bytesToBase64(bytes: Uint8Array): string;
  fingerprint(value: string): string;
  collect(
    value: unknown,
    path?: string,
    depth?: number,
    output?: BrowserRecordingValueEvidence[],
    parseStringContainers?: boolean,
  ): BrowserRecordingValueEvidence[];
  byteLength(value: unknown): number | undefined;
  preview(value: unknown): string | undefined;
}

const MAX_FINGERPRINT_UNITS = 262_144;
const MAX_CONTAINER_ENTRIES = 64;
const MAX_EVIDENCE_ITEMS = 48;
const MAX_EVIDENCE_DEPTH = 3;

export function createRecordingEvidenceRuntime(
  scope: Window,
  options: () => RecordingEvidenceOptions,
): RecordingEvidenceRuntime {
  const json = (scope as unknown as { JSON?: JSON }).JSON || JSON;
  const nativeStringify = json.stringify.bind(json);
  const nativeParse = json.parse.bind(json);
  const nativeBtoa = scope.btoa.bind(scope);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const URLSearchParamsConstructor = (
    scope as unknown as { URLSearchParams?: typeof URLSearchParams }
  ).URLSearchParams;
  const FormDataConstructor = (scope as unknown as { FormData?: typeof FormData }).FormData;
  const BlobConstructor = (scope as unknown as { Blob?: typeof Blob }).Blob;
  let fingerprintSeedLeft = 0x811c9dc5;
  let fingerprintSeedRight = 0x9e3779b9;

  const dataType = (value: unknown): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return typeof value;
    return Object.prototype.toString.call(value).slice(8, -1);
  };

  const asBytes = (value: unknown): Uint8Array | undefined => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return undefined;
  };

  const bytesToHex = (bytes: Uint8Array): string => {
    let output = '';
    for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
    return output;
  };

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunk = 8_192;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return nativeBtoa(binary);
  };

  const fingerprint = (value: string): string => {
    const limit = Math.min(value.length, MAX_FINGERPRINT_UNITS);
    let left = (fingerprintSeedLeft ^ value.length) >>> 0;
    let right = (fingerprintSeedRight ^ Math.imul(value.length, 0x85ebca6b)) >>> 0;
    for (let index = 0; index < limit; index += 1) {
      const code = value.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193) >>> 0;
      right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
    }
    return `v2:${value.length}:${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
  };

  const reseed = (): void => {
    const seed = new Uint32Array(2);
    try {
      scope.crypto.getRandomValues(seed);
      fingerprintSeedLeft = seed[0] || 0x811c9dc5;
      fingerprintSeedRight = seed[1] || 0x9e3779b9;
    } catch {
      fingerprintSeedLeft = (Date.now() ^ Math.floor(performance.now() * 1_000)) >>> 0;
      fingerprintSeedRight = Math.imul(fingerprintSeedLeft ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    }
  };

  const truncatePreview = (value: string): string => {
    const bytes = encoder.encode(value);
    const limit = options().maxValueBytes;
    return bytes.byteLength <= limit ? value : decoder.decode(bytes.slice(0, limit));
  };

  const evidenceText = (
    path: string,
    value: string,
    encoding: BrowserRecordingValueEvidence['encoding'],
  ): BrowserRecordingValueEvidence => ({
    path,
    fingerprint: fingerprint(value),
    encoding,
    byteLength: encoder.encode(value).byteLength,
    preview: options().captureValues ? truncatePreview(value) : undefined,
  });

  const formEncodedEntries = (value: string): Array<[string, string]> | undefined => {
    if (!value.includes('=') || value.length > MAX_FINGERPRINT_UNITS) return undefined;
    const compact = value.trim();
    if (compact.length >= 8 && compact.length % 4 === 0
      && /^(?:[A-Za-z0-9+/_-]+={0,2})$/.test(compact)) return undefined;
    const segments = value.split('&');
    if (!segments.length || segments.length > MAX_CONTAINER_ENTRIES) return undefined;
    const entries: Array<[string, string]> = [];
    for (const segment of segments) {
      const separator = segment.indexOf('=');
      if (separator <= 0) return undefined;
      let key: string;
      try {
        key = decodeURIComponent(segment.slice(0, separator).replace(/\+/g, ' '));
      } catch {
        return undefined;
      }
      if (!/^[\p{L}_$][\p{L}\p{N}_.\[\]$-]{0,127}$/u.test(key)) return undefined;
      let item: string;
      try {
        item = decodeURIComponent(segment.slice(separator + 1).replace(/\+/g, ' '));
      } catch {
        return undefined;
      }
      entries.push([key, item]);
    }
    return entries;
  };

  const collect: RecordingEvidenceRuntime['collect'] = (
    value,
    path = '$',
    depth = 0,
    output = [],
    parseStringContainers = true,
  ) => {
    if (output.length >= MAX_EVIDENCE_ITEMS || value === undefined) return output;
    if (typeof value === 'string') {
      output.push(evidenceText(path, value, 'text'));
      if (depth < MAX_EVIDENCE_DEPTH && (value.startsWith('{') || value.startsWith('['))) {
        try {
          collect(nativeParse(value), `${path}:json`, depth + 1, output);
        } catch {
          // Not JSON.
        }
      }
      if (parseStringContainers && depth < MAX_EVIDENCE_DEPTH) {
        const entries = formEncodedEntries(value);
        for (const [key, item] of entries || []) {
          collect(item, `${path}:form.${key}`, depth + 1, output, false);
        }
      }
      return output;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      output.push(evidenceText(path, String(value), 'text'));
      return output;
    }
    const bytes = asBytes(value);
    if (bytes) {
      const bounded = bytes.length > MAX_FINGERPRINT_UNITS
        ? bytes.subarray(0, MAX_FINGERPRINT_UNITS)
        : bytes;
      output.push({
        ...evidenceText(path, bytesToHex(bounded), 'hex'),
        byteLength: bytes.byteLength,
      });
      if (output.length < MAX_EVIDENCE_ITEMS) {
        output.push({
          ...evidenceText(path, bytesToBase64(bounded), 'base64'),
          byteLength: bytes.byteLength,
        });
      }
      return output;
    }
    if (
      typeof URLSearchParamsConstructor === 'function'
      && value instanceof URLSearchParamsConstructor
    ) {
      output.push(evidenceText(path, value.toString(), 'text'));
      for (const [key, item] of value) {
        collect(item, `${path}:form.${key}`, depth + 1, output, false);
      }
      return output;
    }
    if (typeof FormDataConstructor === 'function' && value instanceof FormDataConstructor) {
      for (const [key, item] of value.entries()) {
        collect(
          typeof item === 'string' ? item : `[file ${item.name} ${item.size}]`,
          `${path}:form.${key}`,
          depth + 1,
          output,
          false,
        );
      }
      return output;
    }
    if (
      value
      && typeof value === 'object'
      && typeof (value as { sigBytes?: unknown }).sigBytes === 'number'
      && typeof (value as { toString?: unknown }).toString === 'function'
    ) {
      try {
        output.push(evidenceText(path, (value as { toString(): string }).toString(), 'hex'));
      } catch {
        // Ignore invalid library values.
      }
      return output;
    }
    if (value && typeof value === 'object' && depth < MAX_EVIDENCE_DEPTH) {
      let entries: Array<[string, unknown]> = [];
      try {
        entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
      } catch {
        return output;
      }
      for (const [key, item] of entries) collect(item, `${path}.${key}`, depth + 1, output);
      if (depth === 0) {
        try {
          output.unshift(evidenceText(path, nativeStringify(value), 'json'));
        } catch {
          // Circular object.
        }
      }
    }
    return output.slice(0, MAX_EVIDENCE_ITEMS);
  };

  const byteLength = (value: unknown): number | undefined => {
    try {
      if (typeof value === 'string') return encoder.encode(value).byteLength;
      if (typeof BlobConstructor === 'function' && value instanceof BlobConstructor) return value.size;
      const bytes = asBytes(value);
      if (bytes) return bytes.byteLength;
      if (
        typeof URLSearchParamsConstructor === 'function'
        && value instanceof URLSearchParamsConstructor
      ) return encoder.encode(value.toString()).byteLength;
      if (
        value
        && typeof value === 'object'
        && typeof (value as { sigBytes?: unknown }).sigBytes === 'number'
      ) return Math.max(0, Number((value as { sigBytes: number }).sigBytes));
      if (value !== undefined) return encoder.encode(nativeStringify(value)).byteLength;
    } catch {
      return undefined;
    }
    return undefined;
  };

  const preview = (value: unknown): string | undefined => {
    if (!options().captureValues || value === undefined) return undefined;
    try {
      if (typeof value === 'string') return truncatePreview(value);
      const bytes = asBytes(value);
      if (bytes) return `[binary ${bytes.byteLength} bytes]`;
      if (
        typeof URLSearchParamsConstructor === 'function'
        && value instanceof URLSearchParamsConstructor
      ) return truncatePreview(value.toString());
      if (typeof FormDataConstructor === 'function' && value instanceof FormDataConstructor) {
        return truncatePreview(nativeStringify(
          [...value.entries()].map(([key, item]) => [
            key,
            typeof item === 'string' ? item : `[file ${item.size} bytes]`,
          ]),
        ));
      }
      if (
        value
        && typeof value === 'object'
        && typeof (value as { toString?: unknown }).toString === 'function'
      ) {
        const text = (value as { toString(): string }).toString();
        return truncatePreview(text === '[object Object]' ? nativeStringify(value) : text);
      }
      return truncatePreview(String(value));
    } catch {
      return `[${dataType(value)}]`;
    }
  };

  return {
    reseed,
    dataType,
    asBytes,
    bytesToBase64,
    fingerprint,
    collect,
    byteLength,
    preview,
  };
}
