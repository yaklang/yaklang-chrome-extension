import { browser } from 'wxt/browser';
import type {
  BrowserAuthContextAttestation,
  BrowserAuthContextHandle,
  BrowserAuthorizationBaseline,
  BrowserAuthorizationBaselineCandidate,
  BrowserAuthorizationBaselinePacket,
  BrowserAuthorizationCompiledRequest,
  BrowserAuthorizationLogicalRequestBinding,
  BrowserAuthorizationResourceSelector,
  BrowserAuthorizationResourceValue,
  BrowserAuthorizationTransformBinding,
  BrowserTarget,
  BrowserTransformProfile,
} from '@/types/models';
import {
  exportNetworkRequest,
  listNetworkRequests,
} from '@/features/network-capture/service';
import { ExtensionError } from '@/shared/errors';
import { getAuthContextHandle } from './auth-context';
import { getAuthContextAttestation } from './auth-attestation';
import {
  MAX_AUTHORIZATION_BASELINE_BYTES,
  MAX_AUTHORIZATION_BASELINE_FIELDS,
  normalizeAuthorizationPath,
  parseAuthorizationBaselineRequest,
} from './baseline-metadata';
import {
  applyAuthorizationTransformExecution,
  authorizationRequestToTransformPacket,
  compileAuthorizationBaselineRequest,
  extractAuthorizationResourceValue,
} from './baseline-execution';
import {
  executeBrowserTransform,
  getBrowserTransformProfile,
} from '@/features/browser-transform/service';
import { assertTransformRoute } from '@/features/browser-transform/mapping';
import { authorizationDynamicTransformDestinations } from './baseline-transform';
import {
  assertAuthorizationLogicalPacketStructure,
  authorizationPacketFingerprint,
  buildAuthorizationLogicalRequestBinding,
  decodeAndVerifyLogicalReplacement,
  loadAuthorizationLogicalRequestBinding,
  readAuthorizationLogicalResource,
  replaceAuthorizationLogicalResource,
} from './logical-binding';
import {
  browserTransformReplayDraftToPacket,
  getBrowserTransformReplayDraft,
} from '@/features/browser-transform/replay-draft';
import {
  readStructuredAuthorizationBodyValue,
} from './structured-body';

const MAX_BASELINES = 16;
const MAX_BASELINE_STORAGE_BYTES = 8 * 1_024 * 1_024;
const STORAGE_KEY = 'browser.authorization.baselines.v1';

function authorizationBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

interface StoredAuthorizationBaseline {
  snapshot: BrowserAuthorizationBaseline;
  rawRequestBase64: string;
  requestUrl: string;
  isHttps: boolean;
}

const baselines = new Map<string, StoredAuthorizationBaseline>();
let loaded = false;

function validAuthorizationRequestProtocol(value: {
  protocol?: unknown;
  operationFingerprint?: unknown;
  operationNames?: unknown;
} | undefined): boolean {
  if (!value) return false;
  if (value.protocol === undefined) {
    return value.operationFingerprint === undefined && value.operationNames === undefined;
  }
  return value.protocol === 'graphql'
    && /^sha256:[a-f0-9]{64}$/.test(String(value.operationFingerprint))
    && Array.isArray(value.operationNames)
    && value.operationNames.length > 0
    && value.operationNames.length <= 16
    && value.operationNames.every((name) => (
      typeof name === 'string'
      && (
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
        || /^(?:anonymous|batch-overflow)-[1-9][0-9]*$/.test(name)
      )
    ));
}

