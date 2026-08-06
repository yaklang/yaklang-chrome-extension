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
    'object.pick', 'object.compose', 'form.compose', 'form.serialize',
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

const recoveryFrameHint = v.strictObject({
  functionName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
  url: v.optional(v.pipe(v.string(), v.maxLength(4_096))),
  support: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)),
  averageDepth: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)),
});
const recoveryTransaction = v.strictObject({
  version: v.literal(2),
  prerequisites: v.pipe(v.array(v.strictObject({
    boundary: v.literal('fetch'),
    method: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32)),
    url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)),
    requestBodyFormat: v.picklist(['none', 'json', 'form', 'raw']),
    maxRequestBodyBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(8 * 1_024 * 1_024)),
    response: v.strictObject({
      statusCode: v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(599)),
      url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)),
      bodyFormat: v.picklist(['json', 'form', 'raw']),
      maxBodyBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8 * 1_024 * 1_024)),
      requiredPaths: v.pipe(v.array(valuePath), v.minLength(1), v.maxLength(64)),
    }),
  })), v.maxLength(4)),
  request: v.strictObject({
    boundary: v.picklist(['fetch', 'xhr', 'beacon', 'form']),
    method: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32)),
    url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)),
    expectedDestinations: v.pipe(v.array(valuePath), v.minLength(1), v.maxLength(64)),
    bodyFormat: v.picklist(['json', 'form', 'raw']),
  }),
  inputMode: v.literal('auto'),
});
const recoveryGuide = v.strictObject({
  direction: v.picklist(['request', 'response']),
  callableId: id,
  inputPaths: v.pipe(v.array(valuePath), v.maxLength(64)),
  resultPath: v.optional(valuePath),
  outputKind: v.picklist(['body', 'json-field', 'form-field', 'header', 'query']),
  outputField: v.pipe(v.string(), v.maxLength(512)),
  setFormContentType: v.boolean(),
});
const recoveryBinding = v.strictObject({
  callableId: id,
  name: nodeName,
  kind: v.picklist(['recorded-call', 'business-closure', 'request-transaction', 'global-function']),
  operation: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
  nodeIds: v.pipe(v.array(v.strictObject({
    direction: v.picklist(['request', 'response']),
    nodeId: id,
  })), v.minLength(1), v.maxLength(128)),
  inputSemantics: v.pipe(v.array(v.strictObject({
    id: v.pipe(v.string(), v.maxLength(120)),
    name: v.pipe(v.string(), v.maxLength(120)),
    index: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(63)),
    role: v.picklist(['data', 'key', 'iv', 'algorithm', 'options', 'signature', 'salt', 'nonce', 'aad', 'unknown']),
    dataType: v.pipe(v.string(), v.maxLength(120)),
    required: v.boolean(),
    retained: v.boolean(),
  })), v.maxLength(64)),
  output: v.strictObject({
    dataType: v.pipe(v.string(), v.maxLength(120)),
    encoding: v.picklist(['auto', 'utf8', 'hex', 'base64', 'json']),
    shape: v.picklist(['value', 'envelope']),
    paths: v.pipe(v.array(valuePath), v.maxLength(64)),
  }),
  guides: v.pipe(v.array(recoveryGuide), v.maxLength(2)),
  frameHints: v.pipe(v.array(recoveryFrameHint), v.maxLength(16)),
  transaction: v.optional(recoveryTransaction),
});
const recoveryCapture = v.strictObject({
  kind: v.literal('request'),
  method: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32)),
  url: v.pipe(v.string(), v.maxLength(4_096)),
  urlPattern: v.pipe(v.string(), v.maxLength(2_048)),
  expectedDestinations: v.pipe(v.array(valuePath), v.maxLength(64)),
  bodyFormat: v.picklist(['json', 'form', 'raw']),
  frameHints: v.pipe(v.array(recoveryFrameHint), v.maxLength(16)),
  automatic: v.boolean(),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
});
const recoveryPending = v.strictObject({
  target,
  callableId: id,
  callableName: nodeName,
  request: direction,
  response: direction,
  capturedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const recoveryValidation = v.strictObject({
  id,
  proofLevel: v.literal('execution-only'),
  summary: v.pipe(v.string(), v.maxLength(500)),
  validatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const recoveryPlan = v.strictObject({
  contractVersion: v.literal(1),
  state: v.picklist(['ready', 'stale', 'capturing', 'validation-required', 'confirmation-required', 'failed']),
  desiredEnabled: v.boolean(),
  boundDocumentId: v.optional(documentId),
  binding: recoveryBinding,
  capture: recoveryCapture,
  pending: v.optional(recoveryPending),
  validation: v.optional(recoveryValidation),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

const explanationText = v.pipe(v.string(), v.maxLength(4_096));
const explanationPath = v.pipe(v.string(), v.maxLength(512));
const explanationCrypto = v.strictObject({
  adapterId: v.pipe(v.string(), v.maxLength(120)),
  providerKind: v.picklist(['native', 'library', 'business', 'wasm', 'unknown']),
  family: v.picklist(['symmetric', 'asymmetric', 'digest', 'mac', 'signature', 'kdf', 'key-management', 'unknown']),
  operation: v.pipe(v.string(), v.maxLength(240)),
  algorithm: v.optional(v.pipe(v.string(), v.maxLength(240))),
  mode: v.optional(v.pipe(v.string(), v.maxLength(120))),
  padding: v.optional(v.pipe(v.string(), v.maxLength(120))),
  inputEncoding: v.optional(v.picklist(['auto', 'utf8', 'hex', 'base64', 'json'])),
  outputEncoding: v.optional(v.picklist(['auto', 'utf8', 'hex', 'base64', 'json'])),
  state: v.optional(v.strictObject({
    model: v.picklist(['stateless', 'receiver', 'session', 'stream', 'async-ready']),
    phase: v.optional(v.picklist(['create', 'init', 'update', 'final', 'one-shot'])),
  })),
  key: v.optional(v.strictObject({
    kind: v.picklist(['public', 'private', 'secret', 'unknown']),
    bits: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1_000_000))),
  })),
});
const explanationOperation = v.strictObject({
  operation: v.pipe(v.string(), v.maxLength(240)),
  destination: v.optional(explanationPath),
  crypto: v.optional(explanationCrypto),
});
const explanationStage = v.strictObject({
  id,
  kind: v.picklist(['input', 'prerequisite', 'page-call', 'builtin', 'output', 'session', 'transport']),
  owner: v.picklist(['webfuzzer', 'extension', 'page', 'yak']),
  proof: v.picklist(['configured', 'observed', 'supported']),
  title: v.pipe(v.string(), v.maxLength(240)),
  summary: explanationText,
  nodeIds: v.pipe(v.array(id), v.maxLength(64)),
  inputPaths: v.pipe(v.array(explanationPath), v.maxLength(64)),
  outputPaths: v.pipe(v.array(explanationPath), v.maxLength(64)),
  operations: v.pipe(v.array(explanationOperation), v.maxLength(16)),
  evidence: v.pipe(v.array(v.strictObject({
    strength: v.picklist(['proven', 'supported']),
    label: v.pipe(v.string(), v.maxLength(500)),
  })), v.maxLength(24)),
  network: v.optional(v.strictObject({
    method: v.pipe(v.string(), v.maxLength(32)),
    route: v.pipe(v.string(), v.maxLength(2_048)),
    statusCode: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(999))),
    requiredPaths: v.pipe(v.array(explanationPath), v.maxLength(64)),
  })),
  source: v.optional(v.strictObject({
    functionName: v.optional(v.pipe(v.string(), v.maxLength(240))),
    url: v.optional(v.pipe(v.string(), v.maxLength(4_096))),
    lineNumber: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(100_000_000))),
  })),
});
const transformExplanation = v.strictObject({
  version: v.literal(1),
  directions: v.pipe(v.array(v.strictObject({
    direction: v.picklist(['request', 'response']),
    summary: explanationText,
    stages: v.pipe(v.array(explanationStage), v.maxLength(128)),
  })), v.maxLength(2)),
});

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
  isolationContextId: id,
  cookieStoreId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(320))),
  explanation: v.optional(transformExplanation),
  requestTransaction: v.optional(v.strictObject({
    callableId: id,
    transaction: recoveryTransaction,
  })),
  recovery: v.optional(recoveryPlan),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  updatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

const header = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512), v.regex(/^[^\r\n:]+$/, 'Header 名称无效')),
  value: v.pipe(v.string(), v.maxLength(1_000_000)),
});

export const browserTransformPacketSchema = v.strictObject({
  method: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32))),
  url: v.pipe(v.string(), v.trim(), v.url(), v.maxLength(8_192)),
  statusCode: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(999))),
  headers: v.pipe(v.array(header), v.maxLength(512)),
  bodyBase64: v.pipe(v.string(), v.maxLength(11_184_820)),
});

export const browserTransformExecuteSchema = v.strictObject({
  profileId: id,
  direction: v.picklist(['request', 'response']),
  packet: browserTransformPacketSchema,
});
