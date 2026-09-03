import * as v from 'valibot';
import type { BridgeEnvelope } from '@/types/messages';
import type { BridgePublicKey } from '@/types/models';
import {
  browserTransformExecuteSchema,
  browserTransformPacketSchema,
  browserTransformProfileInputSchema,
} from './transform';

export const BRIDGE_PROTOCOL_VERSION = 3;
export const BRIDGE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const BRIDGE_CHUNK_THRESHOLD_BYTES = 512 * 1024;
export const BRIDGE_CHUNK_BYTES = 256 * 1024;
export const BRIDGE_MAX_CHUNK_TRANSFERS = 8;
export const BRIDGE_CHUNK_TIMEOUT_MS = 30_000;

export interface BridgePairingEnvelope {
  type: 'pair_request' | 'pair_pending' | 'pair_approved' | 'pair_rejected' | 'pair_expired' | 'pair_error';
  protocolVersion?: number;
  requestId?: string;
  installationId?: string;
  managedInstance?: BridgeEnvelope['managedInstance'];
  client?: string;
  version?: string;
  nonce?: string;
  serverNonce?: string;
  publicKey?: BridgePublicKey;
  engineIdentityId?: string;
  code?: string;
  expiresAt?: number;
  deviceId?: string;
  message?: string;
}

