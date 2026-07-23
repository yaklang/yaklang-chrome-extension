import * as v from 'valibot';

const id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const frameId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const documentId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const blockedPathSegments = new Set(['__proto__', 'prototype', 'constructor']);

function isSafeValuePath(value: string): boolean {
  if (value === '$') return true;
  const normalized = value.startsWith('$.') ? value.slice(2) : value;
  if (!normalized || normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) return false;
  const segments = normalized.split('.');
  return segments.length <= 64 && segments.every((segment) => segment.length > 0 && !blockedPathSegments.has(segment));
}

function isOutputDestination(value: string): boolean {
  if (value === 'body') return true;
  if (value.startsWith('body.')) return isSafeValuePath(value.slice(5));
  if (value.toLowerCase().startsWith('header.')) {
    const name = value.slice(7);
    return Boolean(name) && !/[\r\n:]/.test(name);
  }
  if (value.startsWith('query.')) {
    const name = value.slice(6);
    return Boolean(name) && !/[\r\n&#=]/.test(name);
  }
  return false;
}

const valuePath = v.pipe(
  v.string(), v.trim(), v.minLength(1), v.maxLength(512),
  v.check(isSafeValuePath, '转换值路径无效或包含保留字段'),
);
const httpOrigin = v.pipe(
  v.string(),
  v.trim(),
  v.url(),
  v.maxLength(2_048),
  v.check((value) => {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value;
  }, '必须是 HTTP(S) 页面来源，不得包含路径'),
);

const target = v.strictObject({ tabId, frameId, documentId: v.optional(documentId) });
const nodeName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120));
const reference = v.strictObject({ nodeId: id, path: v.optional(valuePath) });
const contextReadNode = v.strictObject({ id, name: nodeName, kind: v.literal('context.read'), path: valuePath });
const builtinNode = v.strictObject({
  id,
  name: nodeName,
  kind: v.literal('builtin'),
  operation: v.picklist([
    'value.literal',
    'json.stringify', 'json.parse', 'text.toString', 'url.encode', 'url.decode',
    'base64.encode', 'base64.decode', 'hex.encode', 'hex.decode',
    'object.pick', 'object.compose', 'form.compose',
  ]),
  inputs: v.pipe(v.array(reference), v.maxLength(64)),
  options: v.optional(v.record(v.string(), v.unknown())),
});
const pageCallNode = v.strictObject({
  id,
  name: nodeName,
  kind: v.literal('page.call'),
  callableId: id,
  arguments: v.pipe(v.array(reference), v.maxLength(64)),
});
const outputWriteNode = v.strictObject({
  id,
  name: nodeName,
  kind: v.literal('output.write'),
  destination: v.pipe(
    v.string(), v.trim(), v.minLength(1), v.maxLength(512),
    v.check(isOutputDestination, '输出目标必须是 body、body.<path>、header.<name> 或 query.<name>'),
  ),
  source: reference,
  encoding: v.picklist(['auto', 'text', 'json', 'base64']),
});
const pipelineNode = v.union([contextReadNode, builtinNode, pageCallNode, outputWriteNode]);
const direction = v.pipe(
  v.strictObject({
    enabled: v.boolean(),
    nodes: v.pipe(v.array(pipelineNode), v.maxLength(64)),
  }),
  v.check((value) => !value.enabled || value.nodes.length > 0, '启用的转换方向必须包含 Pipeline 节点'),
  v.check((value) => new Set(value.nodes.map((item) => item.id)).size === value.nodes.length, '同一转换方向不能包含重复节点 ID'),
  v.check((value) => !value.enabled || value.nodes.some((item) => item.kind === 'output.write'), '启用的转换方向必须包含输出节点'),
);

const profileFields = {
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  enabled: v.boolean(),
  target,
  origin: httpOrigin,
  match: v.strictObject({
    methods: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))), v.maxLength(16)),
    urlPattern: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
  }),
  request: direction,
  response: direction,
  failMode: v.literal('closed'),
  maxConcurrency: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8)),
};

export const browserTransformProfileInputSchema = v.strictObject({
  id: v.optional(id),
  ...profileFields,
});

export const browserTransformProfileSchema = v.strictObject({
  id,
  ...profileFields,
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

const header = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512), v.regex(/^[^\r\n:]+$/, 'Header 名称无效')),
  value: v.pipe(v.string(), v.maxLength(1_000_000)),
});

export const browserTransformExecuteSchema = v.strictObject({
  profileId: id,
  direction: v.picklist(['request', 'response']),
  packet: v.strictObject({
    method: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))),
    url: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(8_192)),
    statusCode: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(999))),
    headers: v.pipe(v.array(header), v.maxLength(512)),
    bodyBase64: v.pipe(v.string(), v.maxLength(11_184_820)),
  }),
});