function validLogicalRequestBinding(
  value: unknown,
  snapshot: Partial<BrowserAuthorizationBaseline>,
): value is BrowserAuthorizationLogicalRequestBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Partial<BrowserAuthorizationLogicalRequestBinding>;
  return binding.version === 1
    && binding.source === 'local-replay-draft'
    && binding.baselineId === snapshot.id
    && typeof binding.profileId === 'string'
    && binding.profileId.length > 0
    && typeof binding.profileName === 'string'
    && binding.profileName.length > 0
    && binding.isolationContextId === snapshot.isolationContextId
    && binding.cookieStoreId === snapshot.cookieStoreId
    && binding.origin === snapshot.origin
    && binding.target?.tabId === snapshot.target?.tabId
    && binding.target?.frameId === snapshot.target?.frameId
    && binding.target?.documentId === snapshot.target?.documentId
    && Boolean(binding.request)
    && validAuthorizationRequestProtocol(binding.request)
    && /^sha256:[a-f0-9]{64}$/.test(String(binding.request?.actionFingerprint))
    && Array.isArray(binding.request?.fields)
    && binding.request.fields.length <= MAX_AUTHORIZATION_BASELINE_FIELDS
    && Array.isArray(binding.outputDestinations)
    && binding.outputDestinations.length > 0
    && binding.outputDestinations.length <= 32
    && /^sha256:[a-f0-9]{64}$/.test(String(binding.bindingFingerprint))
    && typeof binding.profileUpdatedAt === 'number'
    && typeof binding.replayUpdatedAt === 'number'
    && binding.expiresAt === snapshot.expiresAt;
}

function validStoredBaseline(value: unknown): value is StoredAuthorizationBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<StoredAuthorizationBaseline>;
  const snapshot = entry.snapshot as Partial<BrowserAuthorizationBaseline> | undefined;
  return snapshot?.version === 1
    && typeof snapshot.id === 'string'
    && snapshot.id.length > 0
    && typeof snapshot.deviceId === 'string'
    && typeof snapshot.installationId === 'string'
    && typeof snapshot.isolationContextId === 'string'
    && snapshot.isolationContextId.length > 0
    && typeof snapshot.cookieStoreId === 'string'
    && snapshot.cookieStoreId.length > 0
    && typeof snapshot.origin === 'string'
    && typeof snapshot.grantId === 'string'
    && typeof snapshot.networkRequestId === 'string'
    && Boolean(snapshot.target?.documentId)
    && ['handle', 'attestation'].includes(String(snapshot.authContextReference?.kind))
    && typeof snapshot.authContextReference?.id === 'string'
    && Boolean(snapshot.request)
    && validAuthorizationRequestProtocol(snapshot.request)
    && /^sha256:[a-f0-9]{64}$/.test(String(snapshot.request?.actionFingerprint))
    && Array.isArray(snapshot.request?.fields)
    && snapshot.request.fields.length <= MAX_AUTHORIZATION_BASELINE_FIELDS
    && typeof snapshot.createdAt === 'number'
    && typeof snapshot.expiresAt === 'number'
    && snapshot.expiresAt > snapshot.createdAt
    && typeof entry.rawRequestBase64 === 'string'
    && entry.rawRequestBase64.length <= Math.ceil(MAX_AUTHORIZATION_BASELINE_BYTES / 3) * 4 + 4
    && typeof entry.requestUrl === 'string'
    && entry.requestUrl.length <= 8_192
    && typeof entry.isHttps === 'boolean'
    && (
      snapshot.logicalRequest === undefined
      || validLogicalRequestBinding(snapshot.logicalRequest, snapshot)
    );
}

function purge(now = Date.now(), reserve = 0): boolean {
  let changed = false;
  for (const [id, baseline] of baselines) {
    if (baseline.snapshot.expiresAt <= now) {
      baselines.delete(id);
      changed = true;
    }
  }
  while (baselines.size > MAX_BASELINES - reserve) {
    const oldest = baselines.keys().next().value as string | undefined;
    if (!oldest) break;
    baselines.delete(oldest);
    changed = true;
  }
  return changed;
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await browser.storage.session.get(STORAGE_KEY);
    const values = stored[STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-MAX_BASELINES)) {
      if (validStoredBaseline(value)) baselines.set(value.snapshot.id, value);
    }
    purge();
  } catch {
    // The bounded in-memory registry remains available.
  }
}

