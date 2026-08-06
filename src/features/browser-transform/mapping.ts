import type {
  BrowserPageCallableExecution,
  BrowserTransformBuiltinOperation,
  BrowserTransformDirection,
  BrowserTransformExecution,
  BrowserTransformHeader,
  BrowserTransformNodeReference,
  BrowserTransformPacket,
  BrowserTransformValueSummary,
  BrowserTransformValueEncoding,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENTS = 64;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_PIPELINE_NODES = 64;
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const BUILTIN_OPERATIONS = new Set<BrowserTransformBuiltinOperation>([
  'value.literal',
  'json.stringify', 'json.parse', 'text.toString', 'url.encode', 'url.decode',
  'base64.encode', 'base64.decode', 'hex.encode', 'hex.decode',
  'object.pick', 'object.compose', 'form.compose', 'form.serialize',
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type BodyFormat = 'empty' | 'json' | 'form' | 'text';

interface TransformContext {
  method?: string;
  url: string;
  statusCode?: number;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  text: string;
  bodyBase64: string;
}

export type PageCallableInvoker = (
  callableId: string,
  args: unknown[],
) => Promise<BrowserPageCallableExecution>;

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  if (value.length > Math.ceil(MAX_BODY_BYTES / 3) * 4 + 8) {
    throw new ExtensionError('transform_body_too_large', '转换数据包 body 超过 8 MiB 限制');
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new ExtensionError('transform_invalid_body', 'Base64 数据无效'); }
  if (binary.length > MAX_BODY_BYTES) throw new ExtensionError('transform_body_too_large', '转换数据包 body 超过 8 MiB 限制');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_BODY_BYTES) throw new ExtensionError('transform_body_too_large', '页面转换结果超过 8 MiB 限制');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function headerRecord(headers: BrowserTransformHeader[]): Record<string, string> {
  const output = Object.create(null) as Record<string, string>;
  for (const header of headers) {
    output[header.name] = header.value;
    output[header.name.toLowerCase()] = header.value;
  }
  return output;
}

function queryRecord(url: string): Record<string, string | string[]> {
  const output = Object.create(null) as Record<string, string | string[]>;
  try {
    for (const [key, value] of new URL(url).searchParams) {
      const previous = output[key];
      output[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
  } catch { /* URL is validated at the protocol boundary. */ }
  return output;
}

function parseForm(text: string): Record<string, string | string[]> {
  const output = Object.create(null) as Record<string, string | string[]>;
  for (const [key, value] of new URLSearchParams(text)) {
    const previous = output[key];
    output[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return output;
}

function parseBody(bytes: Uint8Array, headers: Record<string, string>): { text: string; body: unknown; format: BodyFormat } {
  const text = decoder.decode(bytes);
  if (!text.trim()) return { text, body: '', format: 'empty' };
  try { return { text, body: JSON.parse(text) as unknown, format: 'json' }; } catch { /* Not JSON. */ }
  const contentType = headers['content-type']?.toLowerCase() || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { text, body: parseForm(text), format: 'form' };
  }
  return { text, body: text, format: 'text' };
}

function pathSegments(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$') return [];
  if (trimmed.length > MAX_PATH_LENGTH) throw new ExtensionError('transform_invalid_path', '转换值路径过长');
  const normalized = trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed;
  const segments = normalized.split('.').filter(Boolean);
  if (segments.length > MAX_PATH_SEGMENTS || segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw new ExtensionError('transform_invalid_path', `不允许的转换值路径: ${path}`);
  }
  return segments;
}

export function readTransformValue(input: unknown, path: string): unknown {
  let current = input;
  for (const segment of pathSegments(path)) {
    if (current === null || current === undefined || typeof current !== 'object') {
      throw new ExtensionError('transform_value_missing', `转换值路径不存在: ${path}`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        throw new ExtensionError('transform_value_missing', `转换值路径不存在: ${path}`);
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      throw new ExtensionError('transform_value_missing', `转换值路径不存在: ${path}`);
    }
    current = record[segment];
  }
  return current;
}

interface JsonCloneState { nodes: number; seen: WeakSet<object> }

function cloneJsonBody(value: unknown, state: JsonCloneState = { nodes: 0, seen: new WeakSet<object>() }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) throw new ExtensionError('transform_value_too_large', '转换上下文包含过多节点');
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_JSON_DEPTH) throw new ExtensionError('transform_value_too_deep', `转换上下文嵌套超过 ${MAX_JSON_DEPTH} 层`);
  if (state.seen.has(value)) throw new ExtensionError('transform_value_invalid', '转换上下文包含循环引用');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJsonBody(item, state, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!BLOCKED_PATH_SEGMENTS.has(key)) output[key] = cloneJsonBody(item, state, depth + 1);
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function writeObjectPath(input: unknown, path: string, value: unknown): unknown {
  const segments = pathSegments(path);
  if (!segments.length) return value;
  const root = cloneJsonBody(input);
  if (!root || typeof root !== 'object') throw new ExtensionError('transform_output_invalid', `目标 ${path} 需要结构化 body`);
  let current = root as Record<string, unknown> | unknown[];
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        throw new ExtensionError('transform_output_invalid', `目标数组路径不存在: ${path}`);
      }
      if (last) current[arrayIndex] = value;
      else {
        if (!current[arrayIndex] || typeof current[arrayIndex] !== 'object') current[arrayIndex] = /^\d+$/.test(segments[index + 1]) ? [] : {};
        current = current[arrayIndex] as Record<string, unknown> | unknown[];
      }
      return;
    }
    if (last) current[segment] = value;
    else {
      if (!current[segment] || typeof current[segment] !== 'object') current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
      current = current[segment] as Record<string, unknown> | unknown[];
    }
  });
  return root;
}

function bytesValue(value: unknown, encoding: BrowserTransformValueEncoding = 'auto'): Uint8Array {
  if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'bytes'
    && typeof (value as Record<string, unknown>).base64 === 'string') {
    return decodeBase64(String((value as Record<string, unknown>).base64));
  }
  if (encoding === 'base64') {
    if (typeof value !== 'string') throw new ExtensionError('transform_output_invalid', 'Base64 值必须是字符串或字节值');
    return decodeBase64(value);
  }
  if (encoding === 'json') return encoder.encode(JSON.stringify(value));
  if (typeof value === 'string') return encoder.encode(value);
  return encoder.encode(JSON.stringify(value));
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'bytes') return decoder.decode(bytesValue(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function hexEncode(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function hexDecode(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new ExtensionError('transform_builtin_invalid', 'Hex 输入无效');
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function byteResult(bytes: Uint8Array): { type: 'bytes'; byteLength: number; base64: string } {
  return { type: 'bytes', byteLength: bytes.byteLength, base64: encodeBase64(bytes) };
}

export function summarizeTransformValue(value: unknown): BrowserTransformValueSummary {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'string') return { type: 'string', byteLength: encoder.encode(value).byteLength };
  if (Array.isArray(value)) return { type: 'array', itemCount: value.length };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'bytes') {
      const byteLength = typeof record.byteLength === 'number' && Number.isSafeInteger(record.byteLength)
        ? Math.max(0, record.byteLength)
        : typeof record.base64 === 'string' ? Math.floor(record.base64.length * 0.75) : undefined;
      return { type: 'bytes', byteLength };
    }
    return { type: 'object', itemCount: Object.keys(record).length };
  }
  return { type: 'undefined' };
}

interface DifferenceBudget { compared: number; changes: number }

function equivalentTransformValue(left: unknown, right: unknown, budget: DifferenceBudget, depth = 0): boolean {
  budget.compared += 1;
  if (Object.is(left, right)) return true;
  if (budget.compared > 20_000 || depth > 16 || !left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equivalentTransformValue(item, right[index], budget, depth + 1));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => !BLOCKED_PATH_SEGMENTS.has(key)).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => !BLOCKED_PATH_SEGMENTS.has(key)).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && equivalentTransformValue(leftRecord[key], rightRecord[key], budget, depth + 1));
}

function appendTransformChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: BrowserTransformExecution['fieldChanges'],
  budget: DifferenceBudget,
  depth = 0,
): void {
  if (changes.length >= 128 || equivalentTransformValue(before, after, budget)) return;
  if (before === undefined || after === undefined) {
    changes.push({
      path,
      change: before === undefined ? 'added' : 'removed',
      before: before === undefined ? undefined : summarizeTransformValue(before),
      after: after === undefined ? undefined : summarizeTransformValue(after),
    });
    return;
  }
  if (depth < 8 && before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
      .filter((key) => !BLOCKED_PATH_SEGMENTS.has(key)).sort().slice(0, 256);
    for (const key of keys) {
      appendTransformChanges(beforeRecord[key], afterRecord[key], `${path}.${key}`, changes, budget, depth + 1);
      if (changes.length >= 128) break;
    }
    return;
  }
  changes.push({
    path,
    change: 'changed',
    before: summarizeTransformValue(before),
    after: summarizeTransformValue(after),
  });
}

function referenceLabel(reference: BrowserTransformNodeReference): string {
  return `${reference.nodeId}${reference.path ? `.${reference.path}` : ''}`;
}

function optionStrings(options: Record<string, unknown> | undefined, key: string, max = 64): string[] {
  const value = options?.[key];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string')) {
    throw new ExtensionError('transform_builtin_invalid', `内置操作需要字符串数组 options.${key}`);
  }
  return value as string[];
}

