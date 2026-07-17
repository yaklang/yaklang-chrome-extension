import type {
  BrowserCookie, CookieImportResult, CookieInput, CookieTransferFormat,
} from '@/types/models';
import { setCookie } from '@/features/cookies/service';

const MAX_COOKIES = 1_000;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;

function assertTransferSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_TRANSFER_BYTES) throw new Error('Cookie 导入内容超过 2 MiB');
}

export function buildCookieUrl(baseUrl: string, input: Pick<CookieInput, 'domain' | 'path' | 'secure'>): string {
  const base = new URL(baseUrl);
  const host = input.domain?.replace(/^\./, '') || base.hostname;
  const protocol = input.secure ? 'https:' : base.protocol === 'https:' ? 'https:' : 'http:';
  const path = input.path?.startsWith('/') ? input.path : `/${input.path || ''}`;
  return `${protocol}//${host}${path}`;
}

function sameSite(value: unknown): CookieInput['sameSite'] {
  const normalized = String(value || '').toLowerCase().replace('none', 'no_restriction');
  return ['lax', 'strict', 'no_restriction', 'unspecified'].includes(normalized)
    ? normalized as CookieInput['sameSite']
    : 'unspecified';
}

function fromRecord(value: unknown, baseUrl: string, warnings: string[]): CookieInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || typeof input.value !== 'string' || input.name.length > 4_096 || input.value.length > 64 * 1_024) return undefined;
  const output: CookieInput = {
    url: baseUrl,
    name: input.name,
    value: input.value,
    domain: typeof input.domain === 'string' ? input.domain.slice(0, 253) : undefined,
    path: typeof input.path === 'string' ? input.path.slice(0, 4_096) : '/',
    secure: input.secure === true,
    httpOnly: input.httpOnly === true,
    sameSite: sameSite(input.sameSite),
    expirationDate: typeof input.expirationDate === 'number' && Number.isFinite(input.expirationDate) ? input.expirationDate : undefined,
    storeId: typeof input.storeId === 'string' ? input.storeId.slice(0, 240) : undefined,
  };
  if (input.partitionKey && typeof input.partitionKey === 'object') {
    const partition = input.partitionKey as Record<string, unknown>;
    output.partitionKey = {
      topLevelSite: typeof partition.topLevelSite === 'string' ? partition.topLevelSite.slice(0, 8_192) : undefined,
      hasCrossSiteAncestor: partition.hasCrossSiteAncestor === true,
    };
  }
  if (input.priority || input.sameParty) warnings.push(`${input.name}: Priority/SameParty 无法通过浏览器 Cookies API 写回`);
  output.url = buildCookieUrl(baseUrl, output);
  return output;
}

function parseJSON(text: string, baseUrl: string, warnings: string[]): CookieInput[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('JSON Cookie 必须是数组');
  if (parsed.length > MAX_COOKIES) throw new Error(`单次最多导入 ${MAX_COOKIES} 个 Cookie`);
  return parsed.map((item) => fromRecord(item, baseUrl, warnings)).filter((item): item is CookieInput => Boolean(item));
}

function parseNetscape(text: string, baseUrl: string): CookieInput[] {
  const output: CookieInput[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const httpOnly = rawLine.startsWith('#HttpOnly_');
    if ((!httpOnly && rawLine.trim().startsWith('#')) || !rawLine.trim()) continue;
    const line = httpOnly ? rawLine.slice('#HttpOnly_'.length) : rawLine;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , path, secure, expiration, name, ...value] = fields;
    const item: CookieInput = {
      url: baseUrl, name, value: value.join('\t'), domain, path: path || '/', secure: secure.toUpperCase() === 'TRUE', httpOnly,
      expirationDate: Number(expiration) > 0 ? Number(expiration) : undefined,
      sameSite: 'unspecified',
    };
    item.url = buildCookieUrl(baseUrl, item);
    output.push(item);
    if (output.length > MAX_COOKIES) throw new Error(`单次最多导入 ${MAX_COOKIES} 个 Cookie`);
  }
  return output;
}