async function save(): Promise<void> {
  try {
    const retained: StoredAuthorizationBaseline[] = [];
    for (const baseline of [...baselines.values()].reverse()) {
      const candidate = [baseline, ...retained];
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_BASELINE_STORAGE_BYTES) break;
      retained.unshift(baseline);
    }
    baselines.clear();
    for (const baseline of retained) baselines.set(baseline.snapshot.id, baseline);
    await browser.storage.session.set({ [STORAGE_KEY]: retained });
  } catch {
    // The bounded in-memory registry remains available.
  }
}

async function authContext(
  kind: 'handle' | 'attestation',
  id: string,
  grantId: string,
): Promise<BrowserAuthContextHandle | BrowserAuthContextAttestation> {
  return kind === 'handle'
    ? getAuthContextHandle(id, grantId)
    : getAuthContextAttestation(id, grantId);
}

function sameTarget(
  left: BrowserTarget,
  right: BrowserTarget,
): boolean {
  return left.tabId === right.tabId
    && left.frameId === right.frameId
    && left.documentId === right.documentId;
}

function authorizationDocumentOrigin(url: URL): string {
  if (url.protocol === 'ws:') return `http://${url.host}`;
  if (url.protocol === 'wss:') return `https://${url.host}`;
  return url.origin;
}

export async function captureAuthorizationBaseline(input: {
  target: BrowserTarget;
  grantId: string;
  authContextKind: 'handle' | 'attestation';
  authContextId: string;
  networkRequestId: string;
  comparisonKey: string;
}): Promise<BrowserAuthorizationBaseline> {
  await load();
  const context = await authContext(input.authContextKind, input.authContextId, input.grantId);
  if (!sameTarget(context.target, input.target)) {
    throw new ExtensionError('target_denied', '授权基线请求与认证上下文不属于同一页面文档');
  }
  const exported = await exportNetworkRequest(input.target, input.networkRequestId);
  const exportedURL = new URL(exported.url);
  if (exportedURL.protocol === 'ws:' || exportedURL.protocol === 'wss:') {
    throw new ExtensionError(
      'authorization_protocol_unsupported',
      'WebSocket 握手不能作为 HTTP 授权基线；请在录制中检查消息帧，当前版本不会把握手误当成可重放业务请求',
    );
  }
  if (authorizationDocumentOrigin(exportedURL) !== context.origin) {
    throw new ExtensionError('origin_changed', '授权基线请求与认证上下文来源不一致');
  }
  if (exported.limitations.length) {
    throw new ExtensionError(
      'authorization_baseline_incomplete',
      `捕获请求不完整：${exported.limitations.join('；')}`,
    );
  }
  const now = Date.now();
  const snapshot: BrowserAuthorizationBaseline = {
    version: 1,
    id: crypto.randomUUID(),
    deviceId: context.deviceId,
    installationId: context.installationId,
    isolationContextId: context.isolationContextId,
    cookieStoreId: context.cookieStoreId,
    origin: context.origin,
    grantId: context.grantId,
    target: context.target,
    authContextReference: {
      kind: input.authContextKind,
      id: context.id,
    },
    networkRequestId: input.networkRequestId,
    request: await parseAuthorizationBaselineRequest(
      exported.rawRequestBase64,
      exported.url,
      input.comparisonKey,
    ),
    createdAt: now,
    expiresAt: context.expiresAt,
  };
  if (snapshot.expiresAt <= now) {
    throw new ExtensionError('auth_context_stale', '认证上下文已经过期');
  }
  purge(now, 1);
  baselines.set(snapshot.id, {
    snapshot,
    rawRequestBase64: exported.rawRequestBase64,
    requestUrl: exported.url,
    isHttps: exported.isHttps,
  });
  await save();
  return snapshot;
}

