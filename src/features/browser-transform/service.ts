import { browser } from 'wxt/browser';
import * as v from 'valibot';
import {
  deletePageCallable,
  executePageTransformDirection,
  listPageCallables,
} from '@/features/page-callable/service';
import {
  createCapturedPageCallable,
  deepCaptureStatus,
  detachDeepCapture,
  startDeepCapture,
  type DeepCaptureOwner,
} from '@/features/deep-capture/service';
import { getTab, resolveDocumentTarget } from '@/platform/browser/targets';
import { browserTransformProfileSchema } from '@/protocol/transform';
import type {
  BrowserDeepCaptureStatus,
  BrowserPageCallable,
  BrowserTarget,
  BrowserTransformExecuteInput,
  BrowserTransformExecution,
  BrowserTransformDirectionName,
  BrowserTransformPacket,
  BrowserTransformPipelineNode,
  BrowserTransformProfile,
  BrowserTransformProfileInput,
  BrowserTransformRequestTransactionBinding,
  BrowserTransformRecoveryPlan,
  BrowserTransformRecoveryValidationResult,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { assertTransformDirection, assertTransformRoute } from './mapping';
import {
  acquireTransformExecutionGate,
  createTransformExecutionGate,
  type TransformExecutionGate,
} from './concurrency';
import { deleteBrowserTransformReplayDrafts } from './replay-draft';
import { listCookies } from '@/features/cookies/service';
import {
  compileBrowserTransformRecoveryDirections,
  createBrowserTransformRecoveryPlan,
  recoveryTargetMatches,
  staleBrowserTransformProfile,
} from './recovery-plan';
import { createBrowserTransformExplanation } from './explanation';

const STORAGE_KEY = 'browser-transform-profiles.v4';
const MAX_PROFILES = 64;
const MAX_QUEUE_DEPTH = 128;
const RECOVERY_VALIDATION_TTL_MS = 30 * 60 * 1_000;

interface ProfileStore {
  profiles: BrowserTransformProfile[];
}

const mutationQueues = new Map<string, Promise<void>>();
const executionGates = new Map<string, TransformExecutionGate>();
let initialized = false;

function profileOrigin(value: string): string {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

function normalizeDirection(input: BrowserTransformProfileInput['request']): BrowserTransformProfileInput['request'] {
  return {
    enabled: input.enabled,
    nodes: input.nodes.slice(0, 64).map((node): BrowserTransformPipelineNode => {
      const base = { id: node.id.trim().slice(0, 160) || crypto.randomUUID(), name: node.name.trim().slice(0, 120) };
      const reference = (value: { nodeId: string; path?: string }) => ({
        nodeId: value.nodeId.trim().slice(0, 160),
        path: value.path?.trim().slice(0, 512) || undefined,
      });
      if (node.kind === 'context.read') return { ...base, kind: node.kind, path: node.path.trim().slice(0, 512) };
      if (node.kind === 'builtin') return {
        ...base,
        kind: node.kind,
        operation: node.operation,
        inputs: node.inputs.slice(0, 64).map(reference),
        options: node.options ? structuredClone(node.options) : undefined,
      };
      if (node.kind === 'page.call') return {
        ...base,
        kind: node.kind,
        callableId: node.callableId.trim().slice(0, 160),
        arguments: node.arguments.slice(0, 64).map(reference),
      };
      return {
        ...base,
        kind: node.kind,
        destination: node.destination.trim().slice(0, 512),
        source: reference(node.source),
        encoding: node.encoding,
      };
    }),
  };
}

interface TransformIsolationBinding {
  isolationContextId: string;
  cookieStoreId?: string;
}

async function currentTransformIsolation(target: BrowserTarget): Promise<TransformIsolationBinding> {
  const tab = await getTab(target.tabId);
  if (!tab.isolationContextId) {
    throw new ExtensionError('isolation_unavailable', '无法确认明文网关页面所属的身份隔离上下文');
  }
  return {
    isolationContextId: tab.isolationContextId,
    cookieStoreId: tab.cookieStoreId,
  };
}

function assertProfileIsolation(
  profile: Pick<BrowserTransformProfile, 'isolationContextId' | 'cookieStoreId'>,
  binding: TransformIsolationBinding,
): void {
  if (
    profile.isolationContextId !== binding.isolationContextId
    || profile.cookieStoreId !== binding.cookieStoreId
  ) {
    throw new ExtensionError(
      'isolation_stale',
      '明文网关绑定的身份隔离上下文已经变化，请重新录制并创建网关',
    );
  }
}

function normalizeProfile(
  input: BrowserTransformProfileInput,
  isolation: TransformIsolationBinding,
  previous?: BrowserTransformProfile,
): BrowserTransformProfile {
  const now = Date.now();
  const name = input.name.trim().slice(0, 120);
  const origin = profileOrigin(input.origin);
  if (!name) throw new ExtensionError('transform_profile_invalid', '转换配置名称不能为空');
  if (!origin || origin !== input.origin) throw new ExtensionError('transform_profile_invalid', '转换配置必须绑定有效的 HTTP(S) 页面来源');
  if (!Number.isSafeInteger(input.target.tabId) || input.target.tabId < 1 || !Number.isSafeInteger(input.target.frameId) || input.target.frameId < 0) {
    throw new ExtensionError('transform_profile_invalid', '转换配置的浏览器目标无效');
  }
  const methods = [...new Set(input.match.methods.map((method) => method.trim().toUpperCase()).filter(Boolean))].slice(0, 16);
  if (methods.some((method) => !/^[A-Z][A-Z0-9_-]{0,31}$/.test(method))) {
    throw new ExtensionError('transform_profile_invalid', '转换配置包含无效的 HTTP 方法');
  }
  const urlPattern = input.match.urlPattern.trim().slice(0, 2_048) || '*';
  const profile: BrowserTransformProfile = {
    id: previous?.id || input.id?.trim().slice(0, 160) || crypto.randomUUID(),
    name,
    enabled: input.enabled,
    target: { ...input.target },
    isolationContextId: isolation.isolationContextId,
    cookieStoreId: isolation.cookieStoreId,
    origin,
    match: { methods, urlPattern },
    request: normalizeDirection(input.request),
    response: normalizeDirection(input.response),
    failMode: 'closed',
    maxConcurrency: Math.max(1, Math.min(8, Math.floor(input.maxConcurrency || 1))),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  if (profile.request.enabled) assertTransformDirection(profile.request);
  if (profile.response.enabled) assertTransformDirection(profile.response);
  if (!profile.request.enabled && !profile.response.enabled) {
    throw new ExtensionError('transform_profile_invalid', '转换配置必须至少启用请求或响应方向');
  }
  return profile;
}

async function readStore(): Promise<ProfileStore> {
  const stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!stored || typeof stored !== 'object' || !Array.isArray((stored as ProfileStore).profiles)) return { profiles: [] };
  const profiles: BrowserTransformProfile[] = [];
  for (const candidate of (stored as ProfileStore).profiles.slice(0, MAX_PROFILES)) {
    const parsed = v.safeParse(browserTransformProfileSchema, candidate);
    if (parsed.success) profiles.push(parsed.output as BrowserTransformProfile);
  }
  return { profiles };
}

async function mutateStore<T>(key: string, mutate: (store: ProfileStore) => Promise<[ProfileStore, T]> | [ProfileStore, T]): Promise<T> {
  const previous = mutationQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  mutationQueues.set(key, queued);
  await previous;
  try {
    const [next, result] = await mutate(await readStore());
    await browser.storage.local.set({ [STORAGE_KEY]: next });
    return result;
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

export async function listBrowserTransformProfiles(target?: Partial<BrowserTarget>): Promise<BrowserTransformProfile[]> {
  const profiles = (await readStore()).profiles;
  return profiles.filter((profile) => (
    (target?.tabId === undefined || profile.target.tabId === target.tabId)
    && (target?.frameId === undefined || profile.target.frameId === target.frameId)
    && (target?.documentId === undefined || profile.target.documentId === target.documentId)
  )).sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getBrowserTransformProfile(id: string): Promise<BrowserTransformProfile> {
  const profile = (await readStore()).profiles.find((item) => item.id === id);
  if (!profile) throw new ExtensionError('transform_profile_not_found', '浏览器转换配置不存在或已删除');
  return profile;
}

export async function saveBrowserTransformProfile(input: BrowserTransformProfileInput): Promise<BrowserTransformProfile> {
  const target = await resolveDocumentTarget(input.target);
  const isolation = await currentTransformIsolation(target);
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  const origin = profileOrigin(frame?.url || '');
  if (!origin || origin !== input.origin) throw new ExtensionError('origin_changed', '目标页面来源已经变化，请重新绑定转换配置');
  const callables = await assertProfileCallablesAvailable(target, input);
  const requestTransaction = deriveRequestTransactionBinding(input, callables);
  return mutateStore('profiles', (store) => {
    const previous = input.id ? store.profiles.find((profile) => profile.id === input.id) : undefined;
    if (previous && (previous.target.tabId !== target.tabId
      || previous.target.frameId !== target.frameId
      || previous.target.documentId !== target.documentId
      || previous.origin !== input.origin)) {
      throw new ExtensionError('transform_target_changed', '现有转换配置不能改绑到另一个页面文档，请新建配置');
    }
    if (previous) assertProfileIsolation(previous, isolation);
    const normalized = withRequestTransactionBinding(
      normalizeProfile({
        ...input,
        target,
        maxConcurrency: transactionSafeConcurrency(input, callables),
      }, isolation, previous),
      requestTransaction,
    );
    const explained = withTransformExplanation(normalized, callables, previous);
    const profileWithPreviousRecovery = previous?.recovery
      ? { ...explained, recovery: previous.recovery }
      : explained;
    const recovery = createBrowserTransformRecoveryPlan(profileWithPreviousRecovery, callables);
    const profile = recovery ? { ...explained, recovery } : explained;
    const profiles = [profile, ...store.profiles.filter((item) => item.id !== profile.id)].slice(0, MAX_PROFILES);
    return [{ profiles }, profile];
  });
}

async function assertProfileCallablesAvailable(
  target: BrowserTarget,
  input: Pick<BrowserTransformProfileInput, 'request' | 'response'>,
): Promise<BrowserPageCallable[]> {
  const callables = await listPageCallables(target);
  const callableIds = new Set(callables.map((callable) => callable.id));
  const referenced = [
    ...(input.request.enabled ? input.request.nodes : []),
    ...(input.response.enabled ? input.response.nodes : []),
  ].filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'page.call' }> => node.kind === 'page.call')
    .map((node) => node.callableId);
  const missing = referenced.find((callableId) => !callableIds.has(callableId));
  if (missing) throw new ExtensionError('callable_unavailable', `页面函数已经失效: ${missing}`);
  return callables;
}

function transactionSafeConcurrency(
  input: Pick<BrowserTransformProfileInput, 'request' | 'response' | 'maxConcurrency'>,
  callables: BrowserPageCallable[],
): number {
  const referenced = new Set([
    ...(input.request.enabled ? input.request.nodes : []),
    ...(input.response.enabled ? input.response.nodes : []),
  ].flatMap((node) => node.kind === 'page.call' ? [node.callableId] : []));
  return callables.some((callable) => referenced.has(callable.id) && callable.kind === 'request-transaction')
    ? 1
    : input.maxConcurrency;
}

function deriveRequestTransactionBinding(
  input: Pick<BrowserTransformProfileInput, 'request' | 'response'>,
  callables: BrowserPageCallable[],
): BrowserTransformRequestTransactionBinding | undefined {
  const byId = new Map(callables.map((callable) => [callable.id, callable]));
  const nodes = (['request', 'response'] as const).flatMap((direction) => (
    input[direction].enabled
      ? input[direction].nodes.flatMap((node) => {
        if (node.kind !== 'page.call') return [];
        const callable = byId.get(node.callableId);
        return callable?.kind === 'request-transaction' ? [{ direction, callable }] : [];
      })
      : []
  ));
  if (!nodes.length) return undefined;
  if (nodes.length !== 1) {
    throw new ExtensionError(
      'transform_profile_invalid',
      '一个明文网关只能引用一个终止请求事务；请先在页面业务函数内保留完整 envelope',
    );
  }
  const [{ direction, callable }] = nodes;
  if (direction !== 'request') {
    throw new ExtensionError('transform_profile_invalid', '请求事务只能用于请求转换方向');
  }
  if (!callable.transaction) {
    throw new ExtensionError('transform_profile_invalid', '请求事务缺少扩展验证过的网络计划');
  }
  return {
    callableId: callable.id,
    transaction: structuredClone(callable.transaction),
  };
}

function withRequestTransactionBinding(
  profile: BrowserTransformProfile,
  binding: BrowserTransformRequestTransactionBinding | undefined,
): BrowserTransformProfile {
  return binding ? { ...profile, requestTransaction: binding } : profile;
}

function withTransformExplanation(
  profile: BrowserTransformProfile,
  callables: BrowserPageCallable[],
  previous?: BrowserTransformProfile,
): BrowserTransformProfile {
  return {
    ...profile,
    explanation: createBrowserTransformExplanation(profile, callables, previous?.explanation),
  };
}

function assertRequestTransactionPacket(
  profile: BrowserTransformProfile,
  packet: BrowserTransformPacket,
): void {
  const request = profile.requestTransaction?.transaction.request;
  if (!request) return;
  const method = (packet.method || '').toUpperCase();
  let actualUrl: string;
  let expectedUrl: string;
  try {
    const actual = new URL(packet.url, `${profile.origin}/`);
    const expected = new URL(request.url, `${profile.origin}/`);
    actualUrl = `${actual.origin}${actual.pathname}${actual.search}`;
    expectedUrl = `${expected.origin}${expected.pathname}${expected.search}`;
  } catch {
    throw new ExtensionError('transform_route_mismatch', '请求事务无法验证当前数据包 URL');
  }
  if (method !== request.method.toUpperCase() || actualUrl !== expectedUrl) {
    throw new ExtensionError(
      'transform_route_mismatch',
      `请求事务只允许 ${request.method.toUpperCase()} ${expectedUrl}`,
    );
  }
}

async function bindOnlineTransactionSession(
  profile: BrowserTransformProfile,
  execution: BrowserTransformExecution,
): Promise<BrowserTransformExecution> {
  const transaction = profile.requestTransaction?.transaction;
  if (!transaction?.prerequisites.length) return execution;
  let requestUrl: string;
  try {
    requestUrl = new URL(transaction.request.url, `${profile.origin}/`).toString();
  } catch {
    throw new ExtensionError('transform_session_unavailable', '请求事务没有可解析的浏览器会话 URL');
  }
  let cookies;
  try {
    cookies = await listCookies(requestUrl, profile.cookieStoreId);
  } catch (cause) {
    throw new ExtensionError(
      'transform_session_unavailable',
      `无法读取在线请求事务绑定的浏览器 Cookie Store: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const cookieHeader = [...cookies]
    .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  const setHeaders = execution.setHeaders.filter((header) => header.name.toLowerCase() !== 'cookie');
  const removeHeaders = execution.removeHeaders.filter((name) => name.toLowerCase() !== 'cookie');
  if (cookieHeader) setHeaders.push({ name: 'Cookie', value: cookieHeader });
  else removeHeaders.push('Cookie');
  return { ...execution, setHeaders, removeHeaders };
}

function requireRecovery(profile: BrowserTransformProfile): BrowserTransformRecoveryPlan {
  if (!profile.recovery) {
    throw new ExtensionError('transform_recovery_unavailable', '这个明文网关没有可复用的页面捕获入口，需要重新录制并生成');
  }
  return profile.recovery;
}

async function updateRecovery(
  profileId: string,
  update: (profile: BrowserTransformProfile, recovery: BrowserTransformRecoveryPlan) => BrowserTransformProfile,
): Promise<BrowserTransformProfile> {
  return mutateStore('profiles', (store) => {
    const profile = store.profiles.find((item) => item.id === profileId);
    if (!profile) throw new ExtensionError('transform_profile_not_found', '浏览器转换配置不存在或已删除');
    const next = update(profile, requireRecovery(profile));
    return [{
      profiles: [next, ...store.profiles.filter((item) => item.id !== profileId)].slice(0, MAX_PROFILES),
    }, next];
  });
}

export async function invalidateBrowserTransformProfilesForDocument(
  target: BrowserTarget,
  reason = '页面已经刷新或导航，旧页面函数不可再执行',
): Promise<BrowserTransformProfile[]> {
  if (!target.documentId) return (await readStore()).profiles;
  return mutateStore('profiles', (store) => {
    let changed = false;
    const profiles = store.profiles.map((profile) => {
      const stale = profile.target.tabId === target.tabId
        && profile.target.frameId === target.frameId
        && Boolean(profile.target.documentId)
        && profile.target.documentId !== target.documentId;
      if (!stale) return profile;
      changed = true;
      return staleBrowserTransformProfile(profile, reason);
    });
    return [changed ? { profiles } : store, profiles];
  });
}

export async function invalidateBrowserTransformProfilesForCallable(
  target: BrowserTarget,
  callableId: string,
): Promise<BrowserTransformProfile[]> {
  return mutateStore('profiles', (store) => {
    let changed = false;
    const profiles = store.profiles.map((profile) => {
      const referencesCallable = profile.target.tabId === target.tabId
        && profile.target.frameId === target.frameId
        && (!target.documentId || profile.target.documentId === target.documentId)
        && [profile.request, profile.response]
          .flatMap((direction) => direction.enabled ? direction.nodes : [])
          .some((node) => node.kind === 'page.call' && node.callableId === callableId);
      if (!referencesCallable) return profile;
      changed = true;
      return staleBrowserTransformProfile(profile, '绑定的页面函数已被删除，需要重新捕获后再启用');
    });
    return [changed ? { profiles } : store, profiles];
  });
}

export function initializeBrowserTransformService(): void {
  if (initialized) return;
  initialized = true;
  browser.webNavigation.onCommitted.addListener((details) => {
    if (!details.documentId) return;
    void invalidateBrowserTransformProfilesForDocument({
      tabId: details.tabId,
      frameId: details.frameId,
      documentId: details.documentId,
    }).catch(console.error);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void mutateStore('profiles', (store) => {
      let changed = false;
      const profiles = store.profiles.map((profile) => {
        if (profile.target.tabId !== tabId) return profile;
        changed = true;
        return staleBrowserTransformProfile(profile, '绑定的浏览器标签页已经关闭');
      });
      return [changed ? { profiles } : store, profiles];
    }).catch(console.error);
  });
}

export async function getBrowserTransformRecovery(profileId: string): Promise<BrowserTransformRecoveryPlan> {
  return requireRecovery(await getBrowserTransformProfile(profileId));
}

export async function startBrowserTransformRecovery(
  profileId: string,
  owner: DeepCaptureOwner = { kind: 'local' },
): Promise<BrowserDeepCaptureStatus> {
  let profile = await getBrowserTransformProfile(profileId);
  let recovery = requireRecovery(profile);
  if (!recovery.capture.automatic) {
    throw new ExtensionError(
      'transform_recovery_manual',
      recovery.capture.reason || '当前明文网关需要人工确认页面函数映射',
    );
  }
  const target = await resolveDocumentTarget({
    tabId: profile.target.tabId,
    frameId: profile.target.frameId,
  });
  assertProfileIsolation(profile, await currentTransformIsolation(target));
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (profileOrigin(frame?.url || '') !== profile.origin) {
    throw new ExtensionError('origin_changed', '当前页面来源与明文网关不同，不能自动重新绑定');
  }
  if (profile.target.documentId !== target.documentId) {
    await invalidateBrowserTransformProfilesForDocument(target);
    profile = await getBrowserTransformProfile(profileId);
    recovery = requireRecovery(profile);
  }
  if (recovery.state === 'ready' && profile.enabled) {
    throw new ExtensionError('transform_recovery_not_needed', '当前明文网关仍然可用，不需要重新捕获');
  }
  await updateRecovery(profileId, (current, plan) => ({
    ...current,
    enabled: false,
    recovery: {
      ...plan,
      state: 'capturing',
      pending: undefined,
      validation: undefined,
      reason: '等待用户在目标页面重复一次原业务操作',
      updatedAt: Date.now(),
    },
    updatedAt: Date.now(),
  }));
  try {
    return await startDeepCapture(target, {
      kind: 'request',
      urlPattern: recovery.capture.urlPattern,
      frameHints: recovery.capture.frameHints,
    }, owner);
  } catch (error) {
    await updateRecovery(profileId, (current, plan) => ({
      ...current,
      recovery: {
        ...plan,
        state: 'failed',
        reason: '无法武装页面调试会话；处理浏览器调试占用后可以重试',
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }));
    throw error;
  }
}

export async function captureBrowserTransformRecovery(
  profileId: string,
  targetInput: BrowserTarget,
  callFrameId: string,
  strategy: 'selected-frame' | 'request-transaction',
  owner: DeepCaptureOwner = { kind: 'local' },
): Promise<BrowserTransformRecoveryPlan> {
  const profile = await getBrowserTransformProfile(profileId);
  const recovery = requireRecovery(profile);
  if (recovery.state !== 'capturing') {
    throw new ExtensionError('transform_recovery_state', '恢复计划当前没有等待捕获页面函数');
  }
  const captureStatus = await deepCaptureStatus(targetInput, owner);
  if (captureStatus.state !== 'paused' || !captureStatus.pause) {
    throw new ExtensionError('deep_capture_not_paused', '页面尚未停在目标密码调用，请重新执行一次真实业务操作');
  }
  const target = captureStatus.target;
  if (
    captureStatus.isolationContextId !== profile.isolationContextId
    || captureStatus.cookieStoreId !== profile.cookieStoreId
  ) {
    throw new ExtensionError('isolation_stale', '恢复现场不属于明文网关原来的身份隔离上下文');
  }
  if (
    targetInput.tabId !== target.tabId
    || targetInput.frameId !== target.frameId
    || (
      targetInput.documentId
      && target.documentId
      && targetInput.documentId !== target.documentId
    )
  ) {
    throw new ExtensionError('stale_document', '暂停的调用栈不属于当前恢复页面，请重新开始捕获');
  }
  if (target.tabId !== profile.target.tabId || target.frameId !== profile.target.frameId) {
    throw new ExtensionError('target_denied', '恢复计划只能在原浏览器标签页和 Frame 中重新捕获');
  }
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (profileOrigin(frame?.url || '') !== profile.origin) {
    throw new ExtensionError('origin_changed', '当前页面来源与明文网关不同，不能接收恢复结果');
  }
  let callable: BrowserPageCallable | undefined;
  try {
    callable = await createCapturedPageCallable(
      target,
      callFrameId,
      strategy === 'request-transaction'
        ? {
          strategy,
          name: recovery.binding.name,
          transaction: recovery.binding.transaction || (() => {
            throw new ExtensionError('transform_recovery_invalid', '恢复计划缺少原请求事务的在线依赖证据');
          })(),
        }
        : { strategy, name: recovery.binding.name },
      owner,
    );
    const directions = compileBrowserTransformRecoveryDirections(profile, recovery, callable);
    const updated = await updateRecovery(profileId, (current, plan) => ({
      ...current,
      enabled: false,
      recovery: {
        ...plan,
        state: 'validation-required',
        pending: {
          target,
          callableId: callable!.id,
          callableName: callable!.name,
          request: directions.request,
          response: directions.response,
          capturedAt: Date.now(),
        },
        validation: undefined,
        reason: '新页面函数已经捕获；使用本地回放样本验证后才能重新启用',
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }));
    return requireRecovery(updated);
  } catch (error) {
    if (callable) await deletePageCallable(target, callable.id).catch(() => undefined);
    await updateRecovery(profileId, (current, plan) => ({
      ...current,
      enabled: false,
      recovery: {
        ...plan,
        state: 'failed',
        pending: undefined,
        validation: undefined,
        reason: '新页面函数没有通过恢复契约检查；可以重新捕获或重新分析当前页面',
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }));
    throw error;
  }
}

function recoveryProfileInput(
  profile: BrowserTransformProfile,
  recovery: BrowserTransformRecoveryPlan,
  enabled: boolean,
): BrowserTransformProfileInput {
  if (!recovery.pending) throw new ExtensionError('transform_recovery_state', '恢复计划还没有捕获新的页面函数');
  return {
    id: profile.id,
    name: profile.name,
    enabled,
    target: { ...recovery.pending.target },
    origin: profile.origin,
    match: structuredClone(profile.match),
    request: structuredClone(recovery.pending.request),
    response: structuredClone(recovery.pending.response),
    failMode: 'closed',
    maxConcurrency: profile.maxConcurrency,
  };
}

export async function validateBrowserTransformRecovery(
  profileId: string,
  packet: BrowserTransformPacket,
): Promise<BrowserTransformRecoveryValidationResult> {
  const profile = await getBrowserTransformProfile(profileId);
  const recovery = requireRecovery(profile);
  if (recovery.state !== 'validation-required' && recovery.state !== 'confirmation-required') {
    throw new ExtensionError('transform_recovery_state', '请先重新捕获页面函数，再执行本地回放验证');
  }
  if (!recovery.pending) throw new ExtensionError('transform_recovery_state', '恢复计划还没有捕获新的页面函数');
  const currentTarget = await resolveDocumentTarget({
    tabId: recovery.pending.target.tabId,
    frameId: recovery.pending.target.frameId,
  });
  assertProfileIsolation(profile, await currentTransformIsolation(currentTarget));
  if (!recoveryTargetMatches(currentTarget, recovery.pending.target)) {
    await invalidateBrowserTransformProfilesForDocument(currentTarget);
    throw new ExtensionError('document_changed', '重新捕获后页面文档再次变化，请重新开始恢复');
  }
  try {
    const { execution } = await validateBrowserTransformProfile(
      recoveryProfileInput(profile, recovery, true),
      packet,
    );
    const now = Date.now();
    const validation = {
      id: crypto.randomUUID(),
      proofLevel: 'execution-only' as const,
      summary: '新页面函数已在当前文档真实执行，Pipeline 全部节点成功完成',
      validatedAt: now,
      expiresAt: now + RECOVERY_VALIDATION_TTL_MS,
    };
    const updated = await updateRecovery(profileId, (current, plan) => ({
      ...current,
      enabled: false,
      recovery: {
        ...plan,
        state: 'confirmation-required',
        validation,
        reason: '本地回放验证通过；确认后才会替换旧绑定并按原设置启用',
        updatedAt: now,
      },
      updatedAt: now,
    }));
    return { recovery: requireRecovery(updated), execution };
  } catch (error) {
    await updateRecovery(profileId, (current, plan) => ({
      ...current,
      enabled: false,
      recovery: {
        ...plan,
        state: 'validation-required',
        validation: undefined,
        reason: '本地回放没有通过；旧明文网关仍保持停用，可以修改输入后重试',
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }));
    throw error;
  }
}

export async function confirmBrowserTransformRecovery(
  profileId: string,
  validationId: string,
): Promise<BrowserTransformProfile> {
  const profile = await getBrowserTransformProfile(profileId);
  const recovery = requireRecovery(profile);
  if (recovery.state !== 'confirmation-required' || !recovery.validation || recovery.validation.id !== validationId) {
    throw new ExtensionError('transform_recovery_state', '恢复验证凭据不存在或已经被替换');
  }
  if (recovery.validation.expiresAt <= Date.now()) {
    throw new ExtensionError('transform_recovery_expired', '恢复验证已经过期，请重新执行本地回放');
  }
  if (!recovery.pending) throw new ExtensionError('transform_recovery_state', '恢复计划缺少新文档绑定');
  const target = await resolveDocumentTarget({
    tabId: recovery.pending.target.tabId,
    frameId: recovery.pending.target.frameId,
  });
  const isolation = await currentTransformIsolation(target);
  assertProfileIsolation(profile, isolation);
  if (!recoveryTargetMatches(target, recovery.pending?.target)) {
    await invalidateBrowserTransformProfilesForDocument(target);
    throw new ExtensionError('document_changed', '验证后页面文档再次变化，请重新捕获');
  }
  const input = recoveryProfileInput(profile, recovery, recovery.desiredEnabled);
  const callables = await assertProfileCallablesAvailable(target, input);
  const requestTransaction = deriveRequestTransactionBinding(input, callables);
  return mutateStore('profiles', (store) => {
    const current = store.profiles.find((item) => item.id === profileId);
    if (!current) throw new ExtensionError('transform_profile_not_found', '浏览器转换配置不存在或已删除');
    const currentRecovery = requireRecovery(current);
    if (currentRecovery.validation?.id !== validationId || currentRecovery.state !== 'confirmation-required') {
      throw new ExtensionError('transform_recovery_state', '恢复验证状态已经变化');
    }
    assertProfileIsolation(current, isolation);
    const normalized = withRequestTransactionBinding(
      normalizeProfile(input, isolation, current),
      requestTransaction,
    );
    const explained = withTransformExplanation(normalized, callables, current);
    const withPreviousRecovery = { ...explained, recovery: currentRecovery };
    const readyRecovery = createBrowserTransformRecoveryPlan(withPreviousRecovery, callables);
    if (!readyRecovery) throw new ExtensionError('transform_recovery_failed', '新页面函数没有生成可持续恢复的绑定');
    const ready = { ...explained, recovery: readyRecovery };
    return [{
      profiles: [ready, ...store.profiles.filter((item) => item.id !== profileId)].slice(0, MAX_PROFILES),
    }, ready];
  });
}

export async function resetBrowserTransformRecovery(
  profileId: string,
  owner: DeepCaptureOwner = { kind: 'local' },
): Promise<BrowserTransformRecoveryPlan> {
  const profile = await getBrowserTransformProfile(profileId);
  const recoveryTarget = {
    tabId: profile.target.tabId,
    frameId: profile.target.frameId,
  };
  const status = await deepCaptureStatus(recoveryTarget, owner).catch(() => undefined);
  if (status && status.state !== 'detached') {
    await detachDeepCapture(status.target, owner).catch(() => undefined);
  }
  const updated = await updateRecovery(profileId, (profile, recovery) => ({
    ...profile,
    enabled: false,
    recovery: {
      ...recovery,
      state: 'stale',
      pending: undefined,
      validation: undefined,
      reason: '恢复已取消；旧页面函数仍然失效，可以随时重新捕获',
      updatedAt: Date.now(),
    },
    updatedAt: Date.now(),
  }));
  return requireRecovery(updated);
}

export async function deleteBrowserTransformProfile(id: string): Promise<BrowserTransformProfile[]> {
  const profiles = await mutateStore('profiles', (store) => {
    const profiles = store.profiles.filter((profile) => profile.id !== id);
    executionGates.delete(id);
    return [{ profiles }, profiles];
  });
  await deleteBrowserTransformReplayDrafts(id);
  return profiles;
}

async function enterGate(profile: BrowserTransformProfile): Promise<() => void> {
  const gate = executionGates.get(profile.id) || createTransformExecutionGate();
  executionGates.set(profile.id, gate);
  const release = await acquireTransformExecutionGate(gate, profile.maxConcurrency, MAX_QUEUE_DEPTH);
  return () => {
    release();
    if (!gate.active && !gate.queued) executionGates.delete(profile.id);
  };
}

export async function executeBrowserTransform(input: BrowserTransformExecuteInput): Promise<BrowserTransformExecution> {
  const profile = await getBrowserTransformProfile(input.profileId);
  if (!profile.enabled) throw new ExtensionError('transform_profile_disabled', '浏览器转换配置已停用');
  const direction = profile[input.direction];
  if (!direction.enabled) throw new ExtensionError('transform_direction_disabled', `${input.direction === 'request' ? '请求' : '响应'}转换未启用`);
  assertTransformRoute(profile.match.methods, profile.match.urlPattern, input.packet, profile.origin);
  assertRequestTransactionPacket(profile, input.packet);
  let target: BrowserTarget;
  try {
    target = await resolveDocumentTarget(profile.target);
  } catch (error) {
    await updateRecovery(profile.id, (current) => staleBrowserTransformProfile(
      current,
      '页面文档已经变化，旧页面函数已停用并等待重新捕获',
    )).catch(() => undefined);
    throw error;
  }
  const isolation = await currentTransformIsolation(target);
  assertProfileIsolation(profile, isolation);
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (profileOrigin(frame?.url || '') !== profile.origin) {
    throw new ExtensionError('origin_changed', '转换配置绑定的页面来源已经变化，请重新绑定');
  }
  const leave = await enterGate(profile);
  try {
    const execution = await executePageTransformDirection(
      target,
      profile.id,
      input.direction,
      direction,
      input.packet,
    );
    return input.direction === 'request'
      ? await bindOnlineTransactionSession(profile, execution)
      : execution;
  } finally {
    leave();
  }
}

export async function validateBrowserTransformProfile(
  input: BrowserTransformProfileInput,
  packet: BrowserTransformExecuteInput['packet'],
): Promise<{ profile: BrowserTransformProfile; execution: BrowserTransformExecution }> {
  const target = await resolveDocumentTarget(input.target);
  const isolation = await currentTransformIsolation(target);
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (profileOrigin(frame?.url || '') !== input.origin) {
    throw new ExtensionError('origin_changed', '候选明文网关绑定的页面来源已经变化，请重新分析当前页面');
  }
  const callables = await assertProfileCallablesAvailable(target, input);
  const requestTransaction = deriveRequestTransactionBinding(input, callables);
  const normalized = withRequestTransactionBinding(
    normalizeProfile({
      ...input,
      id: `validation-${crypto.randomUUID()}`,
      target,
      maxConcurrency: transactionSafeConcurrency(input, callables),
    }, isolation),
    requestTransaction,
  );
  const profile = withTransformExplanation(normalized, callables);
  const directionName: BrowserTransformDirectionName = profile.request.enabled
    ? 'request'
    : profile.response.enabled ? 'response' : 'request';
  const direction = profile[directionName];
  if (!profile.enabled || !direction.enabled) {
    throw new ExtensionError('transform_direction_disabled', '候选明文网关没有启用任何转换方向');
  }
  assertTransformRoute(profile.match.methods, profile.match.urlPattern, packet, profile.origin);
  assertRequestTransactionPacket(profile, packet);
  const leave = await enterGate(profile);
  try {
    const execution = await executePageTransformDirection(target, profile.id, directionName, direction, packet);
    return {
      profile,
      execution: directionName === 'request'
        ? await bindOnlineTransactionSession(profile, execution)
        : execution,
    };
  } finally {
    leave();
  }
}
