import { browser } from 'wxt/browser';
import * as v from 'valibot';
import { executePageTransformDirection, listPageCallables } from '@/features/page-callable/service';
import { resolveDocumentTarget } from '@/platform/browser/targets';
import { browserTransformProfileSchema } from '@/protocol/transform';
import type {
  BrowserTarget,
  BrowserTransformExecuteInput,
  BrowserTransformExecution,
  BrowserTransformPipelineNode,
  BrowserTransformProfile,
  BrowserTransformProfileInput,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { assertTransformDirection, assertTransformRoute } from './mapping';
import {
  acquireTransformExecutionGate,
  createTransformExecutionGate,
  type TransformExecutionGate,
} from './concurrency';
import { deleteBrowserTransformReplayDrafts } from './replay-draft';

const STORAGE_KEY = 'browser-transform-profiles.v2';
const MAX_PROFILES = 64;
const MAX_QUEUE_DEPTH = 128;

interface ProfileStore {
  profiles: BrowserTransformProfile[];
}

const mutationQueues = new Map<string, Promise<void>>();
const executionGates = new Map<string, TransformExecutionGate>();

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

function normalizeProfile(input: BrowserTransformProfileInput, previous?: BrowserTransformProfile): BrowserTransformProfile {
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
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  const origin = profileOrigin(frame?.url || '');
  if (!origin || origin !== input.origin) throw new ExtensionError('origin_changed', '目标页面来源已经变化，请重新绑定转换配置');
  const callables = await listPageCallables(target);
  const callableIds = new Set(callables.map((callable) => callable.id));
  const referenced = [
    ...(input.request.enabled ? input.request.nodes : []),
    ...(input.response.enabled ? input.response.nodes : []),
  ].filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'page.call' }> => node.kind === 'page.call')
    .map((node) => node.callableId);
  const missing = referenced.find((callableId) => !callableIds.has(callableId));
  if (missing) throw new ExtensionError('callable_unavailable', `页面函数已经失效: ${missing}`);
  return mutateStore('profiles', (store) => {
    const previous = input.id ? store.profiles.find((profile) => profile.id === input.id) : undefined;
    if (previous && (previous.target.tabId !== target.tabId
      || previous.target.frameId !== target.frameId
      || previous.target.documentId !== target.documentId
      || previous.origin !== input.origin)) {
      throw new ExtensionError('transform_target_changed', '现有转换配置不能改绑到另一个页面文档，请新建配置');
    }
    const profile = normalizeProfile({ ...input, target }, previous);
    const profiles = [profile, ...store.profiles.filter((item) => item.id !== profile.id)].slice(0, MAX_PROFILES);
    return [{ profiles }, profile];
  });
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
  const target = await resolveDocumentTarget(profile.target);
  const frame = await browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId });
  if (profileOrigin(frame?.url || '') !== profile.origin) {
    throw new ExtensionError('origin_changed', '转换配置绑定的页面来源已经变化，请重新绑定');
  }
  const leave = await enterGate(profile);
  try {
    return await executePageTransformDirection(target, profile.id, input.direction, direction, input.packet);
  } finally {
    leave();
  }
}