export async function listAuthorizationBaselineCandidates(input: {
  target: BrowserTarget;
  grantId: string;
  authContextKind: 'handle' | 'attestation';
  authContextId: string;
  limit: number;
}): Promise<BrowserAuthorizationBaselineCandidate[]> {
  const context = await authContext(input.authContextKind, input.authContextId, input.grantId);
  if (!sameTarget(context.target, input.target)) {
    throw new ExtensionError('target_denied', '网络候选与认证上下文不属于同一页面文档');
  }
  const records = await listNetworkRequests(input.target, input.limit);
  return records.flatMap((record) => {
    let parsed: URL;
    try {
      parsed = new URL(record.url);
    } catch {
      return [];
    }
    if (authorizationDocumentOrigin(parsed) !== context.origin) return [];
    const shapedPath = normalizeAuthorizationPath(parsed.pathname);
    const reasons: string[] = [];
    if (record.resourceType === 'websocket' || parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      reasons.push('WebSocket 当前仅保留握手与消息帧证据，不会进入 HTTP 授权矩阵');
    }
    if (!record.requestHeadersCaptured) reasons.push('未捕获实际请求头');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(record.method.toUpperCase())
      && !record.requestBody) {
      reasons.push(record.requestBodyCaptured ? '浏览器未提供请求体' : '未捕获请求体');
    }
    if (record.requestBody?.truncated) reasons.push('请求体已截断');
    if (record.requestBody?.reconstructed) reasons.push('请求体由浏览器字段重建');
    if (record.error) reasons.push(`请求失败：${record.error}`);
    return [{
      id: record.id,
      method: record.method,
      url: `${parsed.origin}${shapedPath.normalized}`,
      path: shapedPath.normalized,
      resourceType: record.resourceType,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      statusCode: record.statusCode,
      error: record.error,
      eligible: reasons.length === 0,
      reasons,
    }];
  });
}

async function validatedStoredBaseline(
  id: string,
  grantId: string,
  validateLogicalBinding = true,
): Promise<StoredAuthorizationBaseline> {
  await load();
  if (purge()) await save();
  const baseline = baselines.get(id);
  if (!baseline || baseline.snapshot.grantId !== grantId) {
    throw new ExtensionError('authorization_baseline_stale', '授权基线不存在、已过期或不属于当前共享会话');
  }
  try {
    const context = await authContext(
      baseline.snapshot.authContextReference.kind,
      baseline.snapshot.authContextReference.id,
      grantId,
    );
    if (!sameTarget(context.target, baseline.snapshot.target)) {
      throw new ExtensionError('authorization_baseline_stale', '授权基线的认证上下文已经变化');
    }
  } catch (error) {
    baselines.delete(id);
    await save();
    if (error instanceof ExtensionError && error.code === 'authorization_baseline_stale') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtensionError('authorization_baseline_stale', `授权基线实时复核失败：${message}`);
  }
  if (validateLogicalBinding && baseline.snapshot.logicalRequest) {
    try {
      await loadAuthorizationLogicalRequestBinding({ baseline: baseline.snapshot });
    } catch {
      baseline.snapshot = {
        ...baseline.snapshot,
        logicalRequest: undefined,
      };
      baselines.set(id, baseline);
      await save();
    }
  }
  return baseline;
}

export async function getAuthorizationBaseline(
  id: string,
  grantId: string,
): Promise<BrowserAuthorizationBaseline> {
  return (await validatedStoredBaseline(id, grantId)).snapshot;
}

export async function bindAuthorizationBaselineLogicalRequest(input: {
  id: string;
  grantId: string;
  profileId: string;
  comparisonKey: string;
}): Promise<BrowserAuthorizationBaseline> {
  const baseline = await validatedStoredBaseline(input.id, input.grantId, false);
  const profile = await getBrowserTransformProfile(input.profileId);
  const draft = await getBrowserTransformReplayDraft(
    profile.id,
    'request',
    baseline.snapshot.origin,
  );
  if (!draft) {
    throw new ExtensionError(
      'authorization_logical_missing',
      '所选明文网关没有本机请求回放草稿，请先在明文网关中保存并验证回放输入',
    );
  }
  const logicalRequest = await buildAuthorizationLogicalRequestBinding({
    baseline: baseline.snapshot,
    rawRequestBase64: baseline.rawRequestBase64,
    profile,
    draft,
    comparisonKey: input.comparisonKey,
  });
  baseline.snapshot = {
    ...baseline.snapshot,
    logicalRequest,
  };
  baselines.set(baseline.snapshot.id, baseline);
  await save();
  return baseline.snapshot;
}

