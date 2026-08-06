import type {
  BrowserAuthorizationCompiledRequest,
  BrowserAuthorizationResourceSelector,
  BrowserAuthorizationResourceValue,
  BrowserTransformExecution,
  BrowserTransformPacket,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { fingerprintAuthorizationComparisonValue } from './baseline-metadata';
import {
  replaceStructuredAuthorizationBodyValue,
} from './structured-body';

const MAX_RESOURCE_VALUE_BYTES = 8 * 1_024;

interface ParsedAuthorizationRequest {
  method: string;
  requestTarget: string;
  protocol: string;
  headers: Array<{ name: string; value: string }>;
  bytes: Uint8Array;
  bodyOffset: number;
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ExtensionError('authorization_value_invalid', '授权资源值不是有效的 Base64');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function packetBodyOffset(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10
      && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index + 4;
    }
  }
  throw new ExtensionError('authorization_baseline_invalid', '授权基线缺少 HTTP Header 分隔符');
}

export function parseAuthorizationRequestPacket(
  rawRequestBase64: string,
): ParsedAuthorizationRequest {
  const bytes = base64ToBytes(rawRequestBase64);
  const offset = packetBodyOffset(bytes);
  let head: string;
  try {
    head = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset - 4));
  } catch {
    throw new ExtensionError('authorization_baseline_invalid', '授权基线请求头不是有效的 UTF-8');
  }
  const lines = head.split('\r\n');
  const requestLine = lines.shift()?.split(/\s+/) || [];
  if (requestLine.length !== 3 || !/^[A-Z]{1,16}$/.test(requestLine[0])) {
    throw new ExtensionError('authorization_baseline_invalid', '授权基线请求行无效');
  }
  const headers = lines.slice(0, 256).flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator <= 0) return [];
    const name = line.slice(0, separator).trim().slice(0, 256);
    const value = line.slice(separator + 1).trim().slice(0, 16_384);
    return name ? [{ name, value }] : [];
  });
  return {
    method: requestLine[0],
    requestTarget: requestLine[1],
    protocol: requestLine[2],
    headers,
    bytes,
    bodyOffset: offset,
  };
}

function parameterSelector(
  location: 'header' | 'query',
  path: string,
): { name: string; index?: number } {
  const prefix = `${location}.`;
  if (!path.startsWith(prefix)) {
    throw new ExtensionError('authorization_selector_invalid', '授权资源字段路径与位置不匹配');
  }
  const raw = path.slice(prefix.length);
  const indexed = raw.match(/^(.*)\[(\d+)]$/);
  const name = indexed ? indexed[1] : raw;
  const index = indexed ? Number(indexed[2]) : undefined;
  if (!name || (index !== undefined && (!Number.isSafeInteger(index) || index < 0))) {
    throw new ExtensionError('authorization_selector_invalid', '授权资源字段路径无效');
  }
  return { name, index };
}

