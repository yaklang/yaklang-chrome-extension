import type {
  BrowserAuthorizationBaseline,
  BrowserAuthorizationLogicalRequestBinding,
  BrowserAuthorizationResourceSelector,
  BrowserAuthorizationResourceValue,
  BrowserTransformExecution,
  BrowserTransformPacket,
  BrowserTransformProfile,
} from '@/types/models';
import {
  applyTransformExecution,
  compareBrowserPackets,
} from '@/features/browser-analysis/service';
import {
  browserTransformReplayDraftToPacket,
  getBrowserTransformReplayDraft,
  type BrowserTransformReplayDraft,
} from '@/features/browser-transform/replay-draft';
import {
  executeBrowserTransform,
  getBrowserTransformProfile,
} from '@/features/browser-transform/service';
import { ExtensionError } from '@/shared/errors';
import {
  fingerprintAuthorizationComparisonValue,
  parseAuthorizationBaselineRequest,
} from './baseline-metadata';
import {
  authorizationRequestToTransformPacket,
} from './baseline-execution';
import {
  readStructuredAuthorizationBodyValue,
  replaceStructuredAuthorizationBodyValue,
  type StructuredAuthorizationPrimitive,
} from './structured-body';

const MAX_LOGICAL_RESOURCE_BYTES = 8 * 1_024;
const MAX_TRANSFORM_BODY_BYTES = 2 * 1_024 * 1_024;
const FORBIDDEN_OUTPUT_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
]);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ExtensionError('authorization_value_invalid', '逻辑请求 Body 不是有效的 Base64');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function normalizedDestination(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.toLowerCase().startsWith('header.')) {
    return `header.${trimmed.slice(7).trim().toLowerCase()}`;
  }
  return trimmed;
}

export function authorizationTransformOutputDestinations(
  profile: BrowserTransformProfile,
): string[] {
  if (!profile.enabled || !profile.request.enabled) {
    throw new ExtensionError('authorization_transform_unavailable', '所选明文网关未启用请求转换');
  }
  if (profile.recovery && profile.recovery.state !== 'ready') {
    throw new ExtensionError('authorization_transform_stale', '所选明文网关正在等待文档恢复或重新验证');
  }
  const destinations = [...new Set(profile.request.nodes.flatMap((node) => {
    if (node.kind !== 'output.write') return [];
    const destination = normalizedDestination(node.destination);
    if (destination.toLowerCase().startsWith('header.')) {
      const name = destination.slice(7).toLowerCase();
      if (FORBIDDEN_OUTPUT_HEADERS.has(name)) {
        throw new ExtensionError(
          'authorization_transform_invalid',
          `授权明文网关不能生成或覆盖认证 Header: ${name}`,
        );
      }
    }
    return [destination];
  }))].sort();
  if (!destinations.length || destinations.length > 32) {
    throw new ExtensionError(
      'authorization_transform_invalid',
      '授权明文网关必须声明 1 到 32 个确定性请求输出',
    );
  }
  return destinations;
}