function selectedBaselineField(
  baseline: BrowserAuthorizationBaseline,
  selector: BrowserAuthorizationResourceSelector,
) {
  const sourceFields = selector.source === 'logical'
    ? baseline.logicalRequest?.request.fields
    : baseline.request.fields;
  const fields = (sourceFields || []).filter(
    (field) => field.location === selector.location && field.path === selector.path,
  );
  if (fields.length !== 1) {
    throw new ExtensionError(
      fields.length ? 'authorization_selector_ambiguous' : 'authorization_selector_invalid',
      fields.length ? '授权资源字段在基线中不唯一' : '授权资源字段不属于该请求基线',
    );
  }
  if (!['string', 'number', 'boolean'].includes(fields[0].valueType)) {
    throw new ExtensionError(
      'authorization_selector_invalid',
      '自动矩阵仅支持字符串、数字或布尔资源值',
    );
  }
  return fields[0];
}

export async function readAuthorizationBaselineResource(input: {
  id: string;
  grantId: string;
  selector: BrowserAuthorizationResourceSelector;
}): Promise<BrowserAuthorizationResourceValue> {
  const baseline = await validatedStoredBaseline(input.id, input.grantId);
  const selected = selectedBaselineField(baseline.snapshot, input.selector);
  if (input.selector.source === 'logical') {
    return readAuthorizationLogicalResource({
      baseline: baseline.snapshot,
      selector: input.selector,
    });
  }
  if (input.selector.location === 'body') {
    const value = readStructuredAuthorizationBodyValue(
      authorizationRequestToTransformPacket(
        baseline.rawRequestBase64,
        baseline.snapshot.origin,
      ),
      input.selector.path,
    );
    const bytes = new TextEncoder().encode(value.text);
    if (bytes.byteLength > 8 * 1_024) {
      throw new ExtensionError(
        'authorization_value_too_large',
        '授权 Body 资源值超过 8 KiB 上限',
      );
    }
    return {
      version: 1,
      baselineId: baseline.snapshot.id,
      source: 'wire',
      location: 'body',
      path: input.selector.path,
      valueType: value.valueType,
      byteLength: bytes.byteLength,
      valueBase64: authorizationBytesToBase64(bytes),
      valueFingerprint: selected.valueFingerprint,
    };
  }
  const wireSelector = {
    location: input.selector.location,
    path: input.selector.path,
  };
  return extractAuthorizationResourceValue(
    baseline.requestUrl,
    baseline.rawRequestBase64,
    baseline.snapshot.id,
    wireSelector,
    selected.valueFingerprint,
  );
}

export async function compileAuthorizationBaseline(input: {
  id: string;
  grantId: string;
  selector: BrowserAuthorizationResourceSelector;
  replacement: BrowserAuthorizationResourceValue;
  comparisonKey: string;
}): Promise<BrowserAuthorizationCompiledRequest> {
  const baseline = await validatedStoredBaseline(input.id, input.grantId);
  if (input.selector.source !== 'wire') {
    throw new ExtensionError('authorization_selector_invalid', '直接编译只接受线上报文资源字段');
  }
  const wireSelector = {
    source: 'wire' as const,
    location: input.selector.location,
    path: input.selector.path,
  };
  selectedBaselineField(baseline.snapshot, input.selector);
  return compileAuthorizationBaselineRequest({
    baselineId: baseline.snapshot.id,
    rawRequestBase64: baseline.rawRequestBase64,
    requestUrl: baseline.requestUrl,
    publicUrl: baseline.snapshot.request.url,
    selector: wireSelector,
    replacement: input.replacement,
    comparisonKey: input.comparisonKey,
    isHttps: baseline.isHttps,
  });
}

