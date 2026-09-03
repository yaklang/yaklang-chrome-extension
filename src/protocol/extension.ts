import * as v from 'valibot';
import type { ExtensionAction, ExtensionRequest } from '@/types/messages';
import type { CapabilityScope } from '@/types/models';
import { capabilityParams } from './bridge';
import {
  browserTransformExecuteSchema,
  browserTransformPacketSchema,
  browserTransformProfileInputSchema,
} from './transform';

const id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const shortText = v.pipe(v.string(), v.trim(), v.maxLength(240));
const url = v.pipe(v.string(), v.trim(), v.url(), v.maxLength(8_192));
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const frameId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const documentId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const captureId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const nodeId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80));
const targetFields = { tabId: v.optional(tabId), frameId: v.optional(frameId), documentId: v.optional(documentId) };
const businessFrameHints = v.optional(v.pipe(v.array(v.strictObject({
  functionName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
  url: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4_096))),
  support: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8)),
  averageDepth: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(16)),
})), v.maxLength(8)));
const deepCaptureMatcher = v.variant('kind', [
  v.strictObject({
    kind: v.literal('crypto'),
    adapterId: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)),
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
const port = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65_535));
const proxyHost = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(253),
  v.regex(/^[a-zA-Z0-9._:[\]-]+$/, '代理主机只能包含主机名或 IP 地址字符'),
);
const httpUrl = v.pipe(
  url,
  v.check((value) => ['http:', 'https:'].includes(new URL(value).protocol), '只允许 HTTP(S) URL'),
);
const noPayload = v.optional(v.undefined_());
const stringList = (maxItems = 200, maxLength = 2_048) => v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength))),
  v.maxLength(maxItems),
);

const proxyProfile = v.pipe(v.strictObject({
  id,
  name: v.pipe(shortText, v.minLength(1)),
  kind: v.picklist(['direct', 'system', 'fixed_servers', 'pac_script']),
  host: v.optional(proxyHost),
  port: v.optional(port),
  scheme: v.optional(v.picklist(['http', 'https', 'socks4', 'socks5'])),
  pacUrl: v.optional(httpUrl),
  pacScript: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
  bypass: stringList(500, 2_048),
  builtin: v.optional(v.boolean()),
  authEnabled: v.optional(v.boolean()),
  authUsername: v.optional(v.pipe(v.string(), v.maxLength(1_024))),
}), v.check((profile) => {
  if (profile.kind === 'fixed_servers') return Boolean(profile.host && profile.port && profile.scheme);
  if (profile.kind === 'pac_script') return Boolean(profile.pacUrl || profile.pacScript?.trim());
  return true;
}, '代理配置缺少当前类型所需的主机、端口或 PAC 内容'));

const proxyCondition = v.strictObject({
  type: v.picklist(['host_exact', 'host_suffix', 'host_wildcard', 'host_regex', 'url_prefix', 'url_wildcard', 'url_regex', 'keyword']),
  value: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8_192)),
});

const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const sourceFormat = v.picklist(['auto', 'autoproxy', 'switchyomega', 'hosts']);
const sourceStatus = v.picklist(['idle', 'updating', 'ready', 'error']);