export function authorizationTransformPacketToRawRequest(
  packet: BrowserTransformPacket,
): string {
  const method = packet.method?.trim().toUpperCase() || '';
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new ExtensionError('authorization_logical_invalid', '逻辑请求缺少有效的 HTTP 方法');
  }
  let url: URL;
  try {
    url = new URL(packet.url);
  } catch {
    throw new ExtensionError('authorization_logical_invalid', '逻辑请求 URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash) {
    throw new ExtensionError('authorization_logical_invalid', '逻辑请求必须使用无 fragment 的 HTTP(S) URL');
  }
  const headers = packet.headers.filter((header) => header.name.toLowerCase() !== 'host');
  for (const header of headers) {
    if (
      !header.name
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name)
      || /[\r\n]/.test(header.value)
    ) {
      throw new ExtensionError('authorization_logical_invalid', `逻辑请求包含无效 Header: ${header.name}`);
    }
  }
  const body = base64ToBytes(packet.bodyBase64);
  if (body.byteLength > MAX_TRANSFORM_BODY_BYTES) {
    throw new ExtensionError('authorization_logical_invalid', '逻辑请求 Body 超过 2 MiB 上限');
  }
  const head = new TextEncoder().encode([
    `${method} ${url.pathname || '/'}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    ...headers.map((header) => `${header.name}: ${header.value}`),
    '',
    '',
  ].join('\r\n'));
  const raw = new Uint8Array(head.byteLength + body.byteLength);
  raw.set(head);
  raw.set(body, head.byteLength);
  return bytesToBase64(raw);
}

function sameTarget(
  baseline: BrowserAuthorizationBaseline,
  profile: BrowserTransformProfile,
): boolean {
  return profile.target.tabId === baseline.target.tabId
    && profile.target.frameId === baseline.target.frameId
    && profile.target.documentId === baseline.target.documentId
    && profile.origin === baseline.origin
    && profile.isolationContextId === baseline.isolationContextId
    && profile.cookieStoreId === baseline.cookieStoreId;
}

function assertLogicalProfileIdentity(
  baseline: BrowserAuthorizationBaseline,
  profile: BrowserTransformProfile,
): void {
  if (!sameTarget(baseline, profile)) {
    throw new ExtensionError(
      'authorization_transform_target_mismatch',
      '逻辑明文必须使用授权基线所属同一身份、Frame 与页面文档的明文网关',
    );
  }
}

function assertGeneratedRoute(
  baseline: BrowserAuthorizationBaseline,
  execution: BrowserTransformExecution,
): void {
  let generated: URL;
  try {
    generated = new URL(execution.url);
  } catch {
    throw new ExtensionError('authorization_transform_invalid', '明文网关生成了无效 URL');
  }
  // The structural packet comparison below performs the exact route check.
  // This early guard blocks obvious origin/fragment escapes before comparison.
  if (generated.origin !== baseline.origin || generated.hash) {
    throw new ExtensionError('authorization_origin_changed', '明文网关不能改变授权请求来源或 fragment');
  }
}

function assertIdentityContentEncoding(
  packet: BrowserTransformPacket,
  label: string,
): void {
  const encodings = packet.headers
    .filter((header) => header.name.toLowerCase() === 'content-encoding')
    .flatMap((header) => header.value.split(','))
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.some((encoding) => encoding !== 'identity')) {
    throw new ExtensionError(
      'authorization_content_encoding_unsupported',
      `${label}使用了压缩或编码后的请求 Body，当前不能建立可验证的逻辑明文绑定`,
    );
  }
}

export function assertAuthorizationLogicalPacketStructure(
  generated: BrowserTransformPacket,
  observed: BrowserTransformPacket,
): { summary: string; warnings: string[] } {
  assertIdentityContentEncoding(generated, '明文网关生成报文');
  assertIdentityContentEncoding(observed, '线上基线');
  const comparison = compareBrowserPackets(generated, observed, 'structure');
  if (!comparison.equivalent) {
    const failures = comparison.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.label.replace(/一致$/, ''))
      .join('、');
    throw new ExtensionError(
      'authorization_logical_mismatch',
      `明文网关生成报文与线上基线结构不一致：${failures || comparison.summary}`,
    );
  }
  return {
    summary: comparison.summary,
    warnings: comparison.checks
      .filter((check) => check.status === 'warning')
      .map((check) => check.label),
  };
}

export function assertAuthorizationLogicalProtocol(
  observed: BrowserAuthorizationBaseline['request'],
  logical: BrowserAuthorizationBaseline['request'],
): void {
  if (
    observed.protocol
    && (
      logical.protocol !== observed.protocol
      || logical.operationFingerprint !== observed.operationFingerprint
    )
  ) {
    throw new ExtensionError(
      'authorization_logical_mismatch',
      '明文网关回放的 GraphQL operation 与线上基线不一致',
    );
  }
}

export async function buildAuthorizationLogicalRequestBinding(input: {
  baseline: BrowserAuthorizationBaseline;
  rawRequestBase64: string;
  profile: BrowserTransformProfile;
  draft: BrowserTransformReplayDraft;
  comparisonKey: string;
}): Promise<BrowserAuthorizationLogicalRequestBinding> {
  assertLogicalProfileIdentity(input.baseline, input.profile);
  if (
    input.draft.profileId !== input.profile.id
    || input.draft.direction !== 'request'
    || input.draft.origin !== input.baseline.origin
  ) {
    throw new ExtensionError(
      'authorization_logical_invalid',
      '所选明文网关没有与当前身份来源匹配的本机请求回放草稿',
    );
  }
  const logicalPacket = browserTransformReplayDraftToPacket(input.draft);
  const execution = await executeBrowserTransform({
    profileId: input.profile.id,
    direction: 'request',
    packet: logicalPacket,
  });
  assertGeneratedRoute(input.baseline, execution);
  const generated = applyTransformExecution(logicalPacket, execution);
  const observed = authorizationRequestToTransformPacket(
    input.rawRequestBase64,
    input.baseline.origin,
  );
  const validation = assertAuthorizationLogicalPacketStructure(generated, observed);
  const request = await parseAuthorizationBaselineRequest(
    authorizationTransformPacketToRawRequest(logicalPacket),
    logicalPacket.url,
    input.comparisonKey,
  );
  assertAuthorizationLogicalProtocol(input.baseline.request, request);
  const outputDestinations = authorizationTransformOutputDestinations(input.profile);
  const createdAt = Date.now();
  const bindingFingerprint = await sha256(JSON.stringify({
    version: 1,
    baselineId: input.baseline.id,
    profileId: input.profile.id,
    profileUpdatedAt: input.profile.updatedAt,
    replayUpdatedAt: input.draft.updatedAt,
    isolationContextId: input.baseline.isolationContextId,
    cookieStoreId: input.baseline.cookieStoreId,
    documentId: input.baseline.target.documentId,
    actionFingerprint: request.actionFingerprint,
    fields: request.fields.map((field) => ({
      location: field.location,
      path: field.path,
      valueType: field.valueType,
      valueFingerprint: field.valueFingerprint,
    })),
    outputDestinations,
    warnings: validation.warnings,
  }));
  return {
    version: 1,
    source: 'local-replay-draft',
    baselineId: input.baseline.id,
    profileId: input.profile.id,
    profileName: input.profile.name,
    isolationContextId: input.baseline.isolationContextId,
    cookieStoreId: input.baseline.cookieStoreId,
    target: input.baseline.target,
    origin: input.baseline.origin,
    request,
    outputDestinations,
    validation: {
      proofLevel: 'structure',
      summary: validation.summary,
      warnings: validation.warnings,
    },
    bindingFingerprint,
    profileUpdatedAt: input.profile.updatedAt,
    replayUpdatedAt: input.draft.updatedAt,
    createdAt,
    expiresAt: input.baseline.expiresAt,
  };
}

export async function loadAuthorizationLogicalRequestBinding(input: {
  baseline: BrowserAuthorizationBaseline;
  profileId?: string;
}): Promise<{
  binding: BrowserAuthorizationLogicalRequestBinding;
  profile: BrowserTransformProfile;
  draft: BrowserTransformReplayDraft;
}> {
  const binding = input.baseline.logicalRequest;
  if (!binding || (input.profileId && binding.profileId !== input.profileId)) {
    throw new ExtensionError('authorization_logical_missing', '授权基线尚未绑定逻辑明文请求');
  }
  const profile = await getBrowserTransformProfile(binding.profileId);
  assertLogicalProfileIdentity(input.baseline, profile);
  const draft = await getBrowserTransformReplayDraft(profile.id, 'request', input.baseline.origin);
  if (
    !draft
    || profile.updatedAt !== binding.profileUpdatedAt
    || draft.updatedAt !== binding.replayUpdatedAt
    || binding.baselineId !== input.baseline.id
    || binding.bindingFingerprint.length !== 71
  ) {
    throw new ExtensionError(
      'authorization_logical_changed',
      '明文网关或本机回放草稿已变化，请重新绑定逻辑明文',
    );
  }
  return { binding, profile, draft };
}

function indexedName(path: string, prefix: 'header' | 'query' | 'body'): {
  name: string;
  index?: number;
} {
  if (!path.startsWith(`${prefix}.`)) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源字段路径与位置不匹配');
  }
  const raw = path.slice(prefix.length + 1);
  const matched = raw.match(/^(.*)\[(\d+)]$/);
  const name = matched ? matched[1] : raw;
  const index = matched ? Number(matched[2]) : undefined;
  if (!name || (index !== undefined && !Number.isSafeInteger(index))) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源字段路径无效');
  }
  return { name, index };
}

function selectedOccurrence(
  entries: Array<[string, string]>,
  name: string,
  index?: number,
): { entryIndex: number; value: string } {
  const matches = entries.flatMap(([key, value], entryIndex) => (
    key === name ? [{ entryIndex, value }] : []
  ));
  if (index === undefined && matches.length !== 1) {
    throw new ExtensionError('authorization_selector_ambiguous', '逻辑资源字段存在多个同名值，必须选择带序号的字段');
  }
  const selected = matches[index ?? 0];
  if (!selected) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源字段不存在');
  }
  return selected;
}

function logicalResourceText(
  packet: BrowserTransformPacket,
  selector: BrowserAuthorizationResourceSelector,
): string {
  if (selector.source !== 'logical') {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源读取器只接受 logical 选择器');
  }
  if (selector.location === 'body') {
    throw new ExtensionError(
      'authorization_selector_invalid',
      '逻辑 Body 资源必须通过结构化读取器读取',
    );
  }
  if (selector.location === 'query') {
    const selected = indexedName(selector.path, 'query');
    return selectedOccurrence(
      [...new URL(packet.url).searchParams],
      selected.name,
      selected.index,
    ).value;
  }
  if (selector.location === 'header') {
    const selected = indexedName(selector.path, 'header');
    return selectedOccurrence(
      packet.headers.map((header) => [header.name.toLowerCase(), header.value]),
      selected.name.toLowerCase(),
      selected.index,
    ).value;
  }
  const matched = selector.path.match(/^path\.segment\[(\d+)]$/);
  const index = matched ? Number(matched[1]) : -1;
  const segment = new URL(packet.url).pathname.split('/').filter(Boolean)[index];
  if (segment === undefined) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑路径资源字段不存在');
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function readAuthorizationLogicalResource(input: {
  baseline: BrowserAuthorizationBaseline;
  selector: BrowserAuthorizationResourceSelector;
}): Promise<BrowserAuthorizationResourceValue> {
  const { binding, draft } = await loadAuthorizationLogicalRequestBinding({
    baseline: input.baseline,
  });
  const packet = browserTransformReplayDraftToPacket(draft);
  const value = (() => {
    if (input.selector.location === 'body') {
      return readStructuredAuthorizationBodyValue(packet, input.selector.path);
    }
    const text = logicalResourceText(packet, input.selector);
    return { value: text, valueType: 'string' as const, text };
  })();
  const bytes = new TextEncoder().encode(value.text);
  if (bytes.byteLength > MAX_LOGICAL_RESOURCE_BYTES) {
    throw new ExtensionError('authorization_value_too_large', '逻辑授权资源值超过 8 KiB 上限');
  }
  const field = binding.request.fields.filter((candidate) => (
    candidate.location === input.selector.location
    && candidate.path === input.selector.path
  ));
  if (
    field.length !== 1
    || !['string', 'number', 'boolean'].includes(field[0].valueType)
    || field[0].valueType !== value.valueType
  ) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源字段不属于当前明文绑定');
  }
  return {
    version: 1,
    baselineId: input.baseline.id,
    source: 'logical',
    location: input.selector.location,
    path: input.selector.path,
    valueType: value.valueType,
    byteLength: bytes.byteLength,
    valueBase64: bytesToBase64(bytes),
    valueFingerprint: field[0].valueFingerprint,
    logicalBindingFingerprint: binding.bindingFingerprint,
  };
}

export function replaceAuthorizationLogicalResource(input: {
  packet: BrowserTransformPacket;
  selector: BrowserAuthorizationResourceSelector;
  replacement: StructuredAuthorizationPrimitive;
}): BrowserTransformPacket {
  const { packet, selector, replacement } = input;
  if (selector.source !== 'logical') {
    throw new ExtensionError('authorization_selector_invalid', '逻辑资源替换器只接受 logical 选择器');
  }
  if (selector.location === 'body') {
    return replaceStructuredAuthorizationBodyValue({
      packet,
      path: selector.path,
      replacement,
    });
  }
  if (selector.location === 'query') {
    if (typeof replacement !== 'string') {
      throw new ExtensionError('authorization_selector_invalid', '逻辑 Query 资源替换只接受字符串');
    }
    const selected = indexedName(selector.path, 'query');
    const url = new URL(packet.url);
    const entries = [...url.searchParams];
    const occurrence = selectedOccurrence(entries, selected.name, selected.index);
    entries[occurrence.entryIndex][1] = replacement;
    url.search = '';
    entries.forEach(([name, value]) => url.searchParams.append(name, value));
    return { ...packet, url: url.toString() };
  }
  if (selector.location === 'header') {
    if (typeof replacement !== 'string') {
      throw new ExtensionError('authorization_selector_invalid', '逻辑 Header 资源替换只接受字符串');
    }
    const selected = indexedName(selector.path, 'header');
    const matching = packet.headers.flatMap((header, index) => (
      header.name.toLowerCase() === selected.name.toLowerCase() ? [index] : []
    ));
    if (selected.index === undefined && matching.length !== 1) {
      throw new ExtensionError('authorization_selector_ambiguous', '逻辑 Header 存在多个同名值');
    }
    const headerIndex = matching[selected.index ?? 0];
    if (headerIndex === undefined) {
      throw new ExtensionError('authorization_selector_invalid', '逻辑 Header 资源字段不存在');
    }
    const headers = packet.headers.slice();
    headers[headerIndex] = { ...headers[headerIndex], value: replacement };
    return { ...packet, headers };
  }
  const matched = selector.path.match(/^path\.segment\[(\d+)]$/);
  if (typeof replacement !== 'string') {
    throw new ExtensionError('authorization_selector_invalid', '逻辑 Path 资源替换只接受字符串');
  }
  const index = matched ? Number(matched[1]) : -1;
  const url = new URL(packet.url);
  let current = -1;
  const segments = url.pathname.split('/').map((segment) => {
    if (!segment) return segment;
    current += 1;
    return current === index ? encodeURIComponent(replacement) : segment;
  });
  if (current < index || index < 0) {
    throw new ExtensionError('authorization_selector_invalid', '逻辑路径资源字段不存在');
  }
  url.pathname = segments.join('/');
  return { ...packet, url: url.toString() };
}

export async function decodeAndVerifyLogicalReplacement(input: {
  replacement: BrowserAuthorizationResourceValue;
  selector: BrowserAuthorizationResourceSelector;
  comparisonKey: string;
}): Promise<StructuredAuthorizationPrimitive> {
  if (
    input.replacement.source !== 'logical'
    || input.replacement.location !== input.selector.location
    || input.replacement.path !== input.selector.path
    || !['string', 'number', 'boolean'].includes(input.replacement.valueType)
  ) {
    throw new ExtensionError('authorization_value_invalid', '逻辑授权资源值与选择器不匹配');
  }
  const bytes = base64ToBytes(input.replacement.valueBase64);
  if (
    bytes.byteLength !== input.replacement.byteLength
    || bytes.byteLength > MAX_LOGICAL_RESOURCE_BYTES
  ) {
    throw new ExtensionError('authorization_value_invalid', '逻辑授权资源值长度无效');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ExtensionError('authorization_value_invalid', '逻辑授权资源值不是有效的 UTF-8');
  }
  let value: StructuredAuthorizationPrimitive;
  if (input.replacement.valueType === 'string') {
    value = text;
  } else if (input.replacement.valueType === 'number') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed !== 'number'
        || !Number.isFinite(parsed)
        || JSON.stringify(parsed) !== text
      ) {
        throw new Error('not canonical');
      }
      value = parsed;
    } catch {
      throw new ExtensionError(
        'authorization_value_invalid',
        '逻辑授权数字资源值不是规范 JSON 数字',
      );
    }
  } else if (text === 'true' || text === 'false') {
    value = text === 'true';
  } else {
    throw new ExtensionError(
      'authorization_value_invalid',
      '逻辑授权布尔资源值必须是 true 或 false',
    );
  }
  const fingerprint = await fingerprintAuthorizationComparisonValue(input.comparisonKey, text);
  if (fingerprint !== input.replacement.valueFingerprint) {
    throw new ExtensionError('authorization_value_invalid', '逻辑授权资源值指纹校验失败');
  }
  return value;
}

export async function authorizationPacketFingerprint(rawRequestBase64: string): Promise<string> {
  return sha256(base64ToBytes(rawRequestBase64));
}
