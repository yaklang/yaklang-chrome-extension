import * as v from 'valibot';
import type { ExtensionAction, ExtensionRequest } from '@/types/messages';
import type { CapabilityScope } from '@/types/models';

const id = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const shortText = v.pipe(v.string(), v.trim(), v.maxLength(240));
const url = v.pipe(v.string(), v.trim(), v.url(), v.maxLength(8_192));
const tabId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const frameId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const documentId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const captureId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160));
const nodeId = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80));
const targetFields = { tabId: v.optional(tabId), frameId: v.optional(frameId), documentId: v.optional(documentId) };
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

const proxyRule = v.strictObject({
  id,
  name: v.pipe(shortText, v.minLength(1)),
  enabled: v.boolean(),
  patterns: stringList(500, 2_048),
  proxyProfileId: id,
  priority: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1_000_000)),
});

const proxyRouting = v.strictObject({
  defaultProfileId: id,
  failMode: v.picklist(['open', 'closed']),
});

const proxyConfiguration = v.strictObject({
  version: v.literal(1),
  profiles: v.pipe(v.array(proxyProfile), v.minLength(1), v.maxLength(500)),
  rules: v.pipe(v.array(proxyRule), v.maxLength(5_000)),
  routing: proxyRouting,
});

const userAgentRule = v.strictObject({
  id,
  name: v.pipe(shortText, v.minLength(1)),
  enabled: v.boolean(),
  userAgent: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)),
  domains: stringList(500, 253),
});

const bridgeConfig = v.strictObject({
  transport: v.picklist(['native', 'websocket']),
  nativeHost: v.pipe(v.string(), v.trim(), v.maxLength(253)),
  endpoint: v.pipe(v.string(), v.trim(), v.maxLength(2_048)),
  autoConnect: v.boolean(),
  installationId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
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
  'browser.dom.read',
  'browser.dom.write',
  'browser.storage.read',
  'browser.cookies.read',
  'browser.tab.activate',
  'browser.page.invoke',
  'browser.page.eval.expression',
  'browser.page.eval.program',
  'browser.human.takeover',
  'browser.network.read',
  'browser.network.capture',
  'browser.network.sensitive.read',
  'browser.observation.read',
  'browser.observation.control',
  'browser.observation.sensitive.read',
  'browser.proxy.read',
  'browser.proxy.write',
];

const payloadSchemas = {
  'state.get': noPayload,
  'tab.active': noPayload,
  'tab.get': v.strictObject({ tabId }),
  'tab.list': noPayload,
  'frame.list': v.strictObject({ tabId }),
  'proxy.save': proxyProfile,
  'proxy.delete': v.strictObject({ id }),
  'proxy.switch': v.strictObject({ id }),
  'proxy.rule.save': proxyRule,
  'proxy.rule.delete': v.strictObject({ id }),
  'proxy.rules.apply': noPayload,
  'proxy.rules.preview': v.strictObject({ url: httpUrl }),
  'proxy.rules.compile': noPayload,
  'proxy.rules.reorder': v.strictObject({ ids: v.pipe(v.array(id), v.maxLength(5_000)) }),
  'proxy.rules.settings': proxyRouting,
  'proxy.rules.stats': noPayload,
  'proxy.rules.stats.clear': noPayload,
  'proxy.auth.set': v.strictObject({ profileId: id, password: v.pipe(v.string(), v.maxLength(4_096)) }),
  'proxy.auth.status': v.strictObject({ profileId: id }),
  'proxy.config.export': noPayload,
  'proxy.config.import': v.strictObject({ configuration: proxyConfiguration }),
  'cookie.list': v.strictObject({ url }),
  'cookie.set': cookieInput,
  'cookie.remove': cookieRemoveInput,
  'cookie.removeMany': v.strictObject({ cookies: v.pipe(v.array(cookieRemoveInput), v.minLength(1), v.maxLength(1_000)) }),
  'cookie.import': v.strictObject({ url, format: v.picklist(['json', 'netscape', 'set-cookie']), text: v.pipe(v.string(), v.maxLength(2 * 1024 * 1024)) }),
  'cookie.export': v.strictObject({ url, format: v.picklist(['json', 'netscape', 'set-cookie']), includeValues: v.boolean() }),
  'ua.save': userAgentRule,
  'ua.delete': v.strictObject({ id }),
  'ua.apply': noPayload,
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
  'observation.start': v.strictObject({
    ...targetFields,
    captureValues: v.optional(v.boolean()),
    maxEntries: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(10), v.maxValue(200))),
    maxValueBytes: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(256), v.maxValue(8_192))),
  }),
  'observation.status': v.strictObject(targetFields),
  'observation.list': v.strictObject({ ...targetFields, limit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(200))) }),
  'observation.clear': v.strictObject(targetFields),
  'observation.stop': v.strictObject(targetFields),
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