const id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const comparisonKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const sha256Fingerprint = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/));
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const httpUrl = v.pipe(
  v.string(),
  v.trim(),
  v.url(),
  v.maxLength(8_192),
  v.check((value) => ['http:', 'https:'].includes(new URL(value).protocol), '只允许 HTTP(S) URL'),
);
const optionalTabId = v.optional(tabId);
const optionalFrameId = v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)));
const optionalDocumentId = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)));
const targetFields = { tabId: optionalTabId, frameId: optionalFrameId, documentId: optionalDocumentId };
const cryptoAdapterId = v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/));
const businessFrameHints = v.optional(v.pipe(v.array(v.strictObject({
  functionName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
  url: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4_096))),
  support: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8)),
  averageDepth: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(16)),
})), v.maxLength(8)));
const deepCaptureMatcher = v.variant('kind', [
  v.strictObject({
    kind: v.literal('crypto'),
    adapterId: cryptoAdapterId,
    operation: v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,159}$/)),
    wrapperHandleId: id,
    scriptUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4_096))),
    frameHints: businessFrameHints,
  }),
  v.strictObject({
    kind: v.literal('boundary'),
    eventKind: v.picklist(['beacon', 'worker', 'message']),
    operation: v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,159}$/)),
    wrapperHandleId: id,
    scriptUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4_096))),
    frameHints: businessFrameHints,
  }),
  v.strictObject({
    kind: v.literal('request'),
    urlPattern: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
    frameHints: businessFrameHints,
  }),
]);
const captureId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const nodeId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80));
const valuePath = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512));
const authorizationSelector = v.strictObject({
  source: v.picklist(['wire', 'logical']),
  location: v.picklist(['header', 'path', 'query', 'body']),
  path: valuePath,
});
const authorizationResourceValue = v.strictObject({
  version: v.literal(1),
  baselineId: id,
  source: v.picklist(['wire', 'logical']),
  location: v.picklist(['header', 'path', 'query', 'body']),
  path: valuePath,
  valueType: v.picklist(['string', 'number', 'boolean']),
  byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(8 * 1_024)),
  valueBase64: v.pipe(v.string(), v.maxLength(11_000), v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
  valueFingerprint: v.pipe(v.string(), v.regex(/^workspace-hmac-sha256:[a-f0-9]{64}$/)),
  logicalBindingFingerprint: v.optional(sha256Fingerprint),
});
export const capabilityParams = {
  'system.ping': v.optional(v.strictObject({})),
  'browser.tabs': v.optional(v.strictObject({})),
  'browser.tab.open': v.strictObject({ url: httpUrl }),
  'browser.thumbnail': v.optional(v.strictObject({ tabId: optionalTabId })),
  'browser.frames': v.optional(v.strictObject({ tabId: optionalTabId })),
  'browser.isolation.inspect': v.optional(v.strictObject({
    tabIds: v.optional(v.pipe(v.array(tabId), v.minLength(1), v.maxLength(256))),
  })),
  'browser.isolation.proof': v.pipe(v.strictObject({
    leftTabId: tabId,
    rightTabId: tabId,
  }), v.check((input) => input.leftTabId !== input.rightTabId, '双身份槽位不能选择同一个标签页')),
  'browser.isolation.incognito.open': v.strictObject({ url: httpUrl }),
  'browser.isolation.container.open': v.strictObject({
    url: httpUrl,
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50))),
  }),
  'browser.isolation.container.list': v.optional(v.strictObject({})),
  'browser.isolation.container.remove': v.strictObject({
    cookieStoreId: v.pipe(v.string(), v.regex(/^firefox-container-[0-9]+$/)),
  }),
  'browser.authorization.context.capture': v.strictObject({
    ...targetFields,
    isolationProofId: id,
    slotId: v.picklist(['left', 'right']),
    accountLabel: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
  }),
  'browser.authorization.context.get': v.strictObject({ id }),
  'browser.authorization.context.attest': v.strictObject(targetFields),
  'browser.authorization.context.attestation.get': v.strictObject({ id }),
  'browser.authorization.baseline.capture': v.strictObject({
    ...targetFields,
    authContextKind: v.picklist(['handle', 'attestation']),
    authContextId: id,
    networkRequestId: id,
    comparisonKey,
  }),
  'browser.authorization.baseline.candidates': v.strictObject({
    ...targetFields,
    authContextKind: v.picklist(['handle', 'attestation']),
    authContextId: id,
    limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(200))),
  }),
  'browser.authorization.baseline.get': v.strictObject({ id }),
  'browser.authorization.baseline.logical.bind': v.strictObject({
    id,
    profileId: id,
    comparisonKey,
  }),
  'browser.authorization.baseline.resource.get': v.strictObject({
    id,
    selector: authorizationSelector,
  }),
  'browser.authorization.baseline.compile': v.strictObject({
    id,
    selector: authorizationSelector,
    replacement: authorizationResourceValue,
    comparisonKey,
  }),
  'browser.authorization.baseline.packet.compile': v.strictObject({ id }),
  'browser.authorization.baseline.transform.inspect': v.strictObject({
    id,
    profileId: id,
  }),
  'browser.authorization.baseline.transform.compile': v.strictObject({
    id,
    selector: authorizationSelector,
    replacement: authorizationResourceValue,
    comparisonKey,
    profileId: id,
    bindingFingerprint: sha256Fingerprint,
  }),
  'browser.context': v.optional(v.strictObject({
    ...targetFields,
    includeDom: v.optional(v.boolean()),
    includeStorage: v.optional(v.boolean()),
    includeCookies: v.optional(v.boolean()),
  })),
  'browser.node.inspect': v.strictObject({ ...targetFields, captureId, nodeId }),
  'browser.node.action': v.pipe(v.strictObject({
    ...targetFields,
    captureId,
    nodeId,
    action: v.picklist(['click', 'focus', 'scroll', 'setValue']),
    value: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
  }), v.check((input) => input.action !== 'setValue' || typeof input.value === 'string', 'setValue 操作必须提供 value')),
  'browser.cookies': v.optional(v.strictObject(targetFields)),
  'browser.takeover': v.optional(v.strictObject(targetFields)),
  'browser.instance.close': v.optional(v.strictObject({})),
  'browser.handoff.request': v.strictObject({
    ...targetFields,
    reason: v.picklist(['qr_code', 'mfa', 'captcha', 'device_confirmation', 'other']),
    message: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500)), ''),
  }),
  'browser.handoff.status': v.optional(v.strictObject({})),
  'browser.handoff.presentation.get': v.strictObject({
    handoffId: id,
  }),
  'browser.handoff.focus': v.strictObject({
    handoffId: id,
  }),
  'browser.handoff.resolve': v.strictObject({
    handoffId: id,
    outcome: v.picklist(['completed', 'cancelled']),
  }),
  'browser.network.start': v.optional(v.strictObject({
    ...targetFields,
    captureHeaders: v.optional(v.boolean()),
    captureBody: v.optional(v.boolean()),
    maxEntries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(10), v.maxValue(200))),
    maxBodyBytes: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1_024), v.maxValue(65_536))),
  })),
  'browser.network.status': v.optional(v.strictObject(targetFields)),
  'browser.network.list': v.optional(v.strictObject({
    ...targetFields,
    limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(200))),
  })),
  'browser.network.clear': v.optional(v.strictObject(targetFields)),
  'browser.network.stop': v.optional(v.strictObject(targetFields)),
  'browser.network.export': v.strictObject({ ...targetFields, id }),
  'browser.network.poc': v.strictObject({ ...targetFields, id }),
  'browser.network.analysis': v.strictObject({ ...targetFields, id }),
  'browser.recording.start': v.optional(v.strictObject({
    ...targetFields,
    captureValues: v.optional(v.boolean()),
    maxEntries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(20), v.maxValue(500))),
    maxValueBytes: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(256), v.maxValue(8_192))),
  })),
  'browser.recording.status': v.optional(v.strictObject(targetFields)),
  'browser.recording.get': v.optional(v.strictObject({
    ...targetFields,
    limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(500))),
  })),
  'browser.recording.clear': v.optional(v.strictObject(targetFields)),
  'browser.recording.stop': v.optional(v.strictObject(targetFields)),
  'browser.recording.trace.list': v.optional(v.strictObject({
    ...targetFields,
    limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100))),
  })),
  'browser.recording.evidence.inspect': v.strictObject({
    ...targetFields,
    traceId: id,
    eventId: v.optional(id),
    includeValues: v.optional(v.boolean()),
  }),
  'browser.callable.create': v.union([
    v.strictObject({
      ...targetFields, source: v.literal('recording'), callHandleId: id,
      name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
    }),
    v.strictObject({
      ...targetFields, source: v.literal('deep-capture'), callFrameId: id,
      strategy: v.literal('selected-frame'),
      name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
      candidateId: v.optional(id),
    }),
    v.strictObject({
      ...targetFields, source: v.literal('deep-capture'), callFrameId: id,
      strategy: v.literal('request-transaction'),
      name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
      candidateId: id,
    }),
    v.strictObject({
      ...targetFields, source: v.literal('deep-capture'), callFrameId: id,
      strategy: v.literal('expression'),
      name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
      functionExpression: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)),
    }),
  ]),
  'browser.callable.list': v.optional(v.strictObject(targetFields)),
  'browser.callable.execute': v.strictObject({ ...targetFields, callableId: id, args: v.pipe(v.array(v.unknown()), v.maxLength(64)) }),
  'browser.callable.delete': v.strictObject({ ...targetFields, callableId: id }),
  'browser.callable.inspect': v.strictObject({ ...targetFields, callableId: v.optional(id) }),
  'browser.callable.replay': v.strictObject({
    ...targetFields,
    callableId: id,
    args: v.pipe(v.array(v.unknown()), v.maxLength(64)),
  }),
  'browser.packet.compare': v.strictObject({
    ...targetFields,
    actual: browserTransformPacketSchema,
    expected: browserTransformPacketSchema,
    mode: v.optional(v.picklist(['structure', 'exact'])),
  }),
  'browser.profile.propose': v.strictObject({
    ...targetFields,
    candidateId: id,
    callableId: id,
    inputPaths: v.optional(v.pipe(v.array(valuePath), v.maxLength(64))),
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  }),
  'browser.profile.validation.latest': v.optional(v.strictObject(targetFields)),
  'browser.profile.validate': v.strictObject({
    ...targetFields,
    candidateId: id,
    callableId: id,
    inputPaths: v.optional(v.pipe(v.array(valuePath), v.maxLength(64))),
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
    packet: browserTransformPacketSchema,
    observed: v.optional(browserTransformPacketSchema),
    comparisonMode: v.optional(v.picklist(['structure', 'exact'])),
  }),
  'browser.deep_capture.start': v.strictObject({ ...targetFields, matcher: deepCaptureMatcher }),
  'browser.deep_capture.status': v.optional(v.strictObject(targetFields)),
  'browser.deep_capture.keepalive': v.optional(v.strictObject(targetFields)),
  'browser.deep_capture.resume': v.optional(v.strictObject(targetFields)),
  'browser.deep_capture.detach': v.optional(v.strictObject(targetFields)),
  'browser.transform.profile.list': v.optional(v.strictObject(targetFields)),
  'browser.transform.profile.save': browserTransformProfileInputSchema,
  'browser.transform.profile.delete': v.strictObject({ id }),
  'browser.transform.recovery.get': v.strictObject({ id }),
  'browser.transform.recovery.start': v.strictObject({ id }),
  'browser.transform.recovery.capture': v.strictObject({
    id,
    ...targetFields,
    callFrameId: id,
    strategy: v.picklist(['selected-frame', 'request-transaction']),
  }),
  'browser.transform.recovery.validate': v.strictObject({
    id,
    packet: browserTransformPacketSchema,
  }),
  'browser.transform.recovery.confirm': v.strictObject({ id, validationId: id }),
  'browser.transform.recovery.reset': v.strictObject({ id }),
  'browser.transform.execute': browserTransformExecuteSchema,
  'browser.invoke': v.strictObject({
    ...targetFields,
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
    args: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(1_000)), []),
    timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(250), v.maxValue(60_000))),
  }),
  'browser.eval': v.strictObject({
    ...targetFields,
    mode: v.picklist(['expression', 'program']),
    code: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000_000)),
    timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(250), v.maxValue(60_000))),
  }),
  'proxy.list': v.optional(v.strictObject({})),
  'proxy.switch': v.strictObject({ id }),
} satisfies Record<string, v.GenericSchema>;

