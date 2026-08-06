import { browser } from 'wxt/browser';
import { ExtensionError } from '@/shared/errors';
import type {
  BrowserDeepCaptureFrame,
  BrowserDeepCaptureMatcher,
  BrowserDeepCapturePause,
  BrowserDeepCaptureScope,
  BrowserDeepCaptureStatus,
  BrowserDeepCaptureVariable,
  BrowserDeepCaptureWorkerTarget,
  BrowserPageCallable,
  BrowserPageCallableTransaction,
  BrowserTransformCallableAnalysis,
  BrowserTarget,
} from '@/types/models';
import { parseFunctionParameterNames } from './function-parameters';
import { armBrowserRecordingDeepBreak, disarmBrowserRecordingDeepBreak } from '@/features/browser-recording/service';
import { PAGE_RECORDER_REGISTRY_KEY } from '@/features/browser-recording/constants';
import { normalizeCallable } from '@/features/page-callable/service';
import { PAGE_CALLABLE_REGISTRY_KEY } from '@/features/page-callable/constants';
import { rankBusinessFrames } from './business-frame-ranker';
import { getTab } from '@/platform/browser/targets';

interface Debuggee {
  tabId?: number;
  targetId?: string;
  sessionId?: string;
}

interface DebuggerEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
}

interface ChromeDebuggerAPI {
  attach(target: Debuggee, version: string): Promise<void>;
  detach(target: Debuggee): Promise<void>;
  getTargets(): Promise<Array<{ attached: boolean; tabId?: number; id: string; type: string; url: string }>>;
  sendCommand(target: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent: DebuggerEvent<(source: Debuggee, method: string, params?: Record<string, unknown>) => void>;
  onDetach: DebuggerEvent<(source: Debuggee, reason: string) => void>;
}

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  unserializableValue?: string;
}

interface InspectedFunctionCandidate {
  expression: string;
  resolution: Exclude<NonNullable<BrowserDeepCaptureFrame['functionInspection']>['resolution'], undefined>;
  parameterCount: number;
  parameterNames: string[];
  functionName: string;
  riskFlags: NonNullable<BrowserDeepCaptureFrame['functionInspection']>['riskFlags'];
  scriptId?: string;
  lineNumber?: number;
  score: number;
}

interface CDPScope {
  type?: string;
  name?: string;
  object?: CDPRemoteObject;
}

interface CDPCallFrame {
  callFrameId?: string;
  functionName?: string;
  location?: { scriptId?: string; lineNumber?: number; columnNumber?: number };
  url?: string;
  scopeChain?: CDPScope[];
  this?: CDPRemoteObject;
}

interface ScriptMetadata {
  url: string;
  sourceMapUrl?: string;
}

interface CDPTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
}

interface StoredWorkerTarget extends BrowserDeepCaptureWorkerTarget {
  sessionId: string;
}

export type DeepCaptureOwner = { kind: 'local' } | { kind: 'grant'; grantId: string; expiresAt: number };

interface StoredDeepCaptureStatus extends BrowserDeepCaptureStatus {
  owner: DeepCaptureOwner;
  origin?: string;
  workerTargets?: StoredWorkerTarget[];
  workerAutoAttachError?: string;
  requestBreakpoint?: string;
  functionBreakpointId?: string;
  functionObjectId?: string;
}

const STORAGE_KEY = 'session.deep-capture.v1';
const WATCHDOG_PREFIX = 'deep-capture-watchdog:';
const WATCHDOG_MS = 45_000;
const MAX_FRAMES = 14;
const MAX_SCOPE_FRAMES = 8;
const MAX_SCOPES_PER_FRAME = 6;
const MAX_VARIABLES_PER_SCOPE = 48;
const MAX_VALUE_PREVIEW = 512;
const MAX_VARIABLE_DETAIL = 4_096;
const MAX_SCOPE_DETAIL_BUDGET = 16_384;
const MAX_FUNCTION_CANDIDATES = 24;
const MAX_WORKER_TARGETS = 16;
const MAX_WORKER_SCRIPT_COUNT = 256;
const acceptedScopeTypes = new Set<BrowserDeepCaptureScope['type']>([
  'local', 'closure', 'module', 'block', 'catch', 'script', 'with', 'wasm-expression-stack',
]);

let initialized = false;
let storageQueue: Promise<void> = Promise.resolve();
const scriptMetadataByTab = new Map<number, Map<string, ScriptMetadata>>();
const workerScriptCounts = new Map<string, number>();
const debuggerEventQueues = new Map<number, Promise<void>>();
const intentionalDetaches = new Set<number>();
const resumeInProgress = new Set<number>();
const MAX_SCRIPT_URLS_PER_TAB = 4_096;
const DEEP_CAPTURE_BOUNDARY = {
  target: 'main-document',
  sourceMaps: 'metadata-only',
  workers: 'evidence-only',
  wasm: 'scope-evidence-only',
} as const;
const WORKER_TARGET_TYPES = new Set<BrowserDeepCaptureWorkerTarget['type']>([
  'worker', 'shared_worker', 'service_worker',
]);
const WORKER_TARGET_FILTER = [
  { type: 'worker', exclude: false },
  { type: 'shared_worker', exclude: false },
  { type: 'service_worker', exclude: false },
  { exclude: true },
];

function rememberScriptMetadata(tabId: number, scriptId: unknown, url: unknown, sourceMapUrl: unknown): void {
  if (typeof scriptId !== 'string' || !scriptId || typeof url !== 'string' || !url) return;
  let scripts = scriptMetadataByTab.get(tabId);
  if (!scripts) {
    scripts = new Map();
    scriptMetadataByTab.set(tabId, scripts);
  }
  if (scripts.has(scriptId)) scripts.delete(scriptId);
  scripts.set(scriptId, {
    url: url.slice(0, 4_096),
    sourceMapUrl: typeof sourceMapUrl === 'string' && sourceMapUrl
      ? sourceMapUrl.slice(0, 4_096)
      : undefined,
  });
  while (scripts.size > MAX_SCRIPT_URLS_PER_TAB) {
    const oldest = scripts.keys().next().value;
    if (typeof oldest !== 'string') break;
    scripts.delete(oldest);
  }
}

function chromeDebugger(): ChromeDebuggerAPI {
  const api = (globalThis as unknown as { chrome?: { debugger?: ChromeDebuggerAPI } }).chrome?.debugger;
  if (import.meta.env.FIREFOX || !api) {
    throw new ExtensionError('channel_unavailable', '深度捕获仅支持安装了 debugger 权限的 Chromium 研究版');
  }
  return api;
}

async function readStatuses(): Promise<Record<string, StoredDeepCaptureStatus>> {
  const stored = await browser.storage.session.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  return value && typeof value === 'object' ? value as Record<string, StoredDeepCaptureStatus> : {};
}

async function getStoredStatus(tabId: number): Promise<StoredDeepCaptureStatus | undefined> {
  return (await readStatuses())[String(tabId)];
}

async function writeStatus(status: StoredDeepCaptureStatus): Promise<void> {
  storageQueue = storageQueue.then(async () => {
    const statuses = await readStatuses();
    statuses[String(status.target.tabId)] = status;
    await browser.storage.session.set({ [STORAGE_KEY]: statuses });
  });
  await storageQueue;
  void browser.runtime.sendMessage({ action: 'deep.capture.changed', payload: { tabId: status.target.tabId } }).catch(() => undefined);
}

async function removeStatus(tabId: number): Promise<void> {
  storageQueue = storageQueue.then(async () => {
    const statuses = await readStatuses();
    delete statuses[String(tabId)];
    await browser.storage.session.set({ [STORAGE_KEY]: statuses });
  });
  await storageQueue;
}

function workerScriptKey(tabId: number, sessionId: string): string {
  return `${tabId}:${sessionId}`;
}

function clearWorkerRuntime(tabId: number, targets: StoredWorkerTarget[] = []): void {
  for (const target of targets) workerScriptCounts.delete(workerScriptKey(tabId, target.sessionId));
}

function closeWorkerTargets(targets: StoredWorkerTarget[] | undefined): StoredWorkerTarget[] | undefined {
  if (!targets?.length) return targets;
  const detachedAt = Date.now();
  return targets.map((target) => target.state === 'attached'
    ? { ...target, state: 'detached', detachedAt }
    : target);
}

function pageOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

function publicWorkerUrl(url: string | undefined): string {
  if (!url) return '(inline worker)';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:') return 'data:';
    if (parsed.protocol === 'blob:') {
      const origin = pageOrigin(url);
      return origin ? `blob:${origin}` : 'blob:';
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, 4_096);
  } catch {
    return '(inline worker)';
  }
}

function workerTargetAllowed(status: StoredDeepCaptureStatus, type: BrowserDeepCaptureWorkerTarget['type'], url: string): boolean {
  const origin = pageOrigin(url);
  if (origin && status.origin) return origin === status.origin;
  return type !== 'service_worker';
}

