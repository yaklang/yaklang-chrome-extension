import type { BrowserTransformPacket } from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BODY_PATH_DEPTH = 64;

type ValuePathSegment = string | number;
export type StructuredAuthorizationPrimitive = string | number | boolean;

export interface StructuredAuthorizationBodyValue {
  value: StructuredAuthorizationPrimitive;
  valueType: 'string' | 'number' | 'boolean';
  text: string;
}

function structuredPrimitive(value: unknown): StructuredAuthorizationBodyValue {
  if (typeof value === 'string') {
    return { value, valueType: 'string', text: value };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value, valueType: 'number', text: JSON.stringify(value) };
  }
  if (typeof value === 'boolean') {
    return { value, valueType: 'boolean', text: JSON.stringify(value) };
  }
  throw new ExtensionError(
    'authorization_selector_invalid',
    '自动矩阵只接受字符串、数字或布尔 Body 资源值',
  );
}

function base64ToUTF8(value: string): string {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ExtensionError(
      'authorization_value_invalid',
      '结构化请求 Body 不是有效的 Base64',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new ExtensionError(
      'authorization_value_invalid',
      '结构化请求 Body 不是有效的 UTF-8',
    );
  }
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function packetContentType(packet: BrowserTransformPacket): string {
  return packet.headers.find((header) => header.name.toLowerCase() === 'content-type')
    ?.value.toLowerCase() || '';
}

function parseBodyPath(path: string): ValuePathSegment[] {
  if (!path.startsWith('body.') && !path.startsWith('body[')) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      '结构化 Body 资源路径必须从 body. 或 body[ 开始',
    );
  }
  const input = path.slice(4);
  const segments: ValuePathSegment[] = [];
  const pattern = /(?:^|\.)([A-Za-z0-9_-]+)|\[(\d+)]/g;
  let offset = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index !== offset) {
      throw new ExtensionError(
        'authorization_selector_invalid',
        '结构化 Body 资源路径包含不支持的字段',
      );
    }
    const segment = match[1] ?? Number(match[2]);
    if (
      typeof segment === 'string'
      && RESERVED_PATH_SEGMENTS.has(segment.toLowerCase())
    ) {
      throw new ExtensionError(
        'authorization_selector_invalid',
        '结构化 Body 资源路径包含保留字段',
      );
    }
    segments.push(segment);
    offset = match.index + match[0].length;
  }
  if (
    offset !== input.length
    || !segments.length
    || segments.length > MAX_BODY_PATH_DEPTH
  ) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      '结构化 Body 资源路径无效或过深',
    );
  }
  return segments;
}

function parseIndexedFormPath(path: string): { name: string; index?: number } {
  if (!path.startsWith('body.')) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      'Form Body 资源路径必须从 body. 开始',
    );
  }
  const raw = path.slice(5);
  const matched = raw.match(/^(.*)\[(\d+)]$/);
  const name = matched ? matched[1] : raw;
  const index = matched ? Number(matched[2]) : undefined;
  if (
    !name
    || RESERVED_PATH_SEGMENTS.has(name.toLowerCase())
    || (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
  ) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      'Form Body 资源路径无效',
    );
  }
  return { name, index };
}

function selectedFormOccurrence(
  entries: Array<[string, string]>,
  name: string,
  index?: number,
): { entryIndex: number; value: string } {
  const matches = entries.flatMap(([key, value], entryIndex) => (
    key === name ? [{ entryIndex, value }] : []
  ));
  if (index === undefined && matches.length !== 1) {
    throw new ExtensionError(
      'authorization_selector_ambiguous',
      'Form Body 存在多个同名资源字段，必须选择带序号的字段',
    );
  }
  const selected = matches[index ?? 0];
  if (!selected) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      'Form Body 资源字段不存在',
    );
  }
  return selected;
}