function executeBuiltin(operation: BrowserTransformBuiltinOperation, inputs: unknown[], options?: Record<string, unknown>): unknown {
  if (operation === 'value.literal') {
    if (inputs.length) throw new ExtensionError('transform_builtin_invalid', '固定值操作不接受输入');
    const value = options?.value;
    if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
      throw new ExtensionError('transform_builtin_invalid', '固定值只允许字符串、数字、布尔值或 null');
    }
    return value;
  }
  const one = () => {
    if (inputs.length !== 1) throw new ExtensionError('transform_builtin_invalid', `${operation} 需要 1 个输入`);
    return inputs[0];
  };
  if (operation === 'json.stringify') return JSON.stringify(one());
  if (operation === 'json.parse') {
    try { return JSON.parse(stringValue(one())) as unknown; } catch { throw new ExtensionError('transform_builtin_invalid', 'JSON 输入无效'); }
  }
  if (operation === 'text.toString') return stringValue(one());
  if (operation === 'url.encode') return encodeURIComponent(stringValue(one()));
  if (operation === 'url.decode') {
    try { return decodeURIComponent(stringValue(one())); } catch { throw new ExtensionError('transform_builtin_invalid', 'URL 编码输入无效'); }
  }
  if (operation === 'base64.encode') return encodeBase64(bytesValue(one()));
  if (operation === 'base64.decode') return byteResult(decodeBase64(stringValue(one())));
  if (operation === 'hex.encode') return hexEncode(bytesValue(one()));
  if (operation === 'hex.decode') return byteResult(hexDecode(stringValue(one())));
  if (operation === 'object.pick') {
    const source = one();
    const paths = optionStrings(options, 'paths');
    const keys = Array.isArray(options?.keys) ? optionStrings(options, 'keys') : paths.map((path) => path.split('.').at(-1) || path);
    if (paths.length !== keys.length) throw new ExtensionError('transform_builtin_invalid', 'object.pick 的 paths 与 keys 数量必须一致');
    return Object.fromEntries(paths.map((path, index) => [keys[index], cloneJsonBody(readTransformValue(source, path))]));
  }
  if (operation === 'object.compose') {
    const keys = optionStrings(options, 'keys');
    if (keys.length !== inputs.length || keys.some((key) => BLOCKED_PATH_SEGMENTS.has(key))) {
      throw new ExtensionError('transform_builtin_invalid', 'object.compose 的 keys 必须与输入一一对应');
    }
    return Object.fromEntries(keys.map((key, index) => [key, cloneJsonBody(inputs[index])]));
  }
  if (operation === 'form.serialize') {
    const source = one();
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new ExtensionError('transform_builtin_invalid', 'form.serialize 需要对象输入');
    }
    const entries = Object.entries(source as Record<string, unknown>);
    if (entries.length > 64 || entries.some(([key]) => BLOCKED_PATH_SEGMENTS.has(key))) {
      throw new ExtensionError('transform_builtin_invalid', 'form.serialize 的字段数量或名称无效');
    }
    const form = new URLSearchParams();
    entries.forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => form.append(key, stringValue(item)));
      else form.append(key, stringValue(value));
    });
    return form.toString();
  }
  const keys = optionStrings(options, 'keys');
  if (keys.length !== inputs.length) throw new ExtensionError('transform_builtin_invalid', 'form.compose 的 keys 必须与输入一一对应');
  const form = new URLSearchParams();
  keys.forEach((key, index) => {
    const value = inputs[index];
    if (Array.isArray(value)) value.forEach((item) => form.append(key, stringValue(item)));
    else form.append(key, stringValue(value));
  });
  return form.toString();
}

function resolveReference(results: Map<string, unknown>, reference: BrowserTransformNodeReference): unknown {
  if (!results.has(reference.nodeId)) throw new ExtensionError('transform_pipeline_invalid', `节点引用不存在: ${reference.nodeId}`);
  const value = results.get(reference.nodeId);
  return reference.path ? readTransformValue(value, reference.path) : value;
}

