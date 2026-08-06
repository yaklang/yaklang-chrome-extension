import type {
  BrowserAuthorizationBaseline,
  BrowserAuthorizationBaselineField,
  BrowserAuthorizationFieldCategory,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

export const MAX_AUTHORIZATION_BASELINE_BYTES = 2 * 1_024 * 1_024;
export const MAX_AUTHORIZATION_BASELINE_FIELDS = 300;
const MAX_FIELD_DEPTH = 8;
const MAX_GRAPHQL_OPERATIONS = 32;
const AUTHENTICATION_FIELD_PATTERN =
  /(auth|access.?token|api.?key|session|jwt|bearer|credential|password|passwd|passcode|(^|[_.-])pwd($|[_.-])|client.?secret|private.?key|secret.?key|one.?time.?password|(^|[_.-])otp($|[_.-])|mfa.?code|verification.?code|(^|[_.-])pin($|[_.-])|captcha)/;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function comparisonSigner(
  encodedKey: string,
): Promise<(value: string | Uint8Array) => Promise<string>> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(encodedKey);
  } catch {
    throw new ExtensionError('authorization_invalid', '基线比较密钥格式无效');
  }
  if (keyBytes.byteLength !== 32) {
    throw new ExtensionError('authorization_invalid', '基线比较密钥必须为 32 字节');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(keyBytes).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return async (value: string | Uint8Array) => {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value);
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      bytes.buffer,
    );
    return `workspace-hmac-sha256:${bytesToHex(new Uint8Array(signature))}`;
  };
}

