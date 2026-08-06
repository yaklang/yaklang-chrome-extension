import type { PageContext, PageStorageSummary } from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const MAX_COOKIE_COUNT = 500;
const MAX_COOKIE_VALUE_BYTES = 1024 * 1_024;

function authRelated(name: string): boolean {
  return /(auth|token|jwt|session|login|csrf|xsrf|sid|credential|bearer)/i.test(name);
}

function likelyCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(trimmed)
    || /^Bearer\s+\S+/i.test(trimmed)
    || /^[A-Fa-f0-9]{32,}$/.test(trimmed);
}

function requireCompleteStorage(
  area: 'local' | 'session',
  summary: PageStorageSummary | undefined,
): PageStorageSummary {
  if (!summary?.supported || summary.error) {
    throw new ExtensionError(
      'auth_context_storage_unavailable',
      `${area === 'local' ? 'localStorage' : 'sessionStorage'} 无法完整读取，不能生成可靠的认证指纹`,
    );
  }
  if (summary.truncated || summary.entries.some((entry) => entry.truncated)) {
    throw new ExtensionError(
      'auth_context_too_large',
      `${area === 'local' ? 'localStorage' : 'sessionStorage'} 快照发生截断，已拒绝生成不完整认证指纹`,
    );
  }
  return summary;
}

function cookieCanonical(context: PageContext): Array<Record<string, unknown>> {
  const cookies = context.cookies || [];
  if (cookies.length > MAX_COOKIE_COUNT) {
    throw new ExtensionError(
      'auth_context_too_large',
      `目标来源包含超过 ${MAX_COOKIE_COUNT} 个 Cookie，已拒绝生成不完整认证指纹`,
    );
  }
  const totalBytes = cookies.reduce(
    (total, cookie) => total + new TextEncoder().encode(cookie.value).byteLength,
    0,
  );
  if (totalBytes > MAX_COOKIE_VALUE_BYTES) {
    throw new ExtensionError(
      'auth_context_too_large',
      '目标来源 Cookie 值总量超过 1 MiB，已拒绝生成不完整认证指纹',
    );
  }
  return cookies
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      storeId: cookie.storeId,
      partitionKey: cookie.partitionKey,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function authenticationStorageEntries(context: PageContext): Array<{
  area: 'local' | 'session';
  key: string;
  value: string;
}> {
  const local = requireCompleteStorage('local', context.document.localStorage);
  const session = requireCompleteStorage('session', context.document.sessionStorage);
  return [
    ...local.entries
      .filter((entry) => entry.authRelated || authRelated(entry.key) || likelyCredentialValue(entry.value))
      .map((entry) => ({ area: 'local' as const, key: entry.key, value: entry.value })),
    ...session.entries
      .filter((entry) => entry.authRelated || authRelated(entry.key) || likelyCredentialValue(entry.value))
      .map((entry) => ({ area: 'session' as const, key: entry.key, value: entry.value })),
  ].sort((left, right) => `${left.area}:${left.key}`.localeCompare(`${right.area}:${right.key}`));
}

export async function authenticationFingerprint(
  context: PageContext,
  signer: (value: string) => Promise<string>,
): Promise<string> {
  const cookies = await Promise.all(cookieCanonical(context).map(async (cookie) => ({
    ...cookie,
    value: await signer(String(cookie.value)),
  })));
  const storage = await Promise.all(authenticationStorageEntries(context).map(async (entry) => ({
    area: entry.area,
    key: entry.key,
    value: await signer(entry.value),
  })));
  const canonical = JSON.stringify({
    version: 1,
    origin: new URL(context.document.url).origin,
    cookies,
    storage,
  });
  return `hmac-sha256:${await signer(canonical)}`;
}