const proxyRule = v.strictObject({
  id,
  name: v.pipe(shortText, v.minLength(1)),
  enabled: v.boolean(),
  condition: proxyCondition,
  proxyProfileId: id,
  order: nonNegativeInteger,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const proxyRuleSourceInput = v.strictObject({
  id: v.optional(id),
  name: v.pipe(shortText, v.minLength(1)),
  url: httpUrl,
  format: sourceFormat,
  enabled: v.boolean(),
  matchProfileId: id,
  bypassProfileId: id,
  order: v.optional(nonNegativeInteger),
  updateIntervalMinutes: v.pipe(v.number(), v.safeInteger(), v.minValue(15), v.maxValue(43_200)),
});

const proxyRuleSource = v.strictObject({
  id,
  name: v.pipe(shortText, v.minLength(1)),
  url: httpUrl,
  format: sourceFormat,
  enabled: v.boolean(),
  matchProfileId: id,
  bypassProfileId: id,
  order: nonNegativeInteger,
  updateIntervalMinutes: v.pipe(v.number(), v.safeInteger(), v.minValue(15), v.maxValue(43_200)),
  revision: v.optional(id),
  contentHash: v.optional(id),
  etag: v.optional(v.pipe(v.string(), v.maxLength(1_024))),
  lastModified: v.optional(v.pipe(v.string(), v.maxLength(1_024))),
  lastCheckedAt: v.optional(timestamp),
  lastUpdatedAt: v.optional(timestamp),
  status: sourceStatus,
  totalRuleCount: nonNegativeInteger,
  supportedRuleCount: nonNegativeInteger,
  ignoredRuleCount: nonNegativeInteger,
  invalidRuleCount: nonNegativeInteger,
  error: v.optional(v.pipe(v.string(), v.maxLength(16_384))),
});

const proxyRouting = v.strictObject({
  defaultProfileId: id,
  failMode: v.picklist(['open', 'closed']),
});

const proxyConfiguration = v.strictObject({
  version: v.literal(2),
  profiles: v.pipe(v.array(proxyProfile), v.minLength(1), v.maxLength(500)),
  rules: v.pipe(v.array(proxyRule), v.maxLength(5_000)),
  sources: v.pipe(v.array(v.strictObject({
    source: proxyRuleSource,
    content: v.optional(v.pipe(v.string(), v.maxLength(10 * 1024 * 1024))),
  })), v.maxLength(200)),
  routing: proxyRouting,
});

const userAgentValue = v.pipe(
  v.string(), v.trim(), v.minLength(1), v.maxLength(1_024),
  v.check((value) => !/[\r\n]/.test(value), 'User-Agent 不能包含换行符'),
);

const userAgentProfileInput = v.strictObject({
  id: v.optional(id),
  name: v.pipe(shortText, v.minLength(1)),
  userAgent: userAgentValue,
});

const managedInstance = v.strictObject({
  manager: v.picklist(['ytray', 'yakit']),
  instanceId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]{1,160}$/)),
  badge: v.pipe(v.string(), v.regex(/^[A-Z]{1,2}$/)),
});

const bridgeConfig = v.strictObject({
  transport: v.picklist(['native', 'websocket']),
  nativeHost: v.pipe(v.string(), v.trim(), v.maxLength(253)),
  endpoint: v.pipe(v.string(), v.trim(), v.maxLength(2_048)),
  autoConnect: v.boolean(),
  installationId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  managedInstance: v.optional(managedInstance),
  pairedEngine: v.optional(v.strictObject({
    engineIdentityId: id,
    deviceId: id,
    publicKey: v.strictObject({
      kty: v.literal('EC'),
      crv: v.literal('P-256'),
      x: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      y: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    pairedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  })),
});

const partitionKey = v.strictObject({
  topLevelSite: v.optional(httpUrl),
  hasCrossSiteAncestor: v.optional(v.boolean()),
});

const cookieInput = v.strictObject({
  url,
  tabId,
  name: v.pipe(v.string(), v.maxLength(4_096)),
  value: v.pipe(v.string(), v.maxLength(64 * 1_024)),
  domain: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(253))),
  path: v.optional(v.pipe(v.string(), v.maxLength(4_096))),
  secure: v.optional(v.boolean()),
  httpOnly: v.optional(v.boolean()),
  sameSite: v.optional(v.picklist(['no_restriction', 'lax', 'strict', 'unspecified'])),
  expirationDate: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  storeId: v.optional(shortText),
  firstPartyDomain: v.optional(v.pipe(v.string(), v.maxLength(253))),
  partitionKey: v.optional(partitionKey),
});

const cookieRemoveInput = v.strictObject({
  url,
  name: v.pipe(v.string(), v.maxLength(4_096)),
  storeId: v.optional(shortText),
  firstPartyDomain: v.optional(v.pipe(v.string(), v.maxLength(253))),
  partitionKey: v.optional(partitionKey),
});

const contextOptions = {
  includeStorage: v.optional(v.boolean()),
  includeCookies: v.optional(v.boolean()),
  includeDom: v.optional(v.boolean()),
  tabId: v.optional(tabId),
  frameId: v.optional(frameId),
  documentId: v.optional(documentId),
};