export async function fingerprintAuthorizationComparisonValue(
  encodedKey: string,
  value: string | Uint8Array,
): Promise<string> {
  return (await comparisonSigner(encodedKey))(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

interface GraphQLProtocolMetadata {
  protocol: 'graphql';
  operationFingerprint: string;
  operationNames: string[];
}

function graphqlPersistedQueryHash(value: Record<string, unknown>): string {
  const extensions = value.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return '';
  const persisted = (extensions as Record<string, unknown>).persistedQuery;
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return '';
  const hash = (persisted as Record<string, unknown>).sha256Hash;
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : '';
}

function looksLikeGraphQLDocument(value: string): boolean {
  const normalized = value
    .replace(/^\uFEFF/, '')
    .replace(/(?:^|\n)\s*#[^\n]*/g, '\n')
    .trimStart();
  return /^(?:query|mutation|subscription|fragment)\b/.test(normalized)
    || normalized.startsWith('{');
}

function displayGraphQLOperationName(value: unknown, index: number): string {
  if (typeof value !== 'string') return `anonymous-${index + 1}`;
  const normalized = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(normalized)
    ? normalized
    : `anonymous-${index + 1}`;
}

async function graphqlProtocolMetadata(value: unknown): Promise<GraphQLProtocolMetadata | undefined> {
  const operations = Array.isArray(value) ? value : [value];
  if (!operations.length) return undefined;
  if (operations.length > MAX_GRAPHQL_OPERATIONS) {
    const allGraphQL = operations.every((operation) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
      const envelope = operation as Record<string, unknown>;
      return (
        typeof envelope.query === 'string'
        && looksLikeGraphQLDocument(envelope.query)
      ) || Boolean(graphqlPersistedQueryHash(envelope));
    });
    if (!allGraphQL) return undefined;
    const serialized = JSON.stringify(value);
    return {
      protocol: 'graphql',
      operationFingerprint: `sha256:${await sha256(serialized)}`,
      operationNames: [`batch-overflow-${operations.length}`],
    };
  }
  const descriptors: Array<{
    operationNameFingerprint: string;
    queryFingerprint: string;
    persistedQueryFingerprint: string;
  }> = [];
  const operationNames: string[] = [];
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
    const envelope = operation as Record<string, unknown>;
    const query = typeof envelope.query === 'string'
      && looksLikeGraphQLDocument(envelope.query)
      ? envelope.query
      : '';
    const persistedQueryHash = graphqlPersistedQueryHash(envelope);
    if (!query && !persistedQueryHash) return undefined;
    const operationName = typeof envelope.operationName === 'string'
      ? envelope.operationName
      : '';
    descriptors.push({
      operationNameFingerprint: await sha256(operationName),
      queryFingerprint: query ? await sha256(query.replace(/\r\n?/g, '\n').trim()) : '',
      persistedQueryFingerprint: persistedQueryHash ? await sha256(persistedQueryHash) : '',
    });
    operationNames.push(displayGraphQLOperationName(envelope.operationName, index));
  }
  return {
    protocol: 'graphql',
    operationFingerprint: `sha256:${await sha256(JSON.stringify({
      version: 1,
      operations: descriptors,
    }))}`,
    operationNames: operationNames.slice(0, 16),
  };
}

function category(name: string): BrowserAuthorizationFieldCategory {
  const normalized = name.toLowerCase();
  if (normalized === 'authorization'
    || normalized === 'cookie'
    || AUTHENTICATION_FIELD_PATTERN.test(normalized)) {
    return 'authentication';
  }
  if (/(csrf|xsrf)/.test(normalized)) return 'csrf';
  if (/(signature|(^|[_.-])sign(ed)?($|[_.-])|hmac)/.test(normalized)) return 'signature';
  if (/(nonce|random|request.?id|trace.?id|correlation.?id|idempotency)/.test(normalized)) return 'nonce';
  if (/(timestamp|(^|[_.-])time($|[_.-])|(^|[_.-])date($|[_.-]))/.test(normalized)) return 'timestamp';
  if (/(^|[_.\-[\]])(id|uid|user.?id|account.?id|tenant.?id|org(anization)?.?id|workspace.?id|project.?id|team.?id|customer.?id|order.?id|resource.?id|object.?id|record.?id|document.?id|file.?id|invoice.?id)($|[_.\-[\]])/.test(normalized)) {
    return 'resource';
  }
  return 'unknown';
}

function primitiveType(value: unknown): BrowserAuthorizationBaselineField['valueType'] {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function primitiveText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function field(
  location: BrowserAuthorizationBaselineField['location'],
  path: string,
  value: unknown,
  sign: (value: string | Uint8Array) => Promise<string>,
  valueType: BrowserAuthorizationBaselineField['valueType'] = primitiveType(value),
  categoryOverride?: BrowserAuthorizationFieldCategory,
): Promise<BrowserAuthorizationBaselineField> {
  const text = primitiveText(value);
  return {
    location,
    path,
    valueType,
    byteLength: new TextEncoder().encode(text).byteLength,
    valueFingerprint: await sign(text),
    category: categoryOverride ?? category(path),
  };
}

async function flattenJSON(
  value: unknown,
  sign: (value: string | Uint8Array) => Promise<string>,
): Promise<BrowserAuthorizationBaselineField[]> {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{
    value,
    path: 'body',
    depth: 0,
  }];
  const output: BrowserAuthorizationBaselineField[] = [];
  while (pending.length && output.length < MAX_AUTHORIZATION_BASELINE_FIELDS) {
    const current = pending.shift()!;
    if (current.depth > MAX_FIELD_DEPTH) continue;
    if (Array.isArray(current.value)) {
      current.value.slice(0, 50).forEach((child, index) => {
        pending.push({ value: child, path: `${current.path}[${index}]`, depth: current.depth + 1 });
      });
      continue;
    }
    if (current.value && typeof current.value === 'object') {
      Object.entries(current.value as Record<string, unknown>)
        .slice(0, 100)
        .forEach(([key, child]) => {
          pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
        });
      continue;
    }
    output.push(await field('body', current.path, current.value, sign));
  }
  return output;
}

function headerValues(lines: string[]): Array<{ name: string; value: string }> {
  const output: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    output.push({
      name: line.slice(0, separator).trim().slice(0, 512),
      value: line.slice(separator + 1).trim(),
    });
  }
  return output;
}

function indexedFieldPaths(
  entries: Array<[string, string]>,
  prefix: 'header' | 'query' | 'body',
): Array<{ path: string; value: string }> {
  const totals = new Map<string, number>();
  for (const [name] of entries) totals.set(name, (totals.get(name) || 0) + 1);
  const indexes = new Map<string, number>();
  return entries.map(([name, value]) => {
    const index = indexes.get(name) || 0;
    indexes.set(name, index + 1);
    return {
      path: totals.get(name) === 1 ? `${prefix}.${name}` : `${prefix}.${name}[${index}]`,
      value,
    };
  });
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function dynamicPathSegment(value: string): boolean {
  const decoded = decodePathSegment(value);
  return /^\d+$/.test(decoded)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)
    || /^[0-9a-f]{12,}$/i.test(decoded)
    || /^[A-Za-z0-9_-]{16,}$/.test(decoded);
}