function issueMessage(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => {
    const path = v.getDotPath(issue);
    return `${path ? `${path}: ` : ''}${issue.message}`;
  }).join('; ');
}

export function parseCapabilityParams(method: string, input: unknown): Record<string, unknown> {
  const schema = capabilityParams[method as keyof typeof capabilityParams];
  if (!schema) throw new Error(`不支持的 Bridge 方法: ${method}`);
  const result = v.safeParse(schema, input);
  if (!result.success) throw new Error(`Bridge 方法 ${method} 的参数无效: ${issueMessage(result.issues)}`);
  return (result.output || {}) as Record<string, unknown>;
}

export function parseBridgeEnvelope(raw: unknown): BridgeEnvelope {
  let input = raw;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > BRIDGE_MAX_MESSAGE_BYTES) throw new Error('Bridge 消息超过 16 MiB 限制');
    input = JSON.parse(raw) as unknown;
  } else {
    const encoded = JSON.stringify(raw);
    if (new TextEncoder().encode(encoded).byteLength > BRIDGE_MAX_MESSAGE_BYTES) throw new Error('Bridge 消息超过 16 MiB 限制');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bridge 消息必须是对象');
  const message = input as Record<string, unknown>;
  const allowedKeys = new Set([
    'id', 'type', 'method', 'params', 'result', 'error', 'client', 'version', 'protocolVersion',
    'capabilities', 'capabilityCatalog', 'sessionId', 'taskId', 'grantId', 'installationId',
    'managedInstance',
    'engineInstanceId', 'engineIdentityId', 'challenge', 'signature', 'publicKey', 'connectionId',
    'resumeSessionId', 'resumed', 'sequence', 'timestamp', 'replyTimestamp', 'transferId', 'index',
    'total', 'data', 'originalBytes',
  ]);
  const unexpected = Object.keys(message).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`Bridge 消息包含未声明字段 $.${unexpected}`);
  if (typeof message.type !== 'string') throw new Error('Bridge 消息缺少 type');
  if (message.managedInstance !== undefined) {
    const managed = message.managedInstance as Record<string, unknown>;
    if (!managed || typeof managed !== 'object' || Array.isArray(managed)
      || !['ytray', 'yakit'].includes(String(managed.manager || ''))
      || typeof managed.instanceId !== 'string' || !/^[A-Za-z0-9-]{1,160}$/.test(managed.instanceId)
      || typeof managed.badge !== 'string' || !/^[A-Z]{1,2}$/.test(managed.badge)
      || Object.keys(managed).some((key) => !['manager', 'instanceId', 'badge'].includes(key))) {
      throw new Error('Bridge 浏览器实例身份无效');
    }
  }

  if (message.type === 'challenge') {
    if (message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error(`Bridge 协议版本不兼容: ${String(message.protocolVersion)}`);
    for (const key of ['engineIdentityId', 'engineInstanceId', 'challenge', 'signature'] as const) {
      if (typeof message[key] !== 'string' || !message[key] || message[key].length > 512) throw new Error(`Bridge ${key} 无效`);
    }
    if (!Number.isSafeInteger(message.timestamp) || Number(message.timestamp) <= 0) throw new Error('Bridge challenge 时间无效');
    parseBridgePublicKey(message.publicKey);
    return message as unknown as BridgeEnvelope;
  }

  if (message.type === 'hello_ack') {
    if (!Number.isSafeInteger(message.protocolVersion) || message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      throw new Error(`Bridge 协议版本不兼容: ${String(message.protocolVersion)}`);
    }
    if (message.version !== undefined && typeof message.version !== 'string') throw new Error('Bridge 引擎版本无效');
    if (!Array.isArray(message.capabilities) || message.capabilities.some((item) => typeof item !== 'string')) {
      throw new Error('Bridge 能力列表无效');
    }
    for (const key of ['engineIdentityId', 'engineInstanceId', 'connectionId', 'sessionId'] as const) {
      if (typeof message[key] !== 'string' || !message[key] || message[key].length > 160) throw new Error(`Bridge ${key} 无效`);
    }
    if (message.resumed !== undefined && typeof message.resumed !== 'boolean') throw new Error('Bridge resumed 状态无效');
    return message as unknown as BridgeEnvelope;
  }
  if (message.type === 'request') {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 160) throw new Error('Bridge 请求 ID 无效');
    if (typeof message.method !== 'string' || !message.method || message.method.length > 160) throw new Error('Bridge 请求方法无效');
    return message as unknown as BridgeEnvelope;
  }
  if (message.type === 'ping' || message.type === 'pong' || message.type === 'cancel') {
    if (message.id !== undefined && typeof message.id !== 'string') throw new Error('Bridge 心跳 ID 无效');
    if (message.type === 'cancel' && !message.id) throw new Error('Bridge cancel 缺少请求 ID');
    if ((message.type === 'ping' || message.type === 'pong') && (!Number.isSafeInteger(message.sequence) || typeof message.timestamp !== 'number')) throw new Error('Bridge 心跳序号或时间无效');
    return message as unknown as BridgeEnvelope;
  }
  if (message.type === 'chunk') {
    if (typeof message.transferId !== 'string' || !message.transferId || message.transferId.length > 160) throw new Error('Bridge chunk transferId 无效');
    if (!Number.isSafeInteger(message.index) || !Number.isSafeInteger(message.total) || Number(message.index) < 0 || Number(message.total) < 1 || Number(message.total) > 128 || Number(message.index) >= Number(message.total)) throw new Error('Bridge chunk 序号无效');
    if (typeof message.data !== 'string' || message.data.length > 384 * 1024) throw new Error('Bridge chunk 数据无效');
    if (!Number.isSafeInteger(message.originalBytes) || Number(message.originalBytes) < 1 || Number(message.originalBytes) > BRIDGE_MAX_MESSAGE_BYTES) throw new Error('Bridge chunk 原始大小无效');
    return message as unknown as BridgeEnvelope;
  }
  if (message.type === 'response') {
    if (message.id !== undefined && (typeof message.id !== 'string' || !message.id || message.id.length > 160)) {
      throw new Error('Bridge 响应 ID 无效');
    }
    if (!message.id && !message.error) throw new Error('Bridge 响应缺少 ID');
    if (message.error !== undefined) {
      if (!message.error || typeof message.error !== 'object') throw new Error('Bridge 响应错误对象无效');
      const responseError = message.error as Record<string, unknown>;
      const unexpectedError = Object.keys(responseError).find((key) => !['code', 'message', 'data'].includes(key));
      if (unexpectedError) throw new Error(`Bridge 响应错误包含未声明字段 $.error.${unexpectedError}`);
      if (typeof responseError.code !== 'string' || typeof responseError.message !== 'string') throw new Error('Bridge 响应错误格式无效');
    }
    return message as unknown as BridgeEnvelope;
  }
  throw new Error(`不支持的 Bridge 消息类型: ${message.type}`);
}