function readJSONBodyValue(
  packet: BrowserTransformPacket,
  path: string,
): StructuredAuthorizationBodyValue {
  let value: unknown;
  try {
    value = JSON.parse(base64ToUTF8(packet.bodyBase64));
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(
      'authorization_structured_body_invalid',
      '请求 JSON Body 无法解析',
    );
  }
  for (const segment of parseBodyPath(path)) {
    if (!value || typeof value !== 'object' || !(segment in value)) {
      throw new ExtensionError(
        'authorization_selector_invalid',
        'JSON Body 资源字段不存在',
      );
    }
    value = (value as Record<string | number, unknown>)[segment];
  }
  return structuredPrimitive(value);
}

function replaceJSONBodyValue(
  packet: BrowserTransformPacket,
  path: string,
  replacement: StructuredAuthorizationPrimitive,
): BrowserTransformPacket {
  let root: unknown;
  try {
    root = JSON.parse(base64ToUTF8(packet.bodyBase64));
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(
      'authorization_structured_body_invalid',
      '请求 JSON Body 无法解析',
    );
  }
  const segments = parseBodyPath(path);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !(segment in parent)) {
      throw new ExtensionError(
        'authorization_selector_invalid',
        'JSON Body 资源字段不存在',
      );
    }
    parent = (parent as Record<string | number, unknown>)[segment];
  }
  const leaf = segments.at(-1);
  if (
    leaf === undefined
    || !parent
    || typeof parent !== 'object'
    || !(leaf in parent)
  ) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      'JSON Body 资源字段不存在',
    );
  }
  const current = structuredPrimitive(
    (parent as Record<string | number, unknown>)[leaf],
  );
  if (current.valueType !== typeof replacement) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      'JSON Body 资源替换不能改变字段类型',
    );
  }
  (parent as Record<string | number, unknown>)[leaf] = replacement;
  return {
    ...packet,
    bodyBase64: utf8ToBase64(JSON.stringify(root)),
  };
}

export function isStructuredAuthorizationBody(packet: BrowserTransformPacket): boolean {
  const contentType = packetContentType(packet);
  return contentType.includes('json')
    || contentType.includes('application/x-www-form-urlencoded');
}

export function readStructuredAuthorizationBodyValue(
  packet: BrowserTransformPacket,
  path: string,
): StructuredAuthorizationBodyValue {
  const contentType = packetContentType(packet);
  if (contentType.includes('json')) {
    return readJSONBodyValue(packet, path);
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const selected = parseIndexedFormPath(path);
    const value = selectedFormOccurrence(
      [...new URLSearchParams(base64ToUTF8(packet.bodyBase64))],
      selected.name,
      selected.index,
    ).value;
    return { value, valueType: 'string', text: value };
  }
  throw new ExtensionError(
    'authorization_selector_invalid',
    '直接 Body 资源替换仅支持 JSON 或 Form 请求',
  );
}

export function replaceStructuredAuthorizationBodyValue(input: {
  packet: BrowserTransformPacket;
  path: string;
  replacement: StructuredAuthorizationPrimitive;
}): BrowserTransformPacket {
  const contentType = packetContentType(input.packet);
  if (contentType.includes('json')) {
    return replaceJSONBodyValue(input.packet, input.path, input.replacement);
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    if (typeof input.replacement !== 'string') {
      throw new ExtensionError(
        'authorization_selector_invalid',
        'Form Body 资源替换只接受字符串',
      );
    }
    const selected = parseIndexedFormPath(input.path);
    const entries = [...new URLSearchParams(base64ToUTF8(input.packet.bodyBase64))];
    const occurrence = selectedFormOccurrence(entries, selected.name, selected.index);
    entries[occurrence.entryIndex][1] = input.replacement;
    const form = new URLSearchParams();
    entries.forEach(([name, value]) => form.append(name, value));
    return {
      ...input.packet,
      bodyBase64: utf8ToBase64(form.toString()),
    };
  }
  throw new ExtensionError(
    'authorization_selector_invalid',
    '直接 Body 资源替换仅支持 JSON 或 Form 请求',
  );
}