function validDestination(destination: string): boolean {
  if (destination === 'body') return true;
  if (destination.startsWith('body.')) { pathSegments(destination.slice(5)); return true; }
  if (destination.toLowerCase().startsWith('header.')) return Boolean(destination.slice(7)) && !/[\r\n:]/.test(destination.slice(7));
  if (destination.startsWith('query.')) return Boolean(destination.slice(6)) && !/[\r\n&#=]/.test(destination.slice(6));
  return false;
}

export function assertTransformDirection(direction: BrowserTransformDirection): void {
  if (!direction.nodes.length || direction.nodes.length > MAX_PIPELINE_NODES) {
    throw new ExtensionError('transform_pipeline_empty', `转换 Pipeline 必须包含 1-${MAX_PIPELINE_NODES} 个节点`);
  }
  const seen = new Set<string>();
  let outputCount = 0;
  for (const node of direction.nodes) {
    if (!node.id.trim() || !node.name.trim() || seen.has(node.id)) throw new ExtensionError('transform_pipeline_invalid', `Pipeline 节点 ID 无效或重复: ${node.id}`);
    const references = node.kind === 'builtin' ? node.inputs
      : node.kind === 'page.call' ? node.arguments
        : node.kind === 'output.write' ? [node.source] : [];
    for (const reference of references) {
      if (!seen.has(reference.nodeId)) throw new ExtensionError('transform_pipeline_invalid', `节点 ${node.name} 引用了尚未产生的 ${reference.nodeId}`);
      if (reference.path) pathSegments(reference.path);
    }
    if (node.kind === 'context.read') pathSegments(node.path);
    if (node.kind === 'builtin' && !BUILTIN_OPERATIONS.has(node.operation)) throw new ExtensionError('transform_pipeline_invalid', `不支持的内置操作: ${node.operation}`);
    if (node.kind === 'page.call' && !node.callableId.trim()) throw new ExtensionError('transform_pipeline_invalid', `节点 ${node.name} 未绑定页面函数`);
    if (node.kind === 'output.write') {
      outputCount += 1;
      if (!validDestination(node.destination.trim())) throw new ExtensionError('transform_output_invalid', `不支持的输出目标: ${node.destination}`);
    }
    seen.add(node.id);
  }
  if (!outputCount) throw new ExtensionError('transform_pipeline_empty', '转换 Pipeline 缺少 output.write 节点');
}

export function wildcardUrlMatches(pattern: string, url: string): boolean {
  const value = pattern.trim();
  if (!value || value === '*') return true;
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const matcher = new RegExp(`^${escaped}$`, 'i');
  if (matcher.test(url)) return true;
  try { return matcher.test(new URL(url).pathname); } catch { return false; }
}

export function assertTransformRoute(methods: string[], urlPattern: string, packet: BrowserTransformPacket, pageOrigin?: string): void {
  if (methods.length && (!packet.method || !methods.includes(packet.method.toUpperCase()))) {
    throw new ExtensionError('transform_route_mismatch', `请求方法 ${packet.method || '(missing)'} 不匹配转换配置`);
  }
  const explicitOriginPattern = /^(?:https?|\*):\/\//i.test(urlPattern.trim());
  if (pageOrigin && !explicitOriginPattern) {
    let packetOrigin = '';
    try { packetOrigin = new URL(packet.url).origin; } catch { /* validated by protocol */ }
    if (packetOrigin !== pageOrigin) throw new ExtensionError('transform_route_mismatch', `URL 来源 ${packetOrigin || '(invalid)'} 不匹配页面来源 ${pageOrigin}`);
  }
  if (!wildcardUrlMatches(urlPattern, packet.url)) throw new ExtensionError('transform_route_mismatch', `URL 不匹配转换配置: ${packet.url}`);
}

function serializeStructuredBody(value: unknown, format: BodyFormat): Uint8Array {
  if (format === 'form') {
    const form = new URLSearchParams();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(item)) item.forEach((entry) => form.append(key, stringValue(entry)));
      else form.append(key, stringValue(item));
    }
    return encoder.encode(form.toString());
  }
  return encoder.encode(JSON.stringify(value));
}