function parseSetCookie(text: string, baseUrl: string, warnings: string[]): CookieInput[] {
  const output: CookieInput[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^set-cookie:\s*/i, '').trim();
    if (!line) continue;
    const [pair, ...attributes] = line.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const item: CookieInput = { url: baseUrl, name: pair.slice(0, separator), value: pair.slice(separator + 1), path: '/', sameSite: 'unspecified' };
    for (const attribute of attributes) {
      const [rawName, ...rawValue] = attribute.split('=');
      const name = rawName.toLowerCase();
      const value = rawValue.join('=');
      if (name === 'domain') item.domain = value;
      else if (name === 'path') item.path = value || '/';
      else if (name === 'secure') item.secure = true;
      else if (name === 'httponly') item.httpOnly = true;
      else if (name === 'samesite') item.sameSite = sameSite(value);
      else if (name === 'expires') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) item.expirationDate = timestamp / 1_000;
      } else if (name === 'max-age' && Number.isFinite(Number(value))) item.expirationDate = Date.now() / 1_000 + Number(value);
      else if (name === 'partitioned') item.partitionKey = { topLevelSite: new URL(baseUrl).origin };
      else if (name === 'priority' || name === 'sameparty') warnings.push(`${item.name}: ${rawName} 无法通过浏览器 Cookies API 写回`);
    }
    item.url = buildCookieUrl(baseUrl, item);
    output.push(item);
    if (output.length > MAX_COOKIES) throw new Error(`单次最多导入 ${MAX_COOKIES} 个 Cookie`);
  }
  return output;
}

export async function importCookies(baseUrl: string, format: CookieTransferFormat, text: string): Promise<CookieImportResult> {
  assertTransferSize(text);
  const warnings: string[] = [];
  const cookies = format === 'json' ? parseJSON(text, baseUrl, warnings)
    : format === 'netscape' ? parseNetscape(text, baseUrl)
      : parseSetCookie(text, baseUrl, warnings);
  let imported = 0;
  let failed = 0;
  for (const cookie of cookies) {
    try {
      await setCookie(cookie);
      imported += 1;
    } catch (error) {
      failed += 1;
      if (warnings.length < 50) warnings.push(`${cookie.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (cookies.length === 0) warnings.push('没有解析到可导入的 Cookie');
  return { imported, failed, warnings: warnings.slice(0, 50) };
}

function displayValue(cookie: BrowserCookie, includeValues: boolean): string {
  return includeValues ? cookie.value : '[REDACTED]';
}

export function exportCookies(cookies: BrowserCookie[], format: CookieTransferFormat, includeValues: boolean): string {
  if (format === 'json') {
    return JSON.stringify(cookies.map((cookie) => ({ ...cookie, value: displayValue(cookie, includeValues) })), null, 2);
  }
  if (format === 'netscape') {
    const lines = ['# Netscape HTTP Cookie File', '# Exported by Yakit Browser Agent'];
    for (const cookie of cookies) {
      const domain = `${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`;
      lines.push([domain, cookie.hostOnly ? 'FALSE' : 'TRUE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE', Math.floor(cookie.expirationDate || 0), cookie.name, displayValue(cookie, includeValues)].join('\t'));
    }
    return `${lines.join('\n')}\n`;
  }
  return cookies.map((cookie) => {
    const attributes = [`Path=${cookie.path}`];
    if (!cookie.hostOnly) attributes.push(`Domain=${cookie.domain}`);
    if (cookie.expirationDate) attributes.push(`Expires=${new Date(cookie.expirationDate * 1_000).toUTCString()}`);
    if (cookie.secure) attributes.push('Secure');
    if (cookie.httpOnly) attributes.push('HttpOnly');
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') attributes.push(`SameSite=${cookie.sameSite === 'no_restriction' ? 'None' : cookie.sameSite}`);
    if (cookie.partitionKey) attributes.push('Partitioned');
    if (cookie.priority) attributes.push(`Priority=${cookie.priority}`);
    if (cookie.sameParty) attributes.push('SameParty');
    return `Set-Cookie: ${cookie.name}=${displayValue(cookie, includeValues)}; ${attributes.join('; ')}`;
  }).join('\n');
}
