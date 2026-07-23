import type { BrowserCryptoFamily } from '@/types/models';
import type { CallableOperationKind } from './contract';

export function cryptoFamily(operation: string, algorithm?: string): BrowserCryptoFamily {
  const value = `${operation} ${algorithm || ''}`.toLowerCase();
  if (value.includes('hmac')) return 'mac';
  if (value.includes('digest') || /\b(?:sha\d*|md5|ripemd|sm3)\b/.test(value)) return 'digest';
  if (value.includes('derive') || value.includes('pbkdf') || value.includes('evpkdf') || value.includes('kdf')) return 'kdf';
  if (value.includes('sign') || value.includes('verify')) return 'signature';
  if (value.includes('rsa') || value.includes('ecies') || value.includes('sm2')) return 'asymmetric';
  if (value.includes('encrypt') || value.includes('decrypt') || value.includes('wrap') || value.includes('sm4')) return 'symmetric';
  if (value.includes('key') || value.includes('import') || value.includes('export')) return 'key-management';
  return 'unknown';
}

export function callableOperationKind(operation: string): CallableOperationKind | undefined {
  const normalized = operation.toLowerCase();
  if (normalized.includes('decrypt')) return 'decrypt';
  if (normalized.includes('encrypt')) return 'encrypt';
  if (normalized.includes('verify')) return 'verify';
  if (normalized.includes('sign') || normalized.includes('hmac')) return 'sign';
  if (normalized.includes('digest') || normalized.includes('sha') || normalized.includes('md5') || normalized.includes('sm3')) return 'digest';
  return undefined;
}

export function algorithmSummary(
  value: unknown,
  byteLength: (input: unknown) => number | undefined,
): string | undefined {
  if (typeof value === 'string') return value.slice(0, 160);
  if (!value || typeof value !== 'object') return undefined;
  const algorithm = value as Record<string, unknown>;
  const parts = [typeof algorithm.name === 'string' ? algorithm.name : 'unknown'];
  if (typeof algorithm.namedCurve === 'string') parts.push(`curve=${algorithm.namedCurve}`);
  if (typeof algorithm.length === 'number') parts.push(`length=${algorithm.length}`);
  if (typeof algorithm.tagLength === 'number') parts.push(`tag=${algorithm.tagLength}`);
  const hash = algorithm.hash;
  if (typeof hash === 'string') parts.push(`hash=${hash}`);
  else if (hash && typeof hash === 'object' && typeof (hash as { name?: unknown }).name === 'string') {
    parts.push(`hash=${(hash as { name: string }).name}`);
  }
  if (algorithm.iv !== undefined) parts.push(`ivBytes=${byteLength(algorithm.iv) || 0}`);
  if (algorithm.salt !== undefined) parts.push(`saltBytes=${byteLength(algorithm.salt) || 0}`);
  return parts.join(' ').slice(0, 240);
}