export async function executeTransformDirection(
  profileId: string,
  directionName: 'request' | 'response',
  direction: BrowserTransformDirection,
  packet: BrowserTransformPacket,
  invoke: PageCallableInvoker,
): Promise<BrowserTransformExecution> {
  assertTransformDirection(direction);
  const started = performance.now();
  const rawBody = decodeBase64(packet.bodyBase64);
  const headers = headerRecord(packet.headers);
  const parsed = parseBody(rawBody, headers);
  const context: TransformContext = {
    method: packet.method?.toUpperCase(),
    url: packet.url,
    statusCode: packet.statusCode,
    headers,
    query: queryRecord(packet.url),
    body: parsed.body,
    text: parsed.text,
    bodyBase64: packet.bodyBase64,
  };
  const logicalInput = cloneJsonBody(context);
  const results = new Map<string, unknown>();
  const nodeDurations: Array<{ nodeId: string; durationMs: number }> = [];
  const nodeTrace: BrowserTransformExecution['nodeTrace'] = [];
  let outputBody = rawBody;
  let logicalBody = parsed.body;
  let outputUrl = packet.url;
  const setHeaders = new Map<string, BrowserTransformHeader>();
  const removeHeaders = new Map<string, string>();

  for (const node of direction.nodes) {
    const nodeStarted = performance.now();
    if (node.kind === 'context.read') {
      results.set(node.id, cloneJsonBody(readTransformValue(context, node.path)));
    } else if (node.kind === 'builtin') {
      results.set(node.id, executeBuiltin(node.operation, node.inputs.map((reference) => resolveReference(results, reference)), node.options));
    } else if (node.kind === 'page.call') {
      const execution = await invoke(node.callableId, node.arguments.map((reference) => resolveReference(results, reference)));
      results.set(node.id, execution.value);
    } else {
      const value = resolveReference(results, node.source);
      const destination = node.destination.trim();
      if (destination === 'body') {
        outputBody = bytesValue(value, node.encoding);
        logicalBody = value;
      } else if (destination.startsWith('body.')) {
        logicalBody = writeObjectPath(logicalBody, destination.slice(5), value);
        outputBody = serializeStructuredBody(logicalBody, parsed.format === 'form' ? 'form' : 'json');
      } else if (destination.toLowerCase().startsWith('header.')) {
        const name = destination.slice(7).trim();
        const normalized = name.toLowerCase();
        const encoded = value === undefined || value === null ? undefined
          : node.encoding === 'base64' ? encodeBase64(bytesValue(value)) : stringValue(value);
        if (encoded === undefined) {
          removeHeaders.set(normalized, name);
          setHeaders.delete(normalized);
        } else {
          if (/[\r\n]/.test(encoded)) throw new ExtensionError('transform_output_invalid', `Header ${name} 的值包含换行`);
          setHeaders.set(normalized, { name, value: encoded });
          removeHeaders.delete(normalized);
        }
      } else if (destination.startsWith('query.')) {
        const url = new URL(outputUrl);
        const key = destination.slice(6);
        if (value === undefined || value === null) url.searchParams.delete(key);
        else url.searchParams.set(key, stringValue(value));
        outputUrl = url.toString();
      }
      results.set(node.id, value);
    }
    const durationMs = Math.max(0, performance.now() - nodeStarted);
    nodeDurations.push({ nodeId: node.id, durationMs });
    const inputRefs = node.kind === 'context.read' ? [node.path]
      : node.kind === 'builtin' ? node.inputs.map(referenceLabel)
        : node.kind === 'page.call' ? node.arguments.map(referenceLabel)
          : [referenceLabel(node.source)];
    nodeTrace.push({
      nodeId: node.id,
      kind: node.kind,
      name: node.name,
      inputRefs,
      output: summarizeTransformValue(results.get(node.id)),
      durationMs,
    });
  }

  const fieldChanges: BrowserTransformExecution['fieldChanges'] = [];
  const differenceBudget: DifferenceBudget = { compared: 0, changes: 0 };
  appendTransformChanges(context.body, logicalBody, 'body', fieldChanges, differenceBudget);
  appendTransformChanges(context.query, queryRecord(outputUrl), 'query', fieldChanges, differenceBudget);
  const headerDestinations = new Set(direction.nodes.flatMap((node) => (
    node.kind === 'output.write' && node.destination.toLowerCase().startsWith('header.')
      ? [node.destination.slice(7).trim().toLowerCase()]
      : []
  )));
  for (const name of [...headerDestinations].sort()) {
    const before = context.headers[name];
    const after = removeHeaders.has(name) ? undefined : setHeaders.get(name)?.value ?? before;
    appendTransformChanges(before, after, `header.${name}`, fieldChanges, differenceBudget);
  }

  return {
    profileId,
    direction: directionName,
    url: outputUrl,
    bodyBase64: encodeBase64(outputBody),
    setHeaders: [...setHeaders.values()],
    removeHeaders: [...removeHeaders.values()],
    logicalInput,
    logicalOutput: cloneJsonBody({ url: outputUrl, body: logicalBody, nodes: Object.fromEntries(results) }),
    nodeDurations,
    nodeTrace,
    fieldChanges,
    durationMs: Math.max(0, performance.now() - started),
  };
}