export async function compileAuthorizationBaselinePacket(input: {
  id: string;
  grantId: string;
}): Promise<BrowserAuthorizationBaselinePacket> {
  const baseline = await validatedStoredBaseline(input.id, input.grantId);
  return {
    version: 1,
    baselineId: baseline.snapshot.id,
    method: baseline.snapshot.request.method,
    url: baseline.snapshot.request.url,
    isHttps: baseline.isHttps,
    rawRequestBase64: baseline.rawRequestBase64,
    packetFingerprint: await authorizationPacketFingerprint(baseline.rawRequestBase64),
  };
}

async function authorizationTransformFingerprint(input: {
  baselineId: string;
  profileId: string;
  profileUpdatedAt: number;
  documentId: string;
  isolationContextId: string;
  cookieStoreId: string;
  dynamicPaths: string[];
  logicalBindingFingerprint?: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function validatedAuthorizationTransform(input: {
  id: string;
  grantId: string;
  profileId: string;
}): Promise<{
  baseline: StoredAuthorizationBaseline;
  profile: BrowserTransformProfile;
  binding: BrowserAuthorizationTransformBinding;
  logical?: Awaited<ReturnType<typeof loadAuthorizationLogicalRequestBinding>>;
}> {
  const baseline = await validatedStoredBaseline(input.id, input.grantId);
  const profile = await getBrowserTransformProfile(input.profileId);
  const target = baseline.snapshot.target;
  if (
    profile.target.tabId !== target.tabId
    || profile.target.frameId !== target.frameId
    || profile.target.documentId !== target.documentId
    || profile.origin !== baseline.snapshot.origin
    || profile.isolationContextId !== baseline.snapshot.isolationContextId
    || profile.cookieStoreId !== baseline.snapshot.cookieStoreId
  ) {
    throw new ExtensionError(
      'authorization_transform_target_mismatch',
      '明文网关必须绑定授权基线所属的同一身份、Frame 与页面文档',
    );
  }
  const logical = baseline.snapshot.logicalRequest?.profileId === profile.id
    ? await loadAuthorizationLogicalRequestBinding({
      baseline: baseline.snapshot,
      profileId: profile.id,
    })
    : undefined;
  const packet = logical
    ? browserTransformReplayDraftToPacket(logical.draft)
    : authorizationRequestToTransformPacket(
      baseline.rawRequestBase64,
      baseline.snapshot.origin,
    );
  assertTransformRoute(
    profile.match.methods,
    profile.match.urlPattern,
    packet,
    profile.origin,
  );
  const dynamicPaths = logical
    ? logical.binding.outputDestinations
    : authorizationDynamicTransformDestinations(baseline.snapshot, profile);
  const createdAt = Date.now();
  const binding: BrowserAuthorizationTransformBinding = {
    version: 1,
    baselineId: baseline.snapshot.id,
    profileId: profile.id,
    profileName: profile.name,
    isolationContextId: baseline.snapshot.isolationContextId,
    cookieStoreId: baseline.snapshot.cookieStoreId,
    target,
    origin: baseline.snapshot.origin,
    dynamicPaths,
    bindingFingerprint: await authorizationTransformFingerprint({
      baselineId: baseline.snapshot.id,
      profileId: profile.id,
      profileUpdatedAt: profile.updatedAt,
      documentId: target.documentId,
      isolationContextId: baseline.snapshot.isolationContextId,
      cookieStoreId: baseline.snapshot.cookieStoreId,
      dynamicPaths,
      logicalBindingFingerprint: logical?.binding.bindingFingerprint,
    }),
    createdAt,
    expiresAt: baseline.snapshot.expiresAt,
  };
  return { baseline, profile, binding, logical };
}

export async function inspectAuthorizationBaselineTransform(input: {
  id: string;
  grantId: string;
  profileId: string;
}): Promise<BrowserAuthorizationTransformBinding> {
  return (await validatedAuthorizationTransform(input)).binding;
}

export async function compileAuthorizationBaselineWithTransform(input: {
  id: string;
  grantId: string;
  selector: BrowserAuthorizationResourceSelector;
  replacement: BrowserAuthorizationResourceValue;
  comparisonKey: string;
  profileId: string;
  bindingFingerprint: string;
}): Promise<BrowserAuthorizationCompiledRequest> {
  const {
    baseline,
    profile,
    binding,
    logical,
  } = await validatedAuthorizationTransform(input);
  if (binding.bindingFingerprint !== input.bindingFingerprint) {
    throw new ExtensionError(
      'authorization_transform_changed',
      '明文网关或页面文档已变化，请重新编译授权矩阵',
    );
  }
  selectedBaselineField(baseline.snapshot, input.selector);
  if (input.selector.source === 'logical') {
    if (!logical || input.selector.location !== 'body') {
      throw new ExtensionError(
        'authorization_logical_missing',
        '逻辑资源编译当前要求同一明文网关绑定下的 JSON/Form Body 字段',
      );
    }
    const replacement = await decodeAndVerifyLogicalReplacement({
      replacement: input.replacement,
      selector: input.selector,
      comparisonKey: input.comparisonKey,
    });
    const logicalPacket = replaceAuthorizationLogicalResource({
      packet: browserTransformReplayDraftToPacket(logical.draft),
      selector: input.selector,
      replacement,
    });
    const execution = await executeBrowserTransform({
      profileId: profile.id,
      direction: 'request',
      packet: logicalPacket,
    });
    const compiled: BrowserAuthorizationCompiledRequest = {
      version: 1,
      baselineId: baseline.snapshot.id,
      selector: input.selector,
      method: baseline.snapshot.request.method,
      url: baseline.snapshot.request.url,
      isHttps: baseline.isHttps,
      rawRequestBase64: baseline.rawRequestBase64,
      resourceValueFingerprint: input.replacement.valueFingerprint,
      logicalBindingFingerprint: logical.binding.bindingFingerprint,
      packetFingerprint: await authorizationPacketFingerprint(baseline.rawRequestBase64),
    };
    const compiledWithTransform = await applyAuthorizationTransformExecution({
      compiled,
      execution,
      origin: baseline.snapshot.origin,
      allowedDestinations: binding.dynamicPaths,
      allowBody: true,
    });
    assertAuthorizationLogicalPacketStructure(
      authorizationRequestToTransformPacket(
        compiledWithTransform.rawRequestBase64,
        baseline.snapshot.origin,
      ),
      authorizationRequestToTransformPacket(
        baseline.rawRequestBase64,
        baseline.snapshot.origin,
      ),
    );
    return compiledWithTransform;
  }
  const wireSelector = {
    source: 'wire' as const,
    location: input.selector.location,
    path: input.selector.path,
  };
  const compiled = await compileAuthorizationBaselineRequest({
    baselineId: baseline.snapshot.id,
    rawRequestBase64: baseline.rawRequestBase64,
    requestUrl: baseline.requestUrl,
    publicUrl: baseline.snapshot.request.url,
    selector: wireSelector,
    replacement: input.replacement,
    comparisonKey: input.comparisonKey,
    isHttps: baseline.isHttps,
  });
  const execution = await executeBrowserTransform({
    profileId: profile.id,
    direction: 'request',
    packet: authorizationRequestToTransformPacket(
      compiled.rawRequestBase64,
      baseline.snapshot.origin,
    ),
  });
  return applyAuthorizationTransformExecution({
    compiled,
    execution,
    origin: baseline.snapshot.origin,
    allowedDestinations: binding.dynamicPaths,
  });
}