export function normalizeAuthorizationPath(pathname: string): {
  normalized: string;
  resources: Array<{ path: string; value: string }>;
} {
  const segments = pathname.split('/').filter(Boolean);
  const resources: Array<{ path: string; value: string }> = [];
  const normalized = segments.map((segment, index) => {
    if (!dynamicPathSegment(segment)) return segment;
    resources.push({
      path: `path.segment[${index}]`,
      value: decodePathSegment(segment),
    });
    return ':resource';
  });
  return {
    normalized: `/${normalized.join('/')}`,
    resources,
  };
}

function bodyOffset(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10
      && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index + 4;
    }
  }
  throw new ExtensionError('authorization_baseline_invalid', '捕获请求缺少 HTTP Header 分隔符');
}

export async function parseAuthorizationBaselineRequest(
  rawRequestBase64: string,
  requestUrl: string,
  encodedComparisonKey: string,
): Promise<BrowserAuthorizationBaseline['request']> {
  const bytes = base64ToBytes(rawRequestBase64);
  if (!bytes.length || bytes.byteLength > MAX_AUTHORIZATION_BASELINE_BYTES) {
    throw new ExtensionError('authorization_baseline_too_large', '授权基线请求必须在 1 字节到 2 MiB 之间');
  }
  const offset = bodyOffset(bytes);
  const head = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset - 4));
  const lines = head.split('\r\n');
  const requestLine = lines.shift()?.split(/\s+/) || [];
  if (requestLine.length !== 3) {
    throw new ExtensionError('authorization_baseline_invalid', '授权基线请求行无效');
  }
  const method = requestLine[0].toUpperCase().slice(0, 32);
  const parsedUrl = new URL(requestUrl);
  const shapedPath = normalizeAuthorizationPath(parsedUrl.pathname);
  const headers = headerValues(lines);
  const contentType = headers.find((header) => header.name.toLowerCase() === 'content-type')?.value || '';
  const sign = await comparisonSigner(encodedComparisonKey);
  const fields: BrowserAuthorizationBaselineField[] = [];
  const indexedHeaders = indexedFieldPaths(
    headers.slice(0, 256).map((header) => [header.name.toLowerCase(), header.value]),
    'header',
  );
  for (const header of indexedHeaders) {
    fields.push(await field('header', header.path, header.value, sign));
  }
  for (const resource of shapedPath.resources) {
    fields.push(await field(
      'path',
      resource.path,
      resource.value,
      sign,
      primitiveType(resource.value),
      'resource',
    ));
  }
  for (const parameter of indexedFieldPaths([...parsedUrl.searchParams], 'query')) {
    if (fields.length >= MAX_AUTHORIZATION_BASELINE_FIELDS) break;
    fields.push(await field('query', parameter.path, parameter.value, sign));
  }
  const body = bytes.subarray(offset);
  let protocolMetadata: GraphQLProtocolMetadata | undefined;
  if (body.byteLength && fields.length < MAX_AUTHORIZATION_BASELINE_FIELDS) {
    if (contentType.toLowerCase().includes('json')) {
      try {
        const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        protocolMetadata = await graphqlProtocolMetadata(decoded);
        fields.push(...await flattenJSON(decoded, sign));
      } catch {
        fields.push(await field('body', 'body', bytesToHex(body), sign, 'binary'));
      }
    } else if (contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
      const params = indexedFieldPaths([
        ...new URLSearchParams(new TextDecoder().decode(body)),
      ], 'body');
      for (const parameter of params) {
        if (fields.length >= MAX_AUTHORIZATION_BASELINE_FIELDS) break;
        fields.push(await field('body', parameter.path, parameter.value, sign));
      }
    } else {
      fields.push(await field('body', 'body', bytesToHex(body), sign, 'binary'));
    }
  }
  const boundedFields = fields.slice(0, MAX_AUTHORIZATION_BASELINE_FIELDS);
  const actionShape = JSON.stringify({
    version: 2,
    method,
    origin: parsedUrl.origin,
    path: shapedPath.normalized,
    contentType: contentType.split(';')[0].trim().toLowerCase(),
    protocol: protocolMetadata?.protocol || '',
    operationFingerprint: protocolMetadata?.operationFingerprint || '',
    fields: boundedFields.map((item) => `${item.location}:${item.path}`).sort(),
  });
  return {
    method,
    url: `${parsedUrl.origin}${shapedPath.normalized}`,
    path: shapedPath.normalized,
    contentType: contentType.slice(0, 512),
    ...protocolMetadata,
    actionFingerprint: `sha256:${await sha256(actionShape)}`,
    headerNames: headers.map((header) => header.name).slice(0, 256),
    fields: boundedFields,
  };
}