function pathSegmentSelector(path: string): number {
  const matched = path.match(/^path\.segment\[(\d+)]$/);
  const index = matched ? Number(matched[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new ExtensionError('authorization_selector_invalid', '授权路径资源字段无效');
  }
  return index;
}

function valuesForQuery(url: URL, name: string): string[] {
  return [...url.searchParams].filter(([key]) => key === name).map(([, value]) => value);
}

export function extractAuthorizationResourceValue(
  requestUrl: string,
  rawRequestBase64: string,
  baselineId: string,
  selector: { location: 'header' | 'path' | 'query'; path: string },
  valueFingerprint: string,
): BrowserAuthorizationResourceValue {
  const url = new URL(requestUrl);
  let value: string;
  if (selector.location === 'header') {
    const selected = parameterSelector('header', selector.path);
    const values = parseAuthorizationRequestPacket(rawRequestBase64).headers
      .filter((header) => header.name.toLowerCase() === selected.name.toLowerCase())
      .map((header) => header.value);
    if (selected.index === undefined && values.length !== 1) {
      throw new ExtensionError('authorization_selector_ambiguous', '授权 Header 字段存在多个同名值，必须选择带序号的字段');
    }
    const index = selected.index ?? 0;
    if (index >= values.length) {
      throw new ExtensionError('authorization_selector_invalid', '授权 Header 资源字段不存在');
    }
    value = values[index];
  } else if (selector.location === 'path') {
    const index = pathSegmentSelector(selector.path);
    const segments = url.pathname.split('/').filter(Boolean);
    if (index >= segments.length) {
      throw new ExtensionError('authorization_selector_invalid', '授权路径资源字段不存在');
    }
    try {
      value = decodeURIComponent(segments[index]);
    } catch {
      value = segments[index];
    }
  } else {
    const selected = parameterSelector('query', selector.path);
    const values = valuesForQuery(url, selected.name);
    if (selected.index === undefined && values.length !== 1) {
      throw new ExtensionError('authorization_selector_ambiguous', '授权查询字段存在多个同名值，必须选择带序号的字段');
    }
    const index = selected.index ?? 0;
    if (index >= values.length) {
      throw new ExtensionError('authorization_selector_invalid', '授权查询资源字段不存在');
    }
    value = values[index];
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_RESOURCE_VALUE_BYTES) {
    throw new ExtensionError('authorization_value_too_large', '授权资源值超过 8 KiB 上限');
  }
  return {
    version: 1,
    baselineId,
    source: 'wire',
    location: selector.location,
    path: selector.path,
    valueType: 'string',
    byteLength: bytes.byteLength,
    valueBase64: bytesToBase64(bytes),
    valueFingerprint,
  };
}

export function replaceAuthorizationResourceValue(
  requestUrl: string,
  selector: { location: 'path' | 'query'; path: string },
  replacement: string,
): string {
  const url = new URL(requestUrl);
  if (selector.location === 'path') {
    const selectedIndex = pathSegmentSelector(selector.path);
    let currentIndex = -1;
    const segments = url.pathname.split('/');
    const next = segments.map((segment) => {
      if (!segment) return segment;
      currentIndex += 1;
      return currentIndex === selectedIndex ? encodeURIComponent(replacement) : segment;
    });
    if (currentIndex < selectedIndex) {
      throw new ExtensionError('authorization_selector_invalid', '授权路径资源字段不存在');
    }
    url.pathname = next.join('/');
    return url.toString();
  }

  const selected = parameterSelector('query', selector.path);
  const entries = [...url.searchParams];
  const matchingIndexes = entries.flatMap(([name], index) => name === selected.name ? [index] : []);
  if (selected.index === undefined && matchingIndexes.length !== 1) {
    throw new ExtensionError('authorization_selector_ambiguous', '授权查询字段存在多个同名值，必须选择带序号的字段');
  }
  const occurrence = selected.index ?? 0;
  if (occurrence >= matchingIndexes.length) {
    throw new ExtensionError('authorization_selector_invalid', '授权查询资源字段不存在');
  }
  entries[matchingIndexes[occurrence]][1] = replacement;
  url.search = '';
  for (const [name, value] of entries) url.searchParams.append(name, value);
  return url.toString();
}

export async function compileAuthorizationBaselineRequest(input: {
  baselineId: string;
  rawRequestBase64: string;
  requestUrl: string;
  publicUrl: string;
  selector: BrowserAuthorizationResourceSelector & { source: 'wire' };
  replacement: BrowserAuthorizationResourceValue;
  comparisonKey: string;
  isHttps: boolean;
}): Promise<BrowserAuthorizationCompiledRequest> {
  const packet = parseAuthorizationRequestPacket(input.rawRequestBase64);
  const method = packet.method.toUpperCase();
  if (input.replacement.source !== 'wire'
    || input.replacement.location !== input.selector.location
    || input.replacement.path !== input.selector.path
    || !['string', 'number', 'boolean'].includes(input.replacement.valueType)) {
    throw new ExtensionError('authorization_value_invalid', '授权资源值与矩阵选择器不匹配');
  }
  const replacementBytes = base64ToBytes(input.replacement.valueBase64);
  if (replacementBytes.byteLength !== input.replacement.byteLength
    || replacementBytes.byteLength > MAX_RESOURCE_VALUE_BYTES) {
    throw new ExtensionError('authorization_value_invalid', '授权资源值长度无效');
  }
  let replacementText: string;
  try {
    replacementText = new TextDecoder('utf-8', { fatal: true }).decode(replacementBytes);
  } catch {
    throw new ExtensionError('authorization_value_invalid', '授权资源值不是有效的 UTF-8 字符串');
  }
  let replacement: string | number | boolean;
  if (input.replacement.valueType === 'string') {
    replacement = replacementText;
  } else if (input.replacement.valueType === 'number') {
    try {
      const parsed: unknown = JSON.parse(replacementText);
      if (
        typeof parsed !== 'number'
        || !Number.isFinite(parsed)
        || JSON.stringify(parsed) !== replacementText
      ) {
        throw new Error('not canonical');
      }
      replacement = parsed;
    } catch {
      throw new ExtensionError('authorization_value_invalid', '授权数字资源值不是规范 JSON 数字');
    }
  } else if (replacementText === 'true' || replacementText === 'false') {
    replacement = replacementText === 'true';
  } else {
    throw new ExtensionError('authorization_value_invalid', '授权布尔资源值必须是 true 或 false');
  }
  const fingerprint = await fingerprintAuthorizationComparisonValue(
    input.comparisonKey,
    replacementText,
  );
  if (fingerprint !== input.replacement.valueFingerprint) {
    throw new ExtensionError('authorization_value_invalid', '授权资源值指纹校验失败');
  }
  const selector = input.selector;
  const selectorLocation = selector.location;
  if (selectorLocation === 'body') {
    const origin = new URL(input.requestUrl).origin;
    const transformed = replaceStructuredAuthorizationBodyValue({
      packet: authorizationRequestToTransformPacket(input.rawRequestBase64, origin),
      path: selector.path,
      replacement,
    });
    const rawBytes = base64ToBytes(input.rawRequestBase64);
    const compiled: BrowserAuthorizationCompiledRequest = {
      version: 1,
      baselineId: input.baselineId,
      selector,
      method: method as BrowserAuthorizationCompiledRequest['method'],
      url: input.publicUrl,
      isHttps: input.isHttps,
      rawRequestBase64: input.rawRequestBase64,
      resourceValueFingerprint: input.replacement.valueFingerprint,
      packetFingerprint: `sha256:${[...new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        Uint8Array.from(rawBytes).buffer,
      ))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    };
    return applyAuthorizationTransformExecution({
      compiled,
      execution: {
        profileId: 'authorization-structured-body',
        direction: 'request',
        url: transformed.url,
        bodyBase64: transformed.bodyBase64,
        setHeaders: [],
        removeHeaders: [],
        logicalInput: undefined,
        logicalOutput: undefined,
        nodeDurations: [],
        nodeTrace: [],
        fieldChanges: [],
        durationMs: 0,
      },
      origin,
      allowedDestinations: [selector.path],
      allowBody: true,
    });
  }
  if (typeof replacement !== 'string') {
    throw new ExtensionError(
      'authorization_value_invalid',
      'Header、Path 与 Query 资源替换只接受字符串',
    );
  }
  if (selectorLocation === 'header' && /[\u0000\r\n]/.test(replacement as string)) {
    throw new ExtensionError('authorization_value_invalid', '授权 Header 资源值包含非法控制字符');
  }
  const requestUrl = selectorLocation === 'header'
    ? input.requestUrl
    : replaceAuthorizationResourceValue(
      input.requestUrl,
      { location: selectorLocation, path: selector.path },
      replacement as string,
    );
  const originalOrigin = new URL(input.requestUrl).origin;
  if (new URL(requestUrl).origin !== originalOrigin) {
    throw new ExtensionError('authorization_origin_changed', '资源替换不能改变请求来源');
  }
  const url = new URL(requestUrl);
  const target = selectorLocation === 'header'
    ? packet.requestTarget
    : `${url.pathname || '/'}${url.search}`;
  const requestLine = new TextEncoder().encode(`${method} ${target} ${packet.protocol}\r\n`);
  const firstLineEnd = packet.bytes.findIndex(
    (byte, index) => byte === 13 && packet.bytes[index + 1] === 10,
  );
  if (firstLineEnd < 0 || firstLineEnd >= packet.bodyOffset - 4) {
    throw new ExtensionError('authorization_baseline_invalid', '授权基线请求行边界无效');
  }
  let remainder = packet.bytes.subarray(firstLineEnd + 2);
  if (selectorLocation === 'header') {
    const selected = parameterSelector('header', selector.path);
    const headerBytes = packet.bytes.subarray(firstLineEnd + 2, packet.bodyOffset - 4);
    const headerLines = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes).split('\r\n');
    const matching = headerLines.flatMap((line, index) => {
      const separator = line.indexOf(':');
      return separator > 0 && line.slice(0, separator).trim().toLowerCase() === selected.name.toLowerCase()
        ? [index]
        : [];
    });
    if (selected.index === undefined && matching.length !== 1) {
      throw new ExtensionError('authorization_selector_ambiguous', '授权 Header 字段存在多个同名值，必须选择带序号的字段');
    }
    const occurrence = selected.index ?? 0;
    if (occurrence >= matching.length) {
      throw new ExtensionError('authorization_selector_invalid', '授权 Header 资源字段不存在');
    }
    const lineIndex = matching[occurrence];
    const separator = headerLines[lineIndex].indexOf(':');
    headerLines[lineIndex] = `${headerLines[lineIndex].slice(0, separator)}: ${replacement as string}`;
    const rewrittenHeaders = new TextEncoder().encode(`${headerLines.join('\r\n')}\r\n\r\n`);
    const body = packet.bytes.subarray(packet.bodyOffset);
    remainder = new Uint8Array(rewrittenHeaders.byteLength + body.byteLength);
    remainder.set(rewrittenHeaders);
    remainder.set(body, rewrittenHeaders.byteLength);
  }
  const compiled = new Uint8Array(requestLine.byteLength + remainder.byteLength);
  compiled.set(requestLine);
  compiled.set(remainder, requestLine.byteLength);
  return {
    version: 1,
    baselineId: input.baselineId,
    selector,
    method: method as BrowserAuthorizationCompiledRequest['method'],
    url: input.publicUrl,
    isHttps: input.isHttps,
    rawRequestBase64: bytesToBase64(compiled),
    resourceValueFingerprint: input.replacement.valueFingerprint,
    packetFingerprint: `sha256:${[...new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(compiled).buffer,
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  };
}

function normalizedTransformDestination(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.toLowerCase().startsWith('header.')) {
    return `header.${trimmed.slice(7).trim().toLowerCase()}`;
  }
  return trimmed;
}

function queryValueMap(url: URL): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    output.set(name, [...(output.get(name) || []), value]);
  }
  return output;
}

function sameStringValues(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

export function authorizationRequestToTransformPacket(
  rawRequestBase64: string,
  origin: string,
): BrowserTransformPacket {
  const parsed = parseAuthorizationRequestPacket(rawRequestBase64);
  let url: URL;
  try {
    url = new URL(parsed.requestTarget, origin);
  } catch {
    throw new ExtensionError('authorization_baseline_invalid', '授权基线请求目标无法转换为页面报文');
  }
  if (url.origin !== origin || url.hash) {
    throw new ExtensionError('authorization_origin_changed', '授权基线请求目标超出了认证来源');
  }
  return {
    method: parsed.method,
    url: url.toString(),
    headers: parsed.headers,
    bodyBase64: bytesToBase64(parsed.bytes.subarray(parsed.bodyOffset)),
  };
}

export async function applyAuthorizationTransformExecution(input: {
  compiled: BrowserAuthorizationCompiledRequest;
  execution: BrowserTransformExecution;
  origin: string;
  allowedDestinations: string[];
  allowBody?: boolean;
}): Promise<BrowserAuthorizationCompiledRequest> {
  const packet = parseAuthorizationRequestPacket(input.compiled.rawRequestBase64);
  const baselinePacket = authorizationRequestToTransformPacket(
    input.compiled.rawRequestBase64,
    input.origin,
  );
  const allowed = new Set(input.allowedDestinations.map(normalizedTransformDestination));
  const bodyChanged = input.execution.bodyBase64 !== baselinePacket.bodyBase64;
  const bodyAllowed = input.allowBody && [...allowed].some(
    (destination) => destination === 'body'
      || destination.startsWith('body.')
      || destination.startsWith('body['),
  );
  if (bodyChanged && !bodyAllowed) {
    throw new ExtensionError(
      'authorization_transform_unsupported',
      '授权动态重算只有在逻辑明文绑定后才能改写 Body',
    );
  }
  let transformedURL: URL;
  const originalURL = new URL(baselinePacket.url);
  try {
    transformedURL = new URL(input.execution.url);
  } catch {
    throw new ExtensionError('authorization_transform_invalid', 'Transform Profile 返回了无效 URL');
  }
  if (
    transformedURL.origin !== input.origin
    || transformedURL.pathname !== originalURL.pathname
    || transformedURL.hash
  ) {
    throw new ExtensionError(
      'authorization_transform_invalid',
      '动态重算不能改变请求来源、路径或 fragment',
    );
  }
  const originalQuery = queryValueMap(originalURL);
  const transformedQuery = queryValueMap(transformedURL);
  const queryNames = new Set([...originalQuery.keys(), ...transformedQuery.keys()]);
  for (const name of queryNames) {
    if (
      !sameStringValues(originalQuery.get(name), transformedQuery.get(name))
      && !allowed.has(`query.${name}`)
    ) {
      throw new ExtensionError(
        'authorization_transform_invalid',
        `Transform Profile 改写了未声明的查询字段: ${name}`,
      );
    }
  }

  const forbiddenHeaders = new Set(['authorization', 'cookie', 'proxy-authorization', 'host']);
  const removed = new Set<string>();
  for (const name of input.execution.removeHeaders) {
    const normalized = name.trim().toLowerCase();
    if (
      forbiddenHeaders.has(normalized)
      || !allowed.has(`header.${normalized}`)
    ) {
      throw new ExtensionError(
        'authorization_transform_invalid',
        `Transform Profile 尝试删除认证材料或未声明 Header: ${name}`,
      );
    }
    removed.add(normalized);
  }
  const replacements = new Map<string, { name: string; value: string }>();
  for (const header of input.execution.setHeaders) {
    const normalized = header.name.trim().toLowerCase();
    if (
      !normalized
      || /[\r\n:]/.test(header.name)
      || /[\r\n]/.test(header.value)
      || forbiddenHeaders.has(normalized)
      || !allowed.has(`header.${normalized}`)
    ) {
      throw new ExtensionError(
        'authorization_transform_invalid',
        `Transform Profile 尝试改写认证材料或未声明 Header: ${header.name}`,
      );
    }
    replacements.set(normalized, { name: header.name.trim(), value: header.value });
    removed.delete(normalized);
  }

  let headers = packet.headers.filter(
    (header) => !removed.has(header.name.toLowerCase())
      && !replacements.has(header.name.toLowerCase()),
  );
  headers.push(...replacements.values());
  const host = headers.find((header) => header.name.toLowerCase() === 'host')?.value;
  if (!host || host !== transformedURL.host) {
    throw new ExtensionError('authorization_transform_invalid', '动态重算后的 Host 与认证来源不一致');
  }
  const body = bodyChanged
    ? base64ToBytes(input.execution.bodyBase64)
    : packet.bytes.subarray(packet.bodyOffset);
  if (body.byteLength > 2 * 1_024 * 1_024) {
    throw new ExtensionError('authorization_transform_invalid', '动态重算后的请求 Body 超过 2 MiB 上限');
  }
  if (bodyChanged) {
    headers = headers.filter((header) => {
      const name = header.name.toLowerCase();
      return name !== 'content-length' && name !== 'transfer-encoding';
    });
    headers.push({ name: 'Content-Length', value: String(body.byteLength) });
  }
  const head = [
    `${packet.method} ${transformedURL.pathname || '/'}${transformedURL.search} ${packet.protocol}`,
    ...headers.map((header) => `${header.name}: ${header.value}`),
    '',
    '',
  ].join('\r\n');
  const headBytes = new TextEncoder().encode(head);
  const raw = new Uint8Array(headBytes.byteLength + body.byteLength);
  raw.set(headBytes);
  raw.set(body, headBytes.byteLength);
  return {
    ...input.compiled,
    rawRequestBase64: bytesToBase64(raw),
    packetFingerprint: `sha256:${[...new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(raw).buffer,
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  };
}