const capabilityScopes: readonly CapabilityScope[] = [
  'browser.tabs.read',
  'browser.tabs.write',
  'browser.isolation.read',
  'browser.isolation.manage',
  'browser.dom.read',
  'browser.dom.write',
  'browser.storage.read',
  'browser.cookies.read',
  'browser.tab.activate',
  'browser.instance.close',
  'browser.page.invoke',
  'browser.page.eval.expression',
  'browser.page.eval.program',
  'browser.human.takeover',
  'browser.network.read',
  'browser.network.capture',
  'browser.network.sensitive.read',
  'browser.network.replay',
  'browser.recording.read',
  'browser.recording.control',
  'browser.recording.sensitive.read',
  'browser.callable.execute',
  'browser.debugger.read',
  'browser.debugger.control',
  'browser.transform.read',
  'browser.transform.manage',
  'browser.transform.execute',
  'browser.proxy.read',
  'browser.proxy.write',
];

const payloadSchemas = {
  'state.get': noPayload,
  'tab.active': noPayload,
  'tab.get': v.strictObject({ tabId }),
  'tab.list': noPayload,
  'frame.list': v.strictObject({ tabId }),
  'isolation.inspect': v.strictObject({
    tabIds: v.optional(v.pipe(v.array(tabId), v.minLength(1), v.maxLength(256))),
  }),
  'isolation.proof.create': v.pipe(v.strictObject({
    leftTabId: tabId,
    rightTabId: tabId,
  }), v.check((input) => input.leftTabId !== input.rightTabId, '双身份槽位不能选择同一个标签页')),
  'isolation.incognito.open': v.strictObject({ url: httpUrl }),
  'isolation.container.open': v.strictObject({
    url: httpUrl,
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50))),
  }),
  'isolation.container.list': noPayload,
  'isolation.container.remove': v.strictObject({
    cookieStoreId: v.pipe(v.string(), v.regex(/^firefox-container-[0-9]+$/)),
  }),
  'authorization.engine.task': v.strictObject({
    schema: v.picklist([
      'authorization.workspace.create',
      'authorization.workspace.inspect',
      'authorization.baseline.candidates',
      'authorization.baseline.bind',
      'authorization.logical.bind',
      'authorization.plan.create',
      'authorization.plan.execute',
      'authorization.evidence.inspect',
      'authorization.evidence.packet',
      'authorization.evidence.diff',
      'authorization.evidence.validate',
    ]),
    payload: v.record(v.string(), v.unknown()),
    timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(5_000), v.maxValue(120_000))),
  }),
  'authorization.yakit.open': v.strictObject({ workspaceId: id }),
  'proxy.save': proxyProfile,
  'proxy.delete': v.strictObject({ id }),
  'proxy.switch': v.strictObject({ id }),
  'proxy.rule.save': proxyRule,
  'proxy.rule.delete': v.strictObject({ id }),
  'proxy.auto.apply': noPayload,
  'proxy.rules.preview': v.strictObject({ url: httpUrl }),
  'proxy.rules.compile': noPayload,
  'proxy.rules.reorder': v.strictObject({ ids: v.pipe(v.array(id), v.maxLength(5_000)) }),
  'proxy.rules.settings': proxyRouting,
  'proxy.source.save': proxyRuleSourceInput,
  'proxy.source.refresh': v.strictObject({ id }),
  'proxy.source.delete': v.strictObject({ id }),
  'proxy.sources.reorder': v.strictObject({ ids: v.pipe(v.array(id), v.maxLength(200)) }),
  'proxy.source.rules': v.strictObject({
    id,
    offset: nonNegativeInteger,
    limit: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(500)),
    query: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2_048))),
  }),
  'proxy.site.route': v.strictObject({ url: httpUrl, profileId: id }),
  'proxy.site.route.clear': v.strictObject({ url: httpUrl }),
  'proxy.auth.set': v.strictObject({ profileId: id, password: v.pipe(v.string(), v.maxLength(4_096)) }),
  'proxy.auth.status': v.strictObject({ profileId: id }),
  'proxy.config.export': noPayload,
  'proxy.config.import': v.strictObject({ configuration: proxyConfiguration }),
  'cookie.list': v.strictObject({ url, tabId }),
  'cookie.set': cookieInput,
  'cookie.remove': cookieRemoveInput,
  'cookie.removeMany': v.strictObject({ cookies: v.pipe(v.array(cookieRemoveInput), v.minLength(1), v.maxLength(1_000)) }),
  'cookie.import': v.strictObject({ url, tabId, format: v.picklist(['json', 'netscape', 'set-cookie']), text: v.pipe(v.string(), v.maxLength(2 * 1024 * 1024)) }),
  'cookie.export': v.strictObject({ url, tabId, format: v.picklist(['json', 'netscape', 'set-cookie']), includeValues: v.boolean() }),
  'ua.catalog': noPayload,
  'ua.resolve': v.strictObject({ url: httpUrl }),
  'ua.profile.save': userAgentProfileInput,
  'ua.profile.delete': v.strictObject({ id }),
  'ua.site.apply': v.strictObject({ url: httpUrl, profileId: id }),
  'ua.site.reset': v.strictObject({ url: httpUrl }),
  'context.capture': v.strictObject(contextOptions),
  'context.node.inspect': v.strictObject({ ...targetFields, captureId, nodeId }),
  'context.node.action': v.pipe(v.strictObject({
    ...targetFields,
    captureId,
    nodeId,
    action: v.picklist(['click', 'focus', 'scroll', 'setValue']),
    value: v.optional(v.pipe(v.string(), v.maxLength(100_000))),
  }), v.check((input) => input.action !== 'setValue' || typeof input.value === 'string', 'setValue 操作必须提供 value')),
  'context.invoke': v.strictObject({
    path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_048)),
    args: v.pipe(v.array(v.unknown()), v.maxLength(1_000)),
    tabId: v.optional(tabId),
    frameId: v.optional(frameId),
    documentId: v.optional(documentId),
    timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(250), v.maxValue(60_000))),
  }),
  'context.eval': v.strictObject({
    mode: v.picklist(['expression', 'program']),
    code: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000_000)),
    tabId: v.optional(tabId),
    frameId: v.optional(frameId),
    documentId: v.optional(documentId),
    timeoutMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(250), v.maxValue(60_000))),
  }),
  'panel.update': v.strictObject({
    enabled: v.optional(v.boolean()),
    side: v.optional(v.picklist(['left', 'right'])),
    y: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))),
    displayMode: v.optional(v.picklist(['always', 'active-task'])),
    siteMode: v.optional(v.picklist(['all', 'allowlist', 'denylist'])),
    siteOrigins: v.optional(v.pipe(v.array(v.pipe(v.string(), v.trim(), v.url(), v.maxLength(2_048))), v.maxLength(500))),
    shortcutEnabled: v.optional(v.boolean()),
    autoCollapseFullscreen: v.optional(v.boolean()),
  }),
  'grant.create': v.strictObject({
    targets: v.pipe(v.array(v.strictObject({ tabId, frameId })), v.minLength(1), v.maxLength(256)),
    scopes: v.pipe(v.array(v.picklist(capabilityScopes)), v.minLength(1), v.maxLength(capabilityScopes.length)),
    durationMinutes: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(24 * 60)),
    taskId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160))),
  }),
  'grant.refresh': noPayload,
  'grant.revoke': noPayload,
  'handoff.resolve': v.strictObject({ id, outcome: v.picklist(['completed', 'cancelled']) }),
  'network.capture.start': v.strictObject({
    ...targetFields,
    captureHeaders: v.optional(v.boolean()),
    captureBody: v.optional(v.boolean()),
    maxEntries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(10), v.maxValue(200))),
    maxBodyBytes: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1_024), v.maxValue(65_536))),
  }),
  'network.capture.status': v.strictObject(targetFields),
  'network.capture.list': v.strictObject({ ...targetFields, limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(200))) }),
  'network.capture.clear': v.strictObject(targetFields),
  'network.capture.stop': v.strictObject(targetFields),
  'network.capture.export': v.strictObject({ ...targetFields, id }),
  'network.capture.send': v.strictObject({ ...targetFields, id }),
  'network.capture.poc': v.strictObject({ ...targetFields, id }),
  'network.capture.analysis': v.strictObject({ ...targetFields, id }),
  'recording.start': v.strictObject({
    ...targetFields,
    captureValues: v.optional(v.boolean()),
    maxEntries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(20), v.maxValue(500))),
    maxValueBytes: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(256), v.maxValue(8_192))),
  }),
  'recording.status': v.strictObject(targetFields),
  'recording.get': v.strictObject({ ...targetFields, limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(500))) }),
  'recording.clear': v.strictObject(targetFields),
  'recording.stop': v.strictObject(targetFields),
  'callable.create': v.union([
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
  'callable.list': v.strictObject(targetFields),
  'callable.execute': v.strictObject({ ...targetFields, callableId: id, args: v.pipe(v.array(v.unknown()), v.maxLength(64)) }),
  'callable.delete': v.strictObject({ ...targetFields, callableId: id }),
  'deep.capture.start': v.strictObject({ ...targetFields, matcher: deepCaptureMatcher }),
  'deep.capture.status': v.strictObject(targetFields),
  'deep.capture.keepalive': v.strictObject(targetFields),
  'deep.capture.resume': v.strictObject(targetFields),
  'deep.capture.detach': v.strictObject(targetFields),
  'analysis.profile.propose': capabilityParams['browser.profile.propose'],
  'analysis.profile.validate': capabilityParams['browser.profile.validate'],
  'analysis.profile.validation.latest': capabilityParams['browser.profile.validation.latest'],
  'transform.profile.list': v.strictObject(targetFields),
  'transform.profile.save': browserTransformProfileInputSchema,
  'transform.profile.delete': v.strictObject({ id }),
  'transform.recovery.get': v.strictObject({ id }),
  'transform.recovery.start': v.strictObject({ id }),
  'transform.recovery.capture': v.strictObject({
    id,
    ...targetFields,
    callFrameId: id,
    strategy: v.picklist(['selected-frame', 'request-transaction']),
  }),
  'transform.recovery.validate': v.strictObject({ id, packet: browserTransformPacketSchema }),
  'transform.recovery.confirm': v.strictObject({ id, validationId: id }),
  'transform.recovery.reset': v.strictObject({ id }),
  'transform.execute': browserTransformExecuteSchema,
  'audit.list': v.strictObject({ limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(500))) }),
  'audit.clear': noPayload,
  'agent.runtime.get': noPayload,
  'agent.pause': noPayload,
  'agent.resume': noPayload,
  'agent.actions.clear': noPayload,
  'policy.status': noPayload,
  'diagnostics.export': noPayload,
  'metrics.get': noPayload,
  'metrics.reset': noPayload,
  'bridge.config.save': bridgeConfig,
  'bridge.managed-instance.bind': managedInstance,
  'bridge.pair': noPayload,
  'bridge.pair.cancel': noPayload,
  'bridge.pair.status': noPayload,
  'bridge.unpair': noPayload,
  'bridge.connect': noPayload,
  'bridge.disconnect': noPayload,
  'bridge.status': noPayload,
} satisfies Record<ExtensionAction, v.GenericSchema>;

function issueMessage(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => {
    const path = v.getDotPath(issue);
    return `${path ? `${path}: ` : ''}${issue.message}`;
  }).join('; ');
}

export function parseExtensionRequest(input: unknown): ExtensionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('扩展消息必须是对象');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'action' && key !== 'payload')) throw new Error('扩展消息包含未知字段');
  if (typeof record.action !== 'string' || !(record.action in payloadSchemas)) throw new Error('未知扩展操作');
  const action = record.action as ExtensionAction;
  const result = v.safeParse(payloadSchemas[action], record.payload);
  if (!result.success) throw new Error(`操作 ${action} 的参数无效: ${issueMessage(result.issues)}`);
  return { action, payload: result.output } as ExtensionRequest;
}