function publicStatus(status: StoredDeepCaptureStatus): BrowserDeepCaptureStatus {
  const {
    owner: _owner,
    origin: _origin,
    workerTargets,
    workerAutoAttachError,
    requestBreakpoint: _requestBreakpoint,
    functionBreakpointId: _functionBreakpointId,
    functionObjectId: _functionObjectId,
    ...output
  } = status;
  return {
    ...output,
    workerTargets: workerTargets?.map(({ sessionId, ...target }) => ({
      ...target,
      scriptCount: Math.max(target.scriptCount, workerScriptCounts.get(workerScriptKey(status.target.tabId, sessionId)) || 0),
    })),
    workerTargetError: workerAutoAttachError,
    boundary: {
      ...DEEP_CAPTURE_BOUNDARY,
      workers: workerAutoAttachError ? 'unavailable' : 'evidence-only',
    },
  };
}

function detachedStatus(target: BrowserTarget): BrowserDeepCaptureStatus {
  return { state: 'detached', target, boundary: DEEP_CAPTURE_BOUNDARY };
}

function debuggerTarget(tabId: number): Debuggee {
  return { tabId };
}

function assertSessionOwner(status: StoredDeepCaptureStatus, owner?: DeepCaptureOwner): void {
  if (!owner || owner.kind === 'local') return;
  if (status.owner.kind !== 'grant' || status.owner.grantId !== owner.grantId) {
    throw new ExtensionError('permission_denied', '该页面的深度捕获由另一个会话控制');
  }
}

function expiredGrantOwner(owner: DeepCaptureOwner): boolean {
  return owner.kind === 'grant'
    && (!Number.isFinite(owner.expiresAt) || owner.expiresAt <= Date.now());
}

async function sendCommand<T = unknown>(target: Debuggee, method: string, params?: Record<string, unknown>): Promise<T> {
  return await chromeDebugger().sendCommand(target, method, params) as T;
}

function workerAutoAttachParams(autoAttach: boolean): Record<string, unknown> {
  return {
    autoAttach,
    waitForDebuggerOnStart: false,
    flatten: true,
    ...(autoAttach ? { filter: WORKER_TARGET_FILTER } : {}),
  };
}

async function setWorkerAutoAttach(target: Debuggee, autoAttach: boolean): Promise<void> {
  await sendCommand(target, 'Target.setAutoAttach', workerAutoAttachParams(autoAttach));
}

async function enableWorkerObservation(status: StoredDeepCaptureStatus): Promise<StoredDeepCaptureStatus> {
  try {
    await setWorkerAutoAttach(debuggerTarget(status.target.tabId), true);
    return await getStoredStatus(status.target.tabId) || status;
  } catch (error) {
    const latest = await getStoredStatus(status.target.tabId) || status;
    const next = {
      ...latest,
      workerAutoAttachError: `Worker 目标证据不可用：${errorText(error)}`,
    };
    await writeStatus(next);
    return next;
  }
}

async function detachWorkerSession(parent: Debuggee, sessionId: string): Promise<void> {
  await sendCommand(parent, 'Target.detachFromTarget', { sessionId }).catch(() => undefined);
}