function parseBridgePublicKey(input: unknown): BridgePublicKey {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bridge 公钥无效');
  const key = input as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') {
    throw new Error('Bridge 公钥必须使用 ECDSA P-256');
  }
  if (!key.x || !key.y || key.x.length > 128 || key.y.length > 128) throw new Error('Bridge 公钥坐标无效');
  return key as unknown as BridgePublicKey;
}

export function parseBridgePairingEnvelope(raw: unknown): BridgePairingEnvelope {
  let input = raw;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > 32 * 1024) throw new Error('Bridge 配对消息超过 32 KiB 限制');
    input = JSON.parse(raw) as unknown;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bridge 配对消息必须是对象');
  const message = input as Record<string, unknown>;
  const pairingKeys = new Set([
    'type', 'protocolVersion', 'requestId', 'installationId', 'client', 'version', 'nonce',
    'serverNonce', 'publicKey', 'engineIdentityId', 'code', 'expiresAt', 'deviceId', 'message',
  ]);
  const unexpected = Object.keys(message).find((key) => !pairingKeys.has(key));
  if (unexpected) throw new Error(`Bridge 配对消息包含未声明字段 $.${unexpected}`);
  const allowed = ['pair_pending', 'pair_approved', 'pair_rejected', 'pair_expired', 'pair_error'];
  if (typeof message.type !== 'string' || !allowed.includes(message.type)) throw new Error('Bridge 配对消息类型无效');
  if (message.message !== undefined && (typeof message.message !== 'string' || message.message.length > 1_024)) throw new Error('Bridge 配对消息文本无效');
  if (message.type === 'pair_pending') {
    if (message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new Error('Bridge 配对协议版本不兼容');
    for (const key of ['requestId', 'serverNonce', 'engineIdentityId', 'code'] as const) {
      if (typeof message[key] !== 'string' || !message[key] || message[key].length > 512) throw new Error(`Bridge 配对 ${key} 无效`);
    }
    if (!/^\d{6}$/.test(String(message.code))) throw new Error('Bridge 配对验证码无效');
    if (!Number.isSafeInteger(message.expiresAt) || Number(message.expiresAt) <= Date.now()) throw new Error('Bridge 配对申请已经过期');
    if (Number(message.expiresAt) - Date.now() > 5 * 60_000) throw new Error('Bridge 配对申请有效期异常');
    parseBridgePublicKey(message.publicKey);
  }
  if (message.type === 'pair_approved') {
    for (const key of ['requestId', 'deviceId', 'engineIdentityId'] as const) {
      if (typeof message[key] !== 'string' || !message[key] || message[key].length > 512) throw new Error(`Bridge 配对 ${key} 无效`);
    }
    parseBridgePublicKey(message.publicKey);
  }
  return message as unknown as BridgePairingEnvelope;
}