async function handleWorkerTargetAttached(
  source: Debuggee,
  params: Record<string, unknown>,
): Promise<void> {
  const tabId = source.tabId;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (!tabId || !sessionId) return;
  const targetInfo = params.targetInfo && typeof params.targetInfo === 'object'
    ? params.targetInfo as CDPTargetInfo
    : undefined;
  const type = targetInfo?.type;
  const targetId = targetInfo?.targetId;
  const url = typeof targetInfo?.url === 'string' ? targetInfo.url : '';
  const current = await getStoredStatus(tabId);
  if (
    !current
    || !['attached', 'armed', 'paused'].includes(current.state)
    || typeof type !== 'string'
    || !WORKER_TARGET_TYPES.has(type as BrowserDeepCaptureWorkerTarget['type'])
    || typeof targetId !== 'string'
    || !targetId
    || !workerTargetAllowed(current, type as BrowserDeepCaptureWorkerTarget['type'], url)
  ) {
    await detachWorkerSession(source, sessionId);
    return;
  }

  const existingIndex = current.workerTargets?.findIndex((target) => (
    target.sessionId === sessionId || target.targetId === targetId
  )) ?? -1;
  if (existingIndex < 0 && (current.workerTargets?.length || 0) >= MAX_WORKER_TARGETS) {
    await detachWorkerSession(source, sessionId);
    return;
  }

  const workerTarget: StoredWorkerTarget = {
    targetId,
    sessionId,
    type: type as BrowserDeepCaptureWorkerTarget['type'],
    url: publicWorkerUrl(url),
    state: 'attached',
    scriptCount: 0,
    attachedAt: Date.now(),
  };
  const workerTargets = [...(current.workerTargets || [])];
  if (existingIndex >= 0) workerTargets[existingIndex] = workerTarget;
  else workerTargets.push(workerTarget);
  await writeStatus({ ...current, workerTargets, workerAutoAttachError: undefined });
  workerScriptCounts.set(workerScriptKey(tabId, sessionId), 0);

  const child = { tabId, sessionId };
  try {
    await sendCommand(child, 'Runtime.enable');
    await sendCommand(child, 'Debugger.enable', { maxScriptsCacheSize: 4 * 1024 * 1024 });
    await sendCommand(child, 'Debugger.setSkipAllPauses', { skip: true });
    await sendCommand(child, 'Debugger.setAsyncCallStackDepth', { maxDepth: 8 });
    await setWorkerAutoAttach(child, true);
    await sendCommand(child, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
  } catch (error) {
    await sendCommand(child, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
    const latest = await getStoredStatus(tabId);
    if (latest) {
      await writeStatus({
        ...latest,
        workerTargets: latest.workerTargets?.map((target) => target.sessionId === sessionId
          ? { ...target, state: 'error', error: `无法读取 Worker 证据：${errorText(error)}` }
          : target),
      });
    }
    await detachWorkerSession(source, sessionId);
  }
}

async function handleWorkerTargetDetached(tabId: number, params: Record<string, unknown>): Promise<void> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const targetId = typeof params.targetId === 'string' ? params.targetId : '';
  if (!sessionId && !targetId) return;
  const current = await getStoredStatus(tabId);
  if (!current?.workerTargets?.length) return;
  const detachedAt = Date.now();
  let changed = false;
  const workerTargets = current.workerTargets.map((target) => {
    if ((sessionId && target.sessionId === sessionId) || (targetId && target.targetId === targetId)) {
      changed = true;
      workerScriptCounts.delete(workerScriptKey(tabId, target.sessionId));
      return target.state === 'error' ? target : { ...target, state: 'detached' as const, detachedAt };
    }
    return target;
  });
  if (changed) await writeStatus({ ...current, workerTargets });
}

function shouldPersistWorkerScriptCount(count: number): boolean {
  return count === 1 || count === 4 || count === 16 || count === 64 || count === MAX_WORKER_SCRIPT_COUNT;
}

async function handleWorkerDebuggerEvent(
  source: Debuggee,
  method: string,
  params: Record<string, unknown>,
  current: StoredDeepCaptureStatus | undefined,
): Promise<void> {
  const tabId = source.tabId;
  const sessionId = source.sessionId;
  if (!tabId || !sessionId) return;
  if (method === 'Debugger.paused') {
    await sendCommand(source, 'Debugger.resume').catch(() => undefined);
    return;
  }
  if (method !== 'Debugger.scriptParsed') return;
  const target = current?.workerTargets?.find((item) => item.sessionId === sessionId);
  if (!current || !target || target.state !== 'attached') return;
  const key = workerScriptKey(tabId, sessionId);
  const count = Math.min(MAX_WORKER_SCRIPT_COUNT, (workerScriptCounts.get(key) ?? target.scriptCount) + 1);
  workerScriptCounts.set(key, count);
  if (!shouldPersistWorkerScriptCount(count)) return;
  const latest = await getStoredStatus(tabId);
  if (!latest) return;
  await writeStatus({
    ...latest,
    workerTargets: latest.workerTargets?.map((item) => item.sessionId === sessionId
      ? { ...item, scriptCount: Math.max(item.scriptCount, count) }
      : item),
  });
}

async function clearFunctionBreakpoint(target: Debuggee, status: StoredDeepCaptureStatus): Promise<void> {
  if (status.functionBreakpointId) {
    await sendCommand(target, 'Debugger.removeBreakpoint', { breakpointId: status.functionBreakpointId }).catch(() => undefined);
  }
  if (status.functionObjectId) {
    await sendCommand(target, 'Runtime.releaseObject', { objectId: status.functionObjectId }).catch(() => undefined);
  }
}

async function installFunctionBreakpoint(
  target: Debuggee,
  wrapperHandleId: string,
  scriptUrl?: string,
): Promise<{ breakpointId: string; objectId: string }> {
  const registryExpression = `globalThis[${JSON.stringify(PAGE_RECORDER_REGISTRY_KEY)}].command("deep.function", { wrapperHandleId: ${JSON.stringify(wrapperHandleId)} })`;
  const resolved = await sendCommand<{
    result?: CDPRemoteObject;
    exceptionDetails?: { text?: string; exception?: CDPRemoteObject };
  }>(target, 'Runtime.evaluate', {
    expression: registryExpression,
    objectGroup: 'yakit-deep-capture',
    returnByValue: false,
    silent: false,
    generatePreview: false,
  });
  if (resolved.exceptionDetails || resolved.result?.type !== 'function' || !resolved.result.objectId) {
    throw new ExtensionError(
      'debugger_unavailable',
      resolved.exceptionDetails?.exception?.description || resolved.exceptionDetails?.text || '目标加密函数当前不可调试',
    );
  }
  const objectId = resolved.result.objectId;
  try {
    const condition = scriptUrl
      ? `String(new Error().stack || "").includes(${JSON.stringify(scriptUrl.slice(0, 2_048))})`
      : undefined;
    const breakpoint = await sendCommand<{ breakpointId?: string }>(
      target,
      'Debugger.setBreakpointOnFunctionCall',
      condition ? { objectId, condition } : { objectId },
    );
    if (!breakpoint.breakpointId) throw new Error('浏览器没有返回函数断点 ID');
    return { breakpointId: breakpoint.breakpointId, objectId };
  } catch (error) {
    await sendCommand(target, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    throw new ExtensionError('debugger_unavailable', `无法设置函数调用断点: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function truncate(value: string, limit = MAX_VALUE_PREVIEW): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function remoteText(remote?: CDPRemoteObject): string {
  if (!remote) return 'undefined';
  if (remote.unserializableValue) return remote.unserializableValue;
  if (remote.value !== undefined || ['undefined', 'string', 'number', 'boolean', 'bigint'].includes(remote.type || '')) {
    try {
      const serialized = typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value);
      return serialized === undefined ? String(remote.value) : serialized;
    } catch {
      return String(remote.value);
    }
  }
  return remote.description || remote.subtype || remote.type || 'object';
}

function remotePreview(remote?: CDPRemoteObject, limit = MAX_VALUE_PREVIEW): string {
  return truncate(remoteText(remote), limit);
}

function libraryFrame(url: string, functionName: string): boolean {
  const value = `${url}\n${functionName}`.toLowerCase();
  return value.includes('chrome-extension://') || value.includes('page-recorder-main-world')
    || value.includes('node_modules') || value.includes('webpack/runtime') || value.includes('react-dom')
    || value.includes('zone.js') || value.includes('polyfill');
}

const RECORDER_HOOK_FUNCTION = /^recorded(?:Fetch|Open|SetRequestHeader|Send|SendBeacon|WorkerPostMessage|MessagePortPostMessage|Encrypt|Decrypt|Sign|Verify|Digest|DeriveBits|DeriveKey|GenerateKey|ImportKey|ExportKey|WrapKey|UnwrapKey|CryptoJs|JSEncrypt(?:Encrypt|Decrypt|Sign|Verify)|Btoa|Atob)$/;

function frameSourceKind(
  url: string,
  functionName: string,
  index: number,
  matcher?: BrowserDeepCaptureMatcher,
): BrowserDeepCaptureFrame['sourceKind'] {
  const normalizedUrl = url.toLowerCase();
  if ((matcher?.kind !== 'request' && index === 0) || RECORDER_HOOK_FUNCTION.test(functionName)
    || normalizedUrl.includes('chrome-extension://') || normalizedUrl.includes('page-recorder-main-world')) return 'extension-hook';
  return libraryFrame(url, functionName) ? 'library' : 'page';
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function receiverFunctionExpression(functionName: string): string {
  return `(() => {
    let owner = this;
    while (owner != null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, ${JSON.stringify(functionName)});
      if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : undefined;
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  })()`;
}

async function collectScope(target: Debuggee, scope: CDPScope): Promise<BrowserDeepCaptureScope | undefined> {
  const type = scope.type as BrowserDeepCaptureScope['type'];
  if (!acceptedScopeTypes.has(type) || !scope.object?.objectId) return undefined;
  const response = await sendCommand<{ result?: Array<{ name?: string; value?: CDPRemoteObject; wasThrown?: boolean }> }>(
    target,
    'Runtime.getProperties',
    { objectId: scope.object.objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true },
  ).catch(() => ({ result: [] }));
  const variables: BrowserDeepCaptureVariable[] = [];
  let detailBudget = MAX_SCOPE_DETAIL_BUDGET;
  for (const property of (response.result || []).slice(0, MAX_VARIABLES_PER_SCOPE)) {
    if (!property.name || property.wasThrown || !property.value) continue;
    const rawDetail = remoteText(property.value);
    const detailEligible = property.value.type === 'function' || rawDetail.includes('\n') || rawDetail.length > 160;
    const detailLimit = Math.min(MAX_VARIABLE_DETAIL, detailBudget);
    const detail = detailEligible && detailLimit > 0 ? truncate(rawDetail, detailLimit) : undefined;
    if (detail) detailBudget -= detail.length;
    variables.push({
      name: property.name.slice(0, 240),
      type: String(property.value.type || 'unknown').slice(0, 80),
      subtype: property.value.subtype ? String(property.value.subtype).slice(0, 80) : undefined,
      preview: truncate(rawDetail),
      detail,
      detailTruncated: rawDetail.length > (detail ? detailLimit : MAX_VALUE_PREVIEW) || undefined,
    });
  }
  return { type, name: scope.name?.slice(0, 240), variables };
}

async function inspectFunctionExpression(
  target: Debuggee,
  frame: BrowserDeepCaptureFrame,
  expression: string,
  resolution: InspectedFunctionCandidate['resolution'],
): Promise<InspectedFunctionCandidate | undefined> {
  const evaluated = await sendCommand<{
    result?: CDPRemoteObject;
    exceptionDetails?: { text?: string; exception?: CDPRemoteObject };
  }>(target, 'Debugger.evaluateOnCallFrame', {
    callFrameId: frame.id,
    expression: `(${expression})`,
    objectGroup: 'yakit-deep-capture',
    returnByValue: false,
    silent: true,
  }).catch(() => undefined);
  if (evaluated?.exceptionDetails || evaluated?.result?.type !== 'function' || !evaluated.result.objectId) return undefined;
  const objectId = evaluated.result.objectId;
  try {
    const [metadata, location] = await Promise.all([
      sendCommand<{ result?: CDPRemoteObject }>(target, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const source = Function.prototype.toString.call(this).slice(0, 65536);
          const parsedParameters = (${parseFunctionParameterNames.toString()})(source, 16);
          const parameterNames = parsedParameters.length
            ? parsedParameters
            : Array.from({ length: Math.min(Math.max(this.length, 0), 16) }, (_, index) => "arg" + index);
          const riskFlags = [];
          if (/\\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\\b|\\.submit\\s*\\(/.test(source)) riskFlags.push("network");
          if (/\\b(?:document|getElementById|querySelector|querySelectorAll)\\b|\\.(?:innerHTML|outerHTML|textContent|value)\\s*=/.test(source)) riskFlags.push("dom");
          if (/\\b(?:location|history|window\\.open)\\b/.test(source)) riskFlags.push("navigation");
          if (/\\b(?:localStorage|sessionStorage|indexedDB|caches)\\b/.test(source)) riskFlags.push("storage");
          return {
            functionName: String(this.name || ""),
            parameterCount: parameterNames.length,
            parameterNames,
            riskFlags
          };
        }`,
        returnByValue: true,
        silent: true,
      }).catch(() => undefined),
      sendCommand<{ location?: { scriptId?: string; lineNumber?: number } }>(target, 'Debugger.getFunctionLocation', {
        functionId: objectId,
      }).catch(() => undefined),
    ]);
    const value = metadata?.result?.value;
    if (!value || typeof value !== 'object') return undefined;
    const input = value as { functionName?: unknown; parameterCount?: unknown; parameterNames?: unknown; riskFlags?: unknown };
    const riskFlags: InspectedFunctionCandidate['riskFlags'] = [];
    const allowed = new Set(['network', 'dom', 'navigation', 'storage']);
    if (Array.isArray(input.riskFlags)) {
      riskFlags.push(...input.riskFlags.filter((item): item is typeof riskFlags[number] => typeof item === 'string' && allowed.has(item)));
    }
    const functionName = typeof input.functionName === 'string' ? input.functionName.slice(0, 240) : '';
    const sameScript = Boolean(location?.location?.scriptId && location.location.scriptId === frame.scriptId);
    const nameMatch = functionName === frame.functionName || expression === frame.functionName;
    let score = resolution === 'frame-name' ? 36 : resolution === 'receiver-method' ? 30 : 12;
    if (sameScript) score += 42;
    if (nameMatch) score += 28;
    if (sameScript && Number.isFinite(location?.location?.lineNumber)) {
      const distance = Math.max(0, frame.lineNumber - (Number(location?.location?.lineNumber) + 1));
      score += Math.max(0, 12 - Math.min(12, Math.floor(distance / 20)));
    }
    return {
      expression,
      resolution,
      functionName,
      parameterCount: Number.isSafeInteger(input.parameterCount) ? Math.max(0, Math.min(16, Number(input.parameterCount))) : 0,
      parameterNames: Array.isArray(input.parameterNames)
        ? input.parameterNames.filter((item): item is string => typeof item === 'string' && validIdentifier(item)).slice(0, 16)
        : [],
      riskFlags,
      scriptId: location?.location?.scriptId,
      lineNumber: Number.isFinite(location?.location?.lineNumber) ? Number(location?.location?.lineNumber) + 1 : undefined,
      score,
    };
  } finally {
    await sendCommand(target, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

async function inspectFrameFunction(
  target: Debuggee,
  frame: BrowserDeepCaptureFrame,
): Promise<BrowserDeepCaptureFrame['functionInspection']> {
  const expressions: Array<{ expression: string; resolution: InspectedFunctionCandidate['resolution'] }> = [];
  if (validIdentifier(frame.functionName)) {
    expressions.push({ expression: frame.functionName, resolution: 'frame-name' });
    expressions.push({ expression: receiverFunctionExpression(frame.functionName), resolution: 'receiver-method' });
  }
  if (!validIdentifier(frame.functionName) || frame.functionName === '(anonymous)') {
    for (const variable of frame.scopes.flatMap((scope) => scope.variables)) {
      if (variable.type !== 'function' || !validIdentifier(variable.name)) continue;
      expressions.push({ expression: variable.name, resolution: 'scope-binding' });
      if (expressions.length >= MAX_FUNCTION_CANDIDATES) break;
    }
  }
  const unique = [...new Map(expressions.map((item) => [item.expression, item])).values()].slice(0, MAX_FUNCTION_CANDIDATES);
  const inspected = (await Promise.all(unique.map((item) => inspectFunctionExpression(
    target, frame, item.expression, item.resolution,
  )))).filter((item): item is InspectedFunctionCandidate => Boolean(item))
    .filter((item) => item.resolution !== 'scope-binding' || item.scriptId === frame.scriptId);
  const candidates = [...new Map(inspected
    .sort((left, right) => right.score - left.score || left.expression.localeCompare(right.expression))
    .map((item) => [`${item.functionName}\n${item.scriptId || ''}\n${item.lineNumber || ''}\n${item.parameterCount}`, item])).values()]
    .sort((left, right) => right.score - left.score || left.expression.localeCompare(right.expression));
  const selected = candidates[0];
  const ambiguous = Boolean(selected && candidates[1] && selected.score - candidates[1].score < 8);
  if (!selected || ambiguous) return { resolved: false, riskFlags: [], candidateCount: candidates.length };
  return {
    resolved: true,
    parameterCount: selected.parameterCount,
    parameterNames: selected.parameterNames,
    riskFlags: selected.riskFlags,
    resolution: selected.resolution,
    referenceExpression: selected.expression,
    candidateCount: candidates.length,
  };
}

function pauseSkeleton(
  params: Record<string, unknown>,
  matcher?: BrowserDeepCaptureMatcher,
  scriptMetadata?: Map<string, ScriptMetadata>,
): { pause: BrowserDeepCapturePause; rawFrames: CDPCallFrame[] } {
  const rawFrames = Array.isArray(params.callFrames) ? params.callFrames as CDPCallFrame[] : [];
  const selectedFrames = rawFrames.slice(0, MAX_FRAMES).filter((frame) => Boolean(frame.callFrameId));
  const frames = selectedFrames.map((frame, index): BrowserDeepCaptureFrame => {
    const scriptId = String(frame.location?.scriptId || '').slice(0, 160);
    const script = scriptMetadata?.get(scriptId);
    const url = String(frame.url || script?.url || '').slice(0, 4_096);
    const functionName = String(frame.functionName || '(anonymous)').slice(0, 240) || '(anonymous)';
    const sourceKind = frameSourceKind(url, functionName, index, matcher);
    return {
      id: frame.callFrameId!,
      index,
      functionName,
      scriptId,
      url,
      sourceMapUrl: script?.sourceMapUrl,
      lineNumber: Math.max(1, Number(frame.location?.lineNumber || 0) + 1),
      columnNumber: Math.max(1, Number(frame.location?.columnNumber || 0) + 1),
      scopes: [],
      thisPreview: remotePreview(frame.this),
      sourceKind,
      libraryFrame: sourceKind !== 'page',
    };
  });
  const now = Date.now();
  return {
    pause: {
      reason: String(params.reason || 'other').slice(0, 120),
      pausedAt: now,
      deadline: now + WATCHDOG_MS,
      collecting: true,
      frames,
    },
    rawFrames: selectedFrames,
  };
}

async function enrichPause(
  target: Debuggee,
  pause: BrowserDeepCapturePause,
  rawFrames: CDPCallFrame[],
  matcher?: BrowserDeepCaptureMatcher,
): Promise<BrowserDeepCapturePause> {
  const scopedFrames = await Promise.all(pause.frames.map(async (frame, index) => {
    const scopes = index >= MAX_SCOPE_FRAMES ? [] : await Promise.all((rawFrames[index]?.scopeChain || []).slice(0, MAX_SCOPES_PER_FRAME)
      .map((scope) => collectScope(target, scope))).then((items) => items.filter((scope): scope is BrowserDeepCaptureScope => Boolean(scope)));
    const enrichedFrame = { ...frame, scopes };
    const functionInspection = await inspectFrameFunction(target, enrichedFrame);
    return { ...enrichedFrame, functionInspection };
  }));
  const ranked = rankBusinessFrames(scopedFrames, matcher?.frameHints);
  return {
    ...pause,
    collecting: false,
    frames: ranked.frames,
    recommendedFrameId: ranked.recommendedFrameId,
    automaticCapture: ranked.automaticCapture,
  };
}

async function scheduleWatchdog(tabId: number, deadline: number): Promise<void> {
  await browser.alarms.create(`${WATCHDOG_PREFIX}${tabId}`, { when: deadline });
}

async function clearWatchdog(tabId: number): Promise<void> {
  await browser.alarms.clear(`${WATCHDOG_PREFIX}${tabId}`);
}

async function handleDebuggerEvent(source: Debuggee, method: string, params: Record<string, unknown> = {}): Promise<void> {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === 'Target.attachedToTarget') {
    await handleWorkerTargetAttached(source, params);
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    await handleWorkerTargetDetached(tabId, params);
    return;
  }
  const current = await getStoredStatus(tabId);
  if (source.sessionId) {
    await handleWorkerDebuggerEvent(source, method, params, current);
    return;
  }
  if (method === 'Debugger.scriptParsed') {
    rememberScriptMetadata(tabId, params.scriptId, params.url, params.sourceMapURL);
    return;
  }
  if (!current) {
    if (method === 'Debugger.paused') {
      try {
        await sendCommand(source, 'Debugger.resume');
      } catch (resumeError) {
        await detachOwnedDebugger(tabId).catch((detachError) => {
          console.error('Deep Capture orphaned pause recovery failed', { resumeError, detachError });
        });
      }
    }
    return;
  }
  if (method === 'Debugger.paused') {
    let capturedPause: BrowserDeepCapturePause | undefined;
    try {
      await clearFunctionBreakpoint(source, current);
      if (current.requestBreakpoint) {
        await sendCommand(source, 'DOMDebugger.removeXHRBreakpoint', { url: current.requestBreakpoint }).catch(() => undefined);
      }
      const { pause, rawFrames } = pauseSkeleton(params, current.matcher, scriptMetadataByTab.get(tabId));
      capturedPause = pause;
      await writeStatus({
        ...current,
        state: 'paused',
        pause,
        error: undefined,
        requestBreakpoint: undefined,
        functionBreakpointId: undefined,
        functionObjectId: undefined,
      });
      await scheduleWatchdog(tabId, pause.deadline);
      await enrichPause(source, pause, rawFrames, current.matcher).then(async (enriched) => {
        const latest = await getStoredStatus(tabId);
        if (latest?.state === 'paused' && latest.pause?.pausedAt === pause.pausedAt) {
          await writeStatus({ ...latest, pause: enriched });
        }
      }).catch(async (error) => {
        const latest = await getStoredStatus(tabId);
        if (latest?.state === 'paused' && latest.pause?.pausedAt === pause.pausedAt) {
          await writeStatus({
            ...latest,
            pause: { ...latest.pause, collecting: false },
            error: `作用域读取不完整: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    } catch (error) {
      const failedCurrent: StoredDeepCaptureStatus = {
        ...current,
        state: 'paused',
        pause: capturedPause,
      };
      const release = await releaseDeepCaptureRuntime(failedCurrent);
      const cleanupMessage = releaseFailureMessage(release);
      await writeStatus({
        ...failedCurrent,
        state: 'error',
        matcher: release.pageRunning ? undefined : current.matcher,
        pause: release.pageRunning ? undefined : capturedPause,
        requestBreakpoint: undefined,
        functionBreakpointId: undefined,
        functionObjectId: undefined,
        workerTargets: closeWorkerTargets(failedCurrent.workerTargets),
        recovery: {
          page: release.pageRunning ? 'running' : 'possibly-paused',
          debugger: release.debuggerDetached ? 'detached' : 'still-attached',
          trigger: 'pause-processing-failed',
        },
        error: `无法读取暂停现场：${errorText(error)}${cleanupMessage ? `；${cleanupMessage}` : ''}`,
      });
    }
  }
  if (method === 'Debugger.resumed') {
    await clearWatchdog(tabId);
    if (resumeInProgress.has(tabId)) return;
    const latest = await getStoredStatus(tabId);
    if (latest?.state === 'paused') {
      await writeStatus({
        ...latest,
        state: 'captured',
        pause: undefined,
        recovery: { page: 'running', debugger: 'still-attached', trigger: 'external-resume' },
      });
      await resumeDeepCapture(latest.target, 'external-resume');
    }
  }
}

async function handleDebuggerDetach(source: Debuggee, reason: string): Promise<void> {
  const tabId = source.tabId;
  if (!tabId) return;
  const intentional = intentionalDetaches.delete(tabId);
  resumeInProgress.delete(tabId);
  scriptMetadataByTab.delete(tabId);
  const current = await getStoredStatus(tabId);
  if (!current) return;
  clearWorkerRuntime(tabId, current.workerTargets);
  await Promise.allSettled([
    clearWatchdog(tabId),
    disarmBrowserRecordingDeepBreak(current.target),
  ]);
  if (intentional) return;
  const endedNormally = reason === 'target_closed' || reason === 'canceled_by_user';
  await writeStatus({
    ...current,
    state: endedNormally ? 'detached' : 'error',
    matcher: endedNormally ? undefined : current.matcher,
    pause: undefined,
    requestBreakpoint: undefined,
    functionBreakpointId: undefined,
    functionObjectId: undefined,
    workerTargets: closeWorkerTargets(current.workerTargets),
    recovery: {
      page: 'running',
      debugger: 'detached',
      trigger: endedNormally ? reason : 'debugger-takeover',
    },
    error: endedNormally ? undefined : '调试会话已被 DevTools 或其他调试客户端接管',
  });
}

async function attached(tabId: number): Promise<boolean> {
  return (await chromeDebugger().getTargets()).some((target) => target.tabId === tabId && target.attached);
}

async function detachOwnedDebugger(tabId: number): Promise<void> {
  intentionalDetaches.add(tabId);
  try {
    await chromeDebugger().detach(debuggerTarget(tabId));
  } catch (error) {
    intentionalDetaches.delete(tabId);
    const message = error instanceof Error ? error.message : String(error);
    if (/debugger is not attached/i.test(message)) return;
    if (await attached(tabId).catch(() => false)) throw error;
    return;
  }
  globalThis.setTimeout(() => intentionalDetaches.delete(tabId), 2_000);
}

interface DeepCaptureReleaseResult {
  pageRunning: boolean;
  debuggerDetached: boolean;
  resumeError?: string;
  detachError?: string;
  cleanupErrors: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function releaseDeepCaptureRuntime(current: StoredDeepCaptureStatus): Promise<DeepCaptureReleaseResult> {
  const target = debuggerTarget(current.target.tabId);
  const wasPaused = current.state === 'paused'
    || current.recovery?.page === 'possibly-paused'
    || Boolean(current.pause);
  let resumed = !wasPaused;
  let resumeError: string | undefined;

  // Restoring the page is always the first operation. Breakpoint and hook cleanup
  // must never delay the user's page behind a best-effort maintenance command.
  if (wasPaused) {
    resumeInProgress.add(current.target.tabId);
    try {
      await sendCommand(target, 'Debugger.resume');
      resumed = true;
    } catch (error) {
      resumeError = errorText(error);
    }
  }

  const cleanupTasks: Array<{ label: string; task: Promise<unknown> }> = [
    { label: '清除暂停 watchdog', task: clearWatchdog(current.target.tabId) },
    { label: '清除函数断点', task: clearFunctionBreakpoint(target, current) },
    { label: '撤销页面观测断点', task: disarmBrowserRecordingDeepBreak(current.target) },
    { label: '停止 Worker 目标观测', task: setWorkerAutoAttach(target, false) },
  ];
  if (current.requestBreakpoint) {
    cleanupTasks.push({
      label: '清除请求断点',
      task: sendCommand(target, 'DOMDebugger.removeXHRBreakpoint', { url: current.requestBreakpoint }),
    });
  }
  const cleanupResults = await Promise.allSettled(cleanupTasks.map((item) => item.task));
  const cleanupErrors = cleanupResults.flatMap((result, index) => (
    result.status === 'rejected' ? [`${cleanupTasks[index].label}: ${errorText(result.reason)}`] : []
  ));

  let debuggerDetached = false;
  let detachError: string | undefined;
  try {
    await detachOwnedDebugger(current.target.tabId);
    debuggerDetached = true;
    scriptMetadataByTab.delete(current.target.tabId);
    clearWorkerRuntime(current.target.tabId, current.workerTargets);
  } catch (error) {
    detachError = errorText(error);
  } finally {
    resumeInProgress.delete(current.target.tabId);
  }

  return {
    pageRunning: resumed || debuggerDetached,
    debuggerDetached,
    resumeError,
    detachError,
    cleanupErrors,
  };
}

function releaseFailureMessage(result: DeepCaptureReleaseResult): string {
  const reasons = [result.resumeError, result.detachError, ...result.cleanupErrors].filter(Boolean).join('；');
  if (!result.pageRunning) {
    return `页面恢复与调试会话释放均失败，页面可能仍处于暂停状态${reasons ? `：${reasons}` : ''}。请点击浏览器“正在被调试”提示中的取消，或关闭占用该页面的 DevTools`;
  }
  if (!result.debuggerDetached) {
    return `页面已经恢复，但调试会话未能自动结束${reasons ? `：${reasons}` : ''}`;
  }
  return result.cleanupErrors.length ? `页面已经恢复；部分观测状态清理失败：${result.cleanupErrors.join('；')}` : '';
}

export async function startDeepCapture(
  target: BrowserTarget,
  matcher: BrowserDeepCaptureMatcher,
  owner: DeepCaptureOwner = { kind: 'local' },
): Promise<BrowserDeepCaptureStatus> {
  if (expiredGrantOwner(owner)) throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期');
  if (target.frameId !== 0) throw new ExtensionError('target_denied', '深度捕获第一阶段只支持主文档');
  if (matcher.kind === 'crypto' && (!matcher.adapterId.trim() || !matcher.operation.trim() || !matcher.wrapperHandleId.trim())) {
    throw new Error('请选择录制结果中的有效密码调用');
  }
  if (matcher.kind === 'boundary' && (!matcher.operation.trim() || !matcher.wrapperHandleId.trim())) {
    throw new Error('请选择录制结果中的有效消息或请求边界');
  }
  if (matcher.kind === 'request' && !matcher.urlPattern.trim()) throw new Error('请输入请求 URL 片段');
  const tab = await getTab(target.tabId);
  if (!tab.isolationContextId) {
    throw new ExtensionError('isolation_unavailable', '无法确认深度捕获页面所属的身份隔离上下文');
  }
  const api = chromeDebugger();
  let existing = await getStoredStatus(target.tabId);
  if (existing && expiredGrantOwner(existing.owner)) {
    await detachDeepCapture(existing.target).catch(() => undefined);
    existing = undefined;
  }
  if (existing) assertSessionOwner(existing, owner);
  if (
    existing?.isolationContextId
    && (
      existing.isolationContextId !== tab.isolationContextId
      || existing.cookieStoreId !== tab.cookieStoreId
    )
  ) {
    throw new ExtensionError('isolation_stale', '深度捕获所属的身份隔离上下文已经变化，请重新开始');
  }
  if (existing?.state === 'paused') throw new ExtensionError('debugger_not_paused', '页面仍在暂停，请先捕获函数或恢复页面');
  // `getTargets().attached` can also reflect DevTools or another CDP client.
  // A detached/error status is authoritative for this extension, so it must
  // establish a fresh chrome.debugger session before sending commands.
  const canReuse = Boolean(
    existing
    && (existing.state === 'attached' || existing.state === 'armed')
    && await attached(target.tabId),
  );
  const origin = pageOrigin(tab.url);
  if (canReuse && existing?.origin && existing.origin !== origin) {
    await setWorkerAutoAttach(debuggerTarget(target.tabId), false).catch(() => undefined);
    clearWorkerRuntime(target.tabId, existing.workerTargets);
  }
  if (!canReuse) {
    try {
      scriptMetadataByTab.delete(target.tabId);
      await api.attach(debuggerTarget(target.tabId), '1.3');
    } catch (error) {
      throw new ExtensionError('debugger_unavailable', `无法附加页面调试会话: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await sendCommand(debuggerTarget(target.tabId), 'Runtime.enable');
    await sendCommand(debuggerTarget(target.tabId), 'Debugger.enable', { maxScriptsCacheSize: 16 * 1024 * 1024 });
    await sendCommand(debuggerTarget(target.tabId), 'Debugger.setBreakpointsActive', { active: true });
    await sendCommand(debuggerTarget(target.tabId), 'Debugger.setSkipAllPauses', { skip: false });
    await sendCommand(debuggerTarget(target.tabId), 'Debugger.setAsyncCallStackDepth', { maxDepth: 16 });
    await sendCommand(debuggerTarget(target.tabId), 'Network.enable', { maxPostDataSize: 2 * 1024 * 1024 });
    if (existing?.requestBreakpoint) {
      await sendCommand(debuggerTarget(target.tabId), 'DOMDebugger.removeXHRBreakpoint', { url: existing.requestBreakpoint }).catch(() => undefined);
    }
    if (existing) await clearFunctionBreakpoint(debuggerTarget(target.tabId), existing);
    await disarmBrowserRecordingDeepBreak(target);
    let requestBreakpoint: string | undefined;
    let functionBreakpointId: string | undefined;
    let functionObjectId: string | undefined;
    if (matcher.kind !== 'request') {
      await armBrowserRecordingDeepBreak(target, matcher);
      const breakpoint = await installFunctionBreakpoint(debuggerTarget(target.tabId), matcher.wrapperHandleId, matcher.scriptUrl);
      functionBreakpointId = breakpoint.breakpointId;
      functionObjectId = breakpoint.objectId;
    } else {
      requestBreakpoint = matcher.urlPattern.trim().slice(0, 2_048);
      await sendCommand(debuggerTarget(target.tabId), 'DOMDebugger.setXHRBreakpoint', { url: requestBreakpoint });
    }
    const status: StoredDeepCaptureStatus = {
      state: 'armed',
      target,
      isolationContextId: tab.isolationContextId,
      cookieStoreId: tab.cookieStoreId,
      origin,
      matcher,
      attachedAt: existing?.attachedAt || Date.now(),
      owner,
      workerTargets: existing?.origin === origin ? existing?.workerTargets : [],
      workerAutoAttachError: undefined,
      requestBreakpoint, functionBreakpointId, functionObjectId,
    };
    await writeStatus(status);
    return publicStatus(await enableWorkerObservation(status));
  } catch (error) {
    const failedBase: StoredDeepCaptureStatus = existing || {
      state: 'attached',
      target,
      isolationContextId: tab.isolationContextId,
      cookieStoreId: tab.cookieStoreId,
      origin,
      matcher,
      attachedAt: Date.now(),
      owner,
    };
    const release = await releaseDeepCaptureRuntime(failedBase);
    const cleanupMessage = releaseFailureMessage(release);
    await writeStatus({
      ...failedBase,
      state: 'error',
      matcher: undefined,
      pause: undefined,
      requestBreakpoint: undefined,
      functionBreakpointId: undefined,
      functionObjectId: undefined,
      workerTargets: closeWorkerTargets(failedBase.workerTargets),
      recovery: {
        page: release.pageRunning ? 'running' : 'possibly-paused',
        debugger: release.debuggerDetached ? 'detached' : 'still-attached',
        trigger: 'arm-failed',
      },
      error: `深度捕获武装失败：${errorText(error)}${cleanupMessage ? `；${cleanupMessage}` : ''}`,
    }).catch(() => undefined);
    if (cleanupMessage) {
      const code = error instanceof ExtensionError ? error.code : 'debugger_unavailable';
      throw new ExtensionError(code, `${errorText(error)}；${cleanupMessage}`, { cause: error });
    }
    throw error;
  }
}

export async function deepCaptureStatus(target: BrowserTarget, owner?: DeepCaptureOwner): Promise<BrowserDeepCaptureStatus> {
  const stored = await getStoredStatus(target.tabId);
  if (stored && expiredGrantOwner(stored.owner)) return detachDeepCapture(stored.target);
  if (stored) assertSessionOwner(stored, owner);
  return stored ? publicStatus(stored) : detachedStatus(target);
}

export async function keepDeepCaptureAlive(target: BrowserTarget, owner?: DeepCaptureOwner): Promise<BrowserDeepCaptureStatus> {
  const current = await getStoredStatus(target.tabId);
  if (!current || current.state !== 'paused' || !current.pause) throw new ExtensionError('debugger_not_paused', '页面当前没有暂停现场');
  if (expiredGrantOwner(current.owner)) {
    await detachDeepCapture(current.target);
    throw new ExtensionError('grant_expired', '浏览器共享会话不存在或已经过期；页面已经恢复');
  }
  assertSessionOwner(current, owner);
  const pause = { ...current.pause, deadline: Date.now() + WATCHDOG_MS };
  const next = { ...current, pause };
  await writeStatus(next);
  await scheduleWatchdog(target.tabId, pause.deadline);
  return publicStatus(next);
}

export async function resumeDeepCapture(target: BrowserTarget, reason = '用户恢复页面', owner?: DeepCaptureOwner): Promise<BrowserDeepCaptureStatus> {
  const current = await getStoredStatus(target.tabId);
  if (!current) return detachedStatus(target);
  assertSessionOwner(current, owner);
  const release = await releaseDeepCaptureRuntime(current);
  const releaseError = releaseFailureMessage(release);
  const next: StoredDeepCaptureStatus = {
    ...current,
    state: release.pageRunning ? 'captured' : 'error',
    matcher: release.pageRunning ? undefined : current.matcher,
    pause: release.pageRunning ? undefined : current.pause,
    requestBreakpoint: undefined,
    functionBreakpointId: undefined,
    functionObjectId: undefined,
    workerTargets: closeWorkerTargets(current.workerTargets),
    recovery: {
      page: release.pageRunning ? 'running' : 'possibly-paused',
      debugger: release.debuggerDetached ? 'detached' : 'still-attached',
      trigger: reason,
    },
    error: releaseError || (reason === 'watchdog' ? '暂停超时，页面已自动恢复' : undefined),
  };
  await writeStatus(next);
  return publicStatus(next);
}

export async function detachDeepCapture(target: BrowserTarget, owner?: DeepCaptureOwner): Promise<BrowserDeepCaptureStatus> {
  const current = await getStoredStatus(target.tabId);
  if (!current) return detachedStatus(target);
  assertSessionOwner(current, owner);
  const release = await releaseDeepCaptureRuntime(current);
  const releaseError = releaseFailureMessage(release);
  const next: StoredDeepCaptureStatus = {
    ...current,
    state: release.debuggerDetached ? 'detached' : 'error',
    matcher: release.pageRunning ? undefined : current.matcher,
    pause: release.pageRunning ? undefined : current.pause,
    requestBreakpoint: undefined,
    functionBreakpointId: undefined,
    functionObjectId: undefined,
    workerTargets: closeWorkerTargets(current.workerTargets),
    recovery: {
      page: release.pageRunning ? 'running' : 'possibly-paused',
      debugger: release.debuggerDetached ? 'detached' : 'still-attached',
      trigger: 'detach',
    },
    error: releaseError || undefined,
  };
  await writeStatus(next);
  return publicStatus(next);
}

type CapturedPageCallableInput =
  | { strategy: 'selected-frame'; name?: string; analysis?: BrowserTransformCallableAnalysis }
  | {
    strategy: 'request-transaction';
    name?: string;
    transaction: BrowserPageCallableTransaction;
    analysis?: BrowserTransformCallableAnalysis;
  }
  | { strategy: 'expression'; name: string; functionExpression: string };

async function capturePageCallableWhilePaused(
  target: BrowserTarget,
  callFrameId: string,
  input: CapturedPageCallableInput,
  owner?: DeepCaptureOwner,
): Promise<BrowserPageCallable> {
  const current = await getStoredStatus(target.tabId);
  const frame = current?.pause?.frames.find((item) => item.id === callFrameId);
  if (!current || current.state !== 'paused' || !frame) {
    throw new ExtensionError('debugger_not_paused', '调用栈已经恢复，请重新捕获一次真实操作');
  }
  assertSessionOwner(current, owner);
  if (frame.sourceKind !== 'page') {
    throw new ExtensionError('callable_capture_failed', '只能捕获页面自身的业务函数，插件 Hook 和依赖库帧仅作为证据');
  }
  let functionExpression: string;
  let inspected: NonNullable<BrowserDeepCaptureFrame['functionInspection']>;
  if (input.strategy !== 'expression') {
    inspected = frame.functionInspection || { resolved: false, riskFlags: [] };
    functionExpression = inspected.referenceExpression || '';
    if (!inspected.resolved || !functionExpression) {
      throw new ExtensionError('callable_capture_ambiguous', '浏览器无法唯一解析这个栈帧，请选择另一个候选或使用高级表达式');
    }
  } else {
    functionExpression = input.functionExpression.trim().slice(0, 4_096);
    if (!functionExpression) throw new Error('函数引用表达式不能为空');
    const manual = await inspectFunctionExpression(
      debuggerTarget(target.tabId), frame, functionExpression, 'manual-expression',
    );
    if (!manual) throw new ExtensionError('callable_capture_failed', '高级表达式没有解析为当前暂停现场中的函数');
    inspected = {
      resolved: true,
      parameterCount: manual.parameterCount,
      parameterNames: manual.parameterNames,
      riskFlags: manual.riskFlags,
      resolution: manual.resolution,
      referenceExpression: manual.expression,
      candidateCount: 1,
    };
  }
  const requestTransaction = input.strategy === 'request-transaction' ? input.transaction : undefined;
  if (requestTransaction && inspected.riskFlags.includes('storage')) {
    throw new ExtensionError(
      'callable_capture_blocked',
      '该函数会访问页面存储；当前请求事务无法证明存储副作用已完整回滚',
    );
  }
  if (!requestTransaction && inspected.riskFlags.length) {
    throw new ExtensionError(
      'callable_capture_blocked',
      `该函数包含 ${inspected.riskFlags.join('、')} 副作用；为避免真实发包或修改页面，不能注册为可回放函数`,
    );
  }
  const callableId = crypto.randomUUID();
  const fallbackName = frame.functionName && frame.functionName !== '(anonymous)'
    ? `${frame.functionName} 业务封装`
    : '页面业务封装';
  const name = (input.name || fallbackName).trim().slice(0, 120);
  if (!name) throw new Error('页面函数名称不能为空');
  const capturedFrameHints = [{
    functionName: frame.functionName.slice(0, 240),
    url: frame.url.slice(0, 4_096) || undefined,
    support: 1,
    averageDepth: frame.index,
  }, ...(current.matcher?.frameHints || [])]
    .filter((hint, index, values) => Boolean(hint.functionName) && values.findIndex((item) => (
      item.functionName === hint.functionName && item.url === hint.url
    )) === index)
    .slice(0, 16);
  const parameterNames = inspected.parameterNames?.length
    ? inspected.parameterNames.slice(0, 16)
    : Array.from({ length: Math.min(inspected.parameterCount || 0, 16) }, (_, index) => `arg${index}`);
  const retainedCallKey = `__YAKIT_RETAINED_CALL_${callableId.replace(/-/g, '')}__`;
  const retainedParameterValues = parameterNames.map((parameterName) => (
    `(typeof ${parameterName} === "undefined" ? undefined : ${parameterName})`
  ));
  const retainedCall = await sendCommand<{
    result?: CDPRemoteObject;
    exceptionDetails?: { text?: string; exception?: CDPRemoteObject };
  }>(debuggerTarget(target.tabId), 'Debugger.evaluateOnCallFrame', {
    callFrameId,
    expression: `globalThis[${JSON.stringify(retainedCallKey)}] = { thisArg: this, args: [${retainedParameterValues.join(', ')}] }`,
    returnByValue: false,
    silent: false,
  });
  if (retainedCall.exceptionDetails) {
    throw new ExtensionError(
      'callable_capture_failed',
      retainedCall.exceptionDetails.exception?.description || retainedCall.exceptionDetails.text || '无法保留当前业务函数的固定参数',
    );
  }
  const callableKind = requestTransaction ? 'request-transaction' : 'business-closure';
  const inputSlots = requestTransaction
    ? [{
      id: 'body', name: 'body', index: 0, role: 'data', dataType: 'object', required: true, retained: false,
    }]
    : parameterNames.map((parameterName, index) => ({
      id: `arg-${index}`, name: parameterName, index, role: 'unknown', dataType: 'unknown', required: true, retained: false,
    }));
  const expression = `(() => {
    const retainedCall = globalThis[${JSON.stringify(retainedCallKey)}];
    delete globalThis[${JSON.stringify(retainedCallKey)}];
    if (!retainedCall || !Array.isArray(retainedCall.args)) throw new Error("业务函数的暂停现场已经失效");
    const candidate = (${functionExpression});
    if (typeof candidate !== "function") throw new Error("选中的表达式不是函数");
    const source = Function.prototype.toString.call(candidate).slice(0, 65536);
    const transaction = ${JSON.stringify(requestTransaction || null)};
    if ((transaction && /\\b(?:localStorage|sessionStorage|indexedDB|caches)\\b/.test(source))
      || (!transaction && (/\\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\\b|\\.submit\\s*\\(/.test(source)
        || /\\b(?:document|getElementById|querySelector|querySelectorAll)\\b|\\.(?:innerHTML|outerHTML|textContent|value)\\s*=/.test(source)
        || /\\b(?:location|history|window\\.open)\\b/.test(source)
        || /\\b(?:localStorage|sessionStorage|indexedDB|caches)\\b/.test(source)))) {
      throw new Error("页面函数包含不可自动回放的副作用");
    }
    const key = ${JSON.stringify(PAGE_CALLABLE_REGISTRY_KEY)};
    let registry = globalThis[key];
    if (!(registry instanceof Map)) {
      registry = new Map();
      Object.defineProperty(globalThis, key, { value: registry, configurable: true, enumerable: false });
    }
    if (transaction && typeof globalThis.fetch === "function") {
      const previousFetch = globalThis.fetch;
      let restoreTimer;
      const restoreFetch = () => {
        if (globalThis.fetch === transactionCaptureFetch) globalThis.fetch = previousFetch;
        if (restoreTimer) clearTimeout(restoreTimer);
      };
      const transactionCaptureFetch = async function(input, init) {
        let request;
        try { request = new Request(input, init); } catch { return Reflect.apply(previousFetch, this, [input, init]); }
        const expectedURL = new URL(transaction.request.url, location.href).toString();
        if (transaction.request.boundary !== "fetch"
          || request.method.toUpperCase() !== transaction.request.method.toUpperCase()
          || request.url !== expectedURL) {
          return Reflect.apply(previousFetch, this, [input, init]);
        }
        restoreFetch();
        return new Response(JSON.stringify({ success: false, error: "request captured before transaction replay" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      };
      globalThis.fetch = transactionCaptureFetch;
      restoreTimer = setTimeout(restoreFetch, 10000);
    }
    const metadata = {
      id: ${JSON.stringify(callableId)}, name: ${JSON.stringify(name)}, kind: ${JSON.stringify(callableKind)},
      operation: candidate.name || ${JSON.stringify(functionExpression)}, origin: location.origin,
      lifecycle: "document",
      execution: { resultMode: "auto", timeoutMs: transaction ? 10000 : 8000 },
      inputSlots: ${JSON.stringify(inputSlots)},
      output: transaction
        ? {
          dataType: transaction.request.bodyFormat === "raw" ? "string" : "object",
          encoding: transaction.request.bodyFormat === "json" ? "json" : "utf8",
          shape: "envelope",
          paths: transaction.request.expectedDestinations
        }
        : { dataType: "unknown", encoding: "auto", shape: "value", paths: [] },
      ...(transaction ? { transaction } : {}),
      provenance: {
        sourceUrl: ${JSON.stringify(frame.url.slice(0, 4_096))},
        lineNumber: ${Math.max(1, Math.floor(frame.lineNumber))},
        functionName: candidate.name || ${JSON.stringify(frame.functionName)},
        businessFrameHints: ${JSON.stringify(capturedFrameHints)},
        analysis: ${JSON.stringify(input.strategy === 'expression' ? undefined : input.analysis)}
      },
      createdAt: Date.now()
    };
    const thisArg = retainedCall.thisArg;
    const retainedArguments = retainedCall.args.slice(0, 16);
    const parameterNames = ${JSON.stringify(parameterNames)};
    registry.set(metadata.id, {
      metadata,
      invoke(args, context) {
        const decode = (value) => {
          if (!value || typeof value !== "object" || value.type !== "bytes" || typeof value.base64 !== "string") return value;
          const binary = atob(value.base64);
          return Uint8Array.from(binary, (character) => character.charCodeAt(0));
        };
        const decoded = args.map(decode);
        if (!transaction) return Reflect.apply(candidate, thisArg, decoded);
        const logical = decoded[0];
        const logicalRecord = logical && typeof logical === "object" && !Array.isArray(logical) ? logical : undefined;
        const invocationArguments = retainedArguments.slice();
        const expectedRequestURL = transaction ? new URL(transaction.request.url, location.href).toString() : "";
        const retainedMatchesRequestURL = (value) => {
          if (!transaction || typeof value !== "string") return false;
          try { return new URL(value, location.href).toString() === expectedRequestURL; } catch { return false; }
        };
        parameterNames.forEach((parameterName, index) => {
          if (logicalRecord && Object.prototype.hasOwnProperty.call(logicalRecord, parameterName)) {
            invocationArguments[index] = logicalRecord[parameterName];
          } else if (/^(?:payload|data|body|request|params|input)$/i.test(parameterName)) {
            invocationArguments[index] = logical;
          } else if ((!context || context.domInputCount === 0) && parameterNames.length === 1
            && !/^(?:url|uri|endpoint|path|event|evt|e)$/i.test(parameterName)
            && !retainedMatchesRequestURL(retainedArguments[index])) {
            invocationArguments[index] = logical;
          }
        });
        if (context && context.domInputCount > 0 && !parameterNames.length) {
          return Reflect.apply(candidate, thisArg, retainedArguments);
        }
        return Reflect.apply(candidate, thisArg, invocationArguments);
      }
    });
    return metadata;
  })()`;
  const response = await sendCommand<{
    result?: CDPRemoteObject;
    exceptionDetails?: { text?: string; exception?: CDPRemoteObject };
  }>(debuggerTarget(target.tabId), 'Debugger.evaluateOnCallFrame', {
    callFrameId, expression, returnByValue: true, awaitPromise: true, silent: false,
  });
  if (response.exceptionDetails) {
    throw new ExtensionError('callable_capture_failed', response.exceptionDetails.exception?.description || response.exceptionDetails.text || '无法捕获该业务函数');
  }
  const callable = normalizeCallable(response.result?.value, target);
  if (!callable) throw new ExtensionError('callable_capture_failed', '页面没有返回有效的页面函数');
  return callable;
}

export async function createCapturedPageCallable(
  target: BrowserTarget,
  callFrameId: string,
  input: CapturedPageCallableInput,
  owner?: DeepCaptureOwner,
): Promise<BrowserPageCallable> {
  let callable: BrowserPageCallable | undefined;
  let captureError: unknown;
  try {
    callable = await capturePageCallableWhilePaused(target, callFrameId, input, owner);
  } catch (error) {
    captureError = error;
  }

  let recoveryError: string | undefined;
  try {
    const recovered = await resumeDeepCapture(
      target,
      captureError ? 'callable-capture-failed' : 'callable-created',
      owner,
    );
    if (recovered.recovery?.page === 'possibly-paused') {
      recoveryError = recovered.error || '页面可能仍处于暂停状态';
    }
  } catch (error) {
    recoveryError = errorText(error);
  }

  if (captureError) {
    if (!recoveryError) throw captureError;
    const code = captureError instanceof ExtensionError ? captureError.code : 'callable_capture_failed';
    throw new ExtensionError(code, `${errorText(captureError)}；随后恢复页面失败：${recoveryError}`, {
      cause: captureError,
      recoveryError,
    });
  }
  if (recoveryError) {
    throw new ExtensionError('debugger_unavailable', `页面函数已经捕获，但页面恢复失败：${recoveryError}`);
  }
  if (!callable) throw new ExtensionError('callable_capture_failed', '页面函数捕获没有返回结果');
  return callable;
}

export async function stopDeepCapturesForGrant(grantId: string): Promise<void> {
  const statuses = Object.values(await readStatuses()).filter((status) => status.owner.kind === 'grant' && status.owner.grantId === grantId);
  await Promise.allSettled(statuses.map((status) => detachDeepCapture(status.target)));
}

export async function reconcileDeepCaptureSessions(): Promise<void> {
  const statuses = Object.values(await readStatuses());
  if (!statuses.length) return;
  const targets = await chromeDebugger().getTargets();
  const targetByTab = new Map(targets
    .filter((target): target is typeof target & { tabId: number } => target.type === 'page' && Number.isSafeInteger(target.tabId))
    .map((target) => [target.tabId, target]));

  for (const status of statuses) {
    if (expiredGrantOwner(status.owner)) {
      await detachDeepCapture(status.target).catch((error) => {
        console.error('Deep Capture expired owner cleanup failed', error);
      });
      continue;
    }

    const target = targetByTab.get(status.target.tabId);
    const debuggerAttached = Boolean(target?.attached);
    const extensionOwnedState = ['attached', 'armed', 'paused'].includes(status.state)
      || status.recovery?.debugger === 'still-attached';
    if (!extensionOwnedState) continue;

    if (!target) {
      await Promise.allSettled([
        clearWatchdog(status.target.tabId),
        disarmBrowserRecordingDeepBreak(status.target),
      ]);
      scriptMetadataByTab.delete(status.target.tabId);
      clearWorkerRuntime(status.target.tabId, status.workerTargets);
      await removeStatus(status.target.tabId);
      continue;
    }

    if (!debuggerAttached) {
      await Promise.allSettled([
        clearWatchdog(status.target.tabId),
        disarmBrowserRecordingDeepBreak(status.target),
      ]);
      scriptMetadataByTab.delete(status.target.tabId);
      clearWorkerRuntime(status.target.tabId, status.workerTargets);
      await writeStatus({
        ...status,
        state: 'detached',
        matcher: undefined,
        pause: undefined,
        requestBreakpoint: undefined,
        functionBreakpointId: undefined,
        functionObjectId: undefined,
        workerTargets: closeWorkerTargets(status.workerTargets),
        recovery: { page: 'running', debugger: 'detached', trigger: 'service-worker-restart' },
        error: status.state === 'paused'
          ? '扩展恢复时发现调试会话已由浏览器结束；暂停页面已经恢复，原现场不可继续使用'
          : undefined,
      });
      continue;
    }

    let restoredStatus = status;
    if (['attached', 'armed', 'paused'].includes(status.state)) {
      const currentTab = await getTab(status.target.tabId).catch(() => undefined);
      const currentOrigin = pageOrigin(currentTab?.url);
      if (status.origin !== currentOrigin) {
        await setWorkerAutoAttach(debuggerTarget(status.target.tabId), false).catch(() => undefined);
        clearWorkerRuntime(status.target.tabId, status.workerTargets);
        restoredStatus = {
          ...status,
          origin: currentOrigin,
          workerTargets: closeWorkerTargets(status.workerTargets),
        };
        await writeStatus(restoredStatus);
      }
      restoredStatus = await enableWorkerObservation(restoredStatus);
    }

    const possiblyPaused = restoredStatus.state === 'paused'
      || restoredStatus.recovery?.page === 'possibly-paused'
      || Boolean(restoredStatus.pause);
    if (possiblyPaused) {
      if (!restoredStatus.pause || restoredStatus.pause.deadline <= Date.now()) {
        await resumeDeepCapture(restoredStatus.target, 'service-worker-restart');
      } else {
        await scheduleWatchdog(restoredStatus.target.tabId, restoredStatus.pause.deadline);
      }
      continue;
    }

    if (restoredStatus.recovery?.debugger === 'still-attached') {
      await detachDeepCapture(restoredStatus.target);
    }
  }
}

function enqueueDebuggerEvent(tabId: number, task: () => Promise<void>): void {
  const previous = debuggerEventQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  debuggerEventQueues.set(tabId, next);
  void next.catch((error) => console.error('Deep Capture debugger event failed', error)).finally(() => {
    if (debuggerEventQueues.get(tabId) === next) debuggerEventQueues.delete(tabId);
  });
}

export function initializeDeepCaptureService(): void {
  if (initialized || import.meta.env.FIREFOX) return;
  initialized = true;
  const api = chromeDebugger();
  api.onEvent.addListener(((source: Debuggee, method: string, params?: Record<string, unknown>) => {
    if (!source.tabId) return;
    enqueueDebuggerEvent(source.tabId, () => handleDebuggerEvent(source, method, params));
  }) as never);
  api.onDetach.addListener(((source: Debuggee, reason: string) => {
    if (!source.tabId) return;
    enqueueDebuggerEvent(source.tabId, () => handleDebuggerDetach(source, reason));
  }) as never);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(WATCHDOG_PREFIX)) return;
    const tabId = Number(alarm.name.slice(WATCHDOG_PREFIX.length));
    if (!Number.isSafeInteger(tabId)) return;
    void getStoredStatus(tabId).then(async (status) => {
      if (status?.state !== 'paused' || !status.pause) return undefined;
      if (status.pause.deadline <= Date.now()) {
        await resumeDeepCapture(status.target, 'watchdog');
      } else {
        await scheduleWatchdog(tabId, status.pause.deadline);
      }
      return undefined;
    }).catch((error) => console.error('Deep Capture watchdog recovery failed', error));
  });
  void reconcileDeepCaptureSessions().catch((error) => {
    console.error('Deep Capture lifecycle restoration failed', error);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    intentionalDetaches.delete(tabId);
    scriptMetadataByTab.delete(tabId);
    debuggerEventQueues.delete(tabId);
    void getStoredStatus(tabId).then(async (status) => {
      const tasks: Promise<unknown>[] = [clearWatchdog(tabId)];
      if (status) {
        clearWorkerRuntime(tabId, status.workerTargets);
        tasks.push(clearFunctionBreakpoint(debuggerTarget(tabId), status));
        tasks.push(disarmBrowserRecordingDeepBreak(status.target));
      }
      await Promise.allSettled(tasks);
    }).finally(() => removeStatus(tabId));
  });
}
