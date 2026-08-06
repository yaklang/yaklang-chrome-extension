import { PAGE_RECORDER_PROTOCOL_VERSION, PAGE_RECORDER_REGISTRY_KEY } from '@/features/browser-recording/constants';
import {
  PAGE_RECORDER_REQUEST_EVENT,
  PAGE_RECORDER_RESPONSE_EVENT,
  type PageRecorderBridgeCommand,
  type PageRecorderBridgeRequest,
  type PageRecorderBridgeResponse,
} from '@/features/browser-recording/bridge-protocol';
import { PAGE_CALLABLE_REGISTRY_KEY } from '@/features/page-callable/constants';
import { executeRequestTransaction, executeSideEffectFreeCallable } from '@/features/page-callable/request-transaction';
import { callableExecutionPolicy, settleCallableResult } from '@/features/page-callable/execution';
import {
  createCryptoAdapterRuntime,
  PAGE_CRYPTO_ADAPTERS,
  type CallableOperationKind,
  type CryptoAdapterInvocationPlan,
  type CryptoAdapterOperation,
  type CryptoAdapterRuntime,
  type CryptoAdapterToolkit,
} from '@/features/browser-crypto/adapters';
import { executeTransformDirection } from '@/features/browser-transform/mapping';
import {
  createCommunicationBoundaryRuntime,
  type CommunicationBoundaryRuntime,
} from '@/features/browser-recording/main-world/boundaries/communication';
import {
  createNetworkBoundaryRuntime,
  type NetworkBoundaryRuntime,
} from '@/features/browser-recording/main-world/boundaries/network';
import {
  createRequestPreparationRuntime,
  type RequestPreparationRuntime,
} from '@/features/browser-recording/main-world/boundaries/request-preparation';
import {
  createEncodingTransformRuntime,
  type EncodingTransformRuntime,
} from '@/features/browser-recording/main-world/transforms/encoding';
import {
  createLibraryTransformRuntime,
  type LibraryTransformRuntime,
} from '@/features/browser-recording/main-world/transforms/library-transform';
import {
  createRecordingEvidenceRuntime,
  type RecordingEvidenceRuntime,
} from '@/features/browser-recording/main-world/evidence';
import {
  createRecordingTraceRuntime,
  type RecordingTraceContext,
  type RecordingTraceRuntime,
} from '@/features/browser-recording/main-world/trace';
import { RetainedCallBudget } from '@/features/browser-recording/main-world/retained-call-budget';
import { estimateRetainedCallBytes } from '@/features/browser-recording/main-world/retained-value-size';
import { ExtensionError } from '@/shared/errors';
import type {
  BrowserPageCallableExecution,
  BrowserPageCallableExecutionPolicy,
  BrowserPageCallableTransaction,
  BrowserRecordingCrypto,
  BrowserRecordingNavigation,
  BrowserRecordingTransform,
  BrowserTransformDirection,
  BrowserTransformDirectionName,
  BrowserTransformPacket,
} from '@/types/models';

type RecordingKind = 'interaction' | 'fetch' | 'xhr' | 'form' | 'beacon' | 'worker' | 'message'
  | 'websocket' | 'crypto' | 'transform' | 'navigation';

interface RecorderOptions {
  captureValues: boolean;
  maxEntries: number;
  maxValueBytes: number;
  expiresAt?: number;
}

interface ValueEvidence {
  path: string;
  fingerprint: string;
  encoding: 'text' | 'bytes' | 'hex' | 'base64' | 'json';
  byteLength: number;
  preview?: string;
}

type CallArgumentRole = 'data' | 'key' | 'iv' | 'algorithm' | 'options' | 'signature'
  | 'salt' | 'nonce' | 'aad' | 'unknown';

interface CallArgumentEvidence {
  index: number;
  role: CallArgumentRole;
  dataType: string;
  byteLength?: number;
  replaceable: boolean;
  retained: boolean;
  summary?: string;
}

interface RecordingEvent {
  id: string;
  sequence: number;
  timestamp: number;
  durationMs?: number;
  recordingId: string;
  traceId: string;
  interactionId?: string;
  parentEventId?: string;
  kind: RecordingKind;
  source?: 'page' | 'browser';
  documentId?: string;
  operation: string;
  label?: string;
  url?: string;
  method?: string;
  crypto?: BrowserRecordingCrypto;
  transform?: BrowserRecordingTransform;
  direction?: 'send' | 'receive';
  socketId?: string;
  channelId?: string;
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  stack?: string;
  scriptUrl?: string;
  wrapperHandleId?: string;
  callHandleId?: string;
  callableCapable?: boolean;
  arguments?: CallArgumentEvidence[];
  inputs: ValueEvidence[];
  outputs: ValueEvidence[];
  sensitiveCaptured: boolean;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
  navigation?: BrowserRecordingNavigation;
}

interface PageCallableMetadata {
  id: string;
  name: string;
  kind: 'recorded-call' | 'business-closure' | 'request-transaction' | 'global-function';
  operation: string;
  algorithm?: string;
  crypto?: BrowserRecordingCrypto;
  origin: string;
  lifecycle: 'document';
  execution: BrowserPageCallableExecutionPolicy;
  inputSlots: Array<{
    id: string;
    name: string;
    index: number;
    role: CallArgumentRole;
    dataType: string;
    required: boolean;
    retained: boolean;
  }>;
  output: {
    dataType: string;
    encoding: 'auto' | 'utf8' | 'hex' | 'base64' | 'json';
    shape: 'value' | 'envelope';
    paths: string[];
  };
  transaction?: BrowserPageCallableTransaction;
  provenance: {
    recordingId?: string;
    traceId?: string;
    eventId?: string;
    sourceUrl?: string;
    lineNumber?: number;
    functionName?: string;
  };
  createdAt: number;
}

interface PageCallableRegistryEntry {
  metadata: PageCallableMetadata;
  invoke(args: unknown[], context?: { domInputCount: number }): unknown;
}

interface RecorderSnapshot {
  version: typeof PAGE_RECORDER_PROTOCOL_VERSION;
  active: boolean;
  recordingId?: string;
  startedAt?: number;
  count: number;
  droppedCount: number;
  retainedCallCount: number;
  retainedCallBytes: number;
  retainedCallDroppedCount: number;
  options?: RecorderOptions;
  events: RecordingEvent[];
  callables: PageCallableMetadata[];
}

interface RecordedCallHandle {
  id: string;
  retainedBytes: number;
  kind: CallableOperationKind;
  operation: string;
  crypto: BrowserRecordingCrypto;
  original: Function;
  thisArg: unknown;
  args: unknown[];
  inputIndex: number;
  originalInput: unknown;
  eventId?: string;
  traceId?: string;
  recordingId?: string;
  sourceUrl?: string;
  outputDataType?: string;
  outputEncoding?: PageCallableMetadata['output']['encoding'];
  resultMode: 'sync' | 'promise';
  adaptInput(value: unknown): unknown;
}

interface RecorderController {
  version: typeof PAGE_RECORDER_PROTOCOL_VERSION;
  command(command: string, input?: Record<string, unknown>): unknown;
}

interface DeepBreakMatcher {
  wrapperHandleId: string;
  operation: string;
  scriptUrl?: string;
}

type RecordingEventInput = Omit<RecordingEvent,
  'id' | 'sequence' | 'timestamp' | 'recordingId' | 'traceId' | 'interactionId' | 'parentEventId' | 'sensitiveCaptured' | 'inputs' | 'outputs'
> & { inputs?: ValueEvidence[]; outputs?: ValueEvidence[] };

export default defineUnlistedScript(() => {
  const REGISTRY_KEY = PAGE_RECORDER_REGISTRY_KEY;
  const CALLABLE_REGISTRY_KEY = PAGE_CALLABLE_REGISTRY_KEY;
  const registry = window as unknown as Record<string, unknown>;
  const bridgeScript = document.currentScript;
  if (bridgeScript instanceof HTMLScriptElement) {
    const bridgeParse = JSON.parse.bind(JSON);
    const bridgeStringify = JSON.stringify.bind(JSON);
    const allowedCommands = new Set<PageRecorderBridgeCommand>([
      'start', 'resume', 'navigation.record', 'stop', 'clear', 'status', 'get',
      'callable.create', 'callable.list', 'callable.execute', 'callable.delete', 'transform.execute',
    ]);
    bridgeScript.addEventListener(PAGE_RECORDER_REQUEST_EVENT, (rawEvent) => {
      if (!(rawEvent instanceof CustomEvent) || typeof rawEvent.detail !== 'string') return;
      void (async () => {
        let request: PageRecorderBridgeRequest;
        try { request = bridgeParse(rawEvent.detail) as PageRecorderBridgeRequest; } catch { return; }
        if (!request?.id || !allowedCommands.has(request.command)) return;
        let response: PageRecorderBridgeResponse;
        try {
          const activeController = registry[REGISTRY_KEY] as RecorderController | undefined;
          if (activeController?.version !== PAGE_RECORDER_PROTOCOL_VERSION || typeof activeController.command !== 'function') {
            throw new Error('页面录制器尚未就绪');
          }
          response = {
            id: request.id,
            ok: true,
            result: await Promise.resolve(activeController.command(request.command, request.input || {})),
          };
        } catch (error) {
          response = {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          bridgeScript.dispatchEvent(new CustomEvent(PAGE_RECORDER_RESPONSE_EVENT, { detail: bridgeStringify(response) }));
        } catch (error) {
          const fallback: PageRecorderBridgeResponse = {
            id: request.id,
            ok: false,
            error: `页面录制器结果无法序列化：${error instanceof Error ? error.message : String(error)}`,
          };
          bridgeScript.dispatchEvent(new CustomEvent(PAGE_RECORDER_RESPONSE_EVENT, { detail: bridgeStringify(fallback) }));
        }
      })();
    });
  }
  const existing = registry[REGISTRY_KEY] as RecorderController | undefined;
  if (existing?.version === PAGE_RECORDER_PROTOCOL_VERSION) return;

  const nativeStringify = JSON.stringify.bind(JSON);
  const nativeAtob = window.atob.bind(window);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const restorers: Array<() => void> = [];
  const handles = new RetainedCallBudget<RecordedCallHandle>();
  const activeEventStack: string[] = [];
  let expiryTimer: number | undefined;
  let active = false;
  let recordingId: string | undefined;
  let startedAt: number | undefined;
  let uniqueSequence = 0;
  let deepBreakMatcher: DeepBreakMatcher | undefined;
  let restoreAfterDeepBreak = false;
  let options: RecorderOptions = { captureValues: false, maxEntries: 200, maxValueBytes: 2_048 };
  const evidenceRuntime: RecordingEvidenceRuntime = createRecordingEvidenceRuntime(window, () => options);
  const traceRuntime: RecordingTraceRuntime = createRecordingTraceRuntime({
    active: () => active,
    recordingId: () => recordingId,
    captureValues: () => options.captureValues,
    maxEntries: () => options.maxEntries,
    parentEventId: () => activeEventStack.at(-1),
    unique,
  });

  function pageCallableRegistry(): Map<string, PageCallableRegistryEntry> {
    const current = registry[CALLABLE_REGISTRY_KEY];
    if (current instanceof Map) return current as Map<string, PageCallableRegistryEntry>;
    const created = new Map<string, PageCallableRegistryEntry>();
    Object.defineProperty(registry, CALLABLE_REGISTRY_KEY, {
      value: created,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    return created;
  }

  function callableMetadata(): PageCallableMetadata[] {
    return [...pageCallableRegistry().values()].slice(-128).map((entry) => entry.metadata);
  }

  function clearRecordedCallables(): void {
    const callables = pageCallableRegistry();
    for (const [id, entry] of callables) {
      if (entry.metadata.kind === 'recorded-call') callables.delete(id);
    }
  }

  function unique(prefix: string): string {
    uniqueSequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}-${uniqueSequence.toString(36)}`;
  }

  function dataType(value: unknown): string {
    return evidenceRuntime.dataType(value);
  }

  function asBytes(value: unknown): Uint8Array | undefined {
    return evidenceRuntime.asBytes(value);
  }

  function bytesToBase64(bytes: Uint8Array): string {
    return evidenceRuntime.bytesToBase64(bytes);
  }

  function fingerprint(value: string): string {
    return evidenceRuntime.fingerprint(value);
  }

  function reseedFingerprints(): void {
    evidenceRuntime.reseed();
  }

  function collectEvidence(
    value: unknown,
    path = '$',
    depth = 0,
    output: ValueEvidence[] = [],
    parseStringContainers = true,
  ): ValueEvidence[] {
    return evidenceRuntime.collect(value, path, depth, output, parseStringContainers);
  }

  function byteLength(value: unknown): number | undefined {
    return evidenceRuntime.byteLength(value);
  }

  function preview(value: unknown): string | undefined {
    return evidenceRuntime.preview(value);
  }

  function stackInfo(): { stack?: string; scriptUrl?: string } {
    try {
      const stack = new Error().stack?.split('\n').slice(2, 10).join('\n').slice(0, 4_096);
      const scriptUrl = stack?.match(/https?:\/\/[^\s)]+/)?.[0]?.slice(0, 2_048);
      return { stack, scriptUrl };
    } catch { return {}; }
  }

  function pauseForDeepCapture(wrapperHandleId: string, scriptUrl?: string): void {
    const matcher = deepBreakMatcher;
    if (!matcher || matcher.wrapperHandleId !== wrapperHandleId) return;
    if (matcher.scriptUrl && scriptUrl && !scriptUrl.startsWith(matcher.scriptUrl)) return;
    const restoreAfterResume = restoreAfterDeepBreak;
    deepBreakMatcher = undefined;
    restoreAfterDeepBreak = false;
    if (restoreAfterResume) stop();
  }

  function deepCaptureFunction(wrapperHandleId: string): Function | undefined {
    return cryptoAdapterRuntime.wrapperFunction(wrapperHandleId)
      || communicationBoundaryRuntime.wrapperFunction(wrapperHandleId);
  }

  function record(input: RecordingEventInput, context?: RecordingTraceContext): RecordingEvent | undefined {
    return traceRuntime.record(input, context) as RecordingEvent | undefined;
  }

  function observe(factory: () => RecordingEventInput, context?: RecordingTraceContext): RecordingEvent | undefined {
    return traceRuntime.observe(factory, context) as RecordingEvent | undefined;
  }

  function bestEffort(operation: () => void): void {
    try { operation(); } catch { /* Recording must not change page behavior. */ }
  }

  function errorMessage(error: unknown): string {
    try { return (error instanceof Error ? error.message : String(error)).slice(0, 512); } catch { return 'Unknown error'; }
  }

  function argumentEvidence(
    index: number,
    role: CallArgumentRole,
    value: unknown,
    replaceable: boolean,
    retained: boolean,
    summary?: string,
  ): CallArgumentEvidence {
    const type = dataType(value);
    const sizeEligible = ['data', 'key', 'iv', 'signature', 'salt', 'nonce', 'aad'].includes(role)
      && type !== 'CryptoKey';
    const size = sizeEligible ? byteLength(value) : undefined;
    return {
      index,
      role,
      dataType: type.slice(0, 120),
      byteLength: size === undefined ? undefined : Math.max(0, size),
      replaceable,
      retained,
      summary: summary?.slice(0, 240),
    };
  }

  function interactionLabel(target: EventTarget | null): string {
    if (!(target instanceof Element)) return '页面操作';
    const element = target.closest('button, a, input, select, textarea, [role]') || target;
    const text = [element.getAttribute('aria-label'), element.getAttribute('name'), element.getAttribute('title'), element.textContent]
      .find((value) => value?.trim())?.trim().replace(/\s+/g, ' ').slice(0, 120);
    return text || element.tagName.toLowerCase();
  }

  function beginInteraction(operation: string, target: EventTarget | null): void {
    if (!active) return;
    const interactionId = unique('interaction');
    const context = { traceId: unique('trace'), interactionId };
    traceRuntime.bindContext(context);
    observe(() => ({ kind: 'interaction', operation, label: interactionLabel(target) }), context);
  }

  function patchInteractions(): void {
    const onClick = (event: MouseEvent) => { if (event.button === 0) beginInteraction('click', event.target); };
    const onSubmit = (event: SubmitEvent) => beginInteraction('submit', event.target);
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    restorers.push(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    });
  }

  function registerHandle(input: Omit<RecordedCallHandle, 'id' | 'retainedBytes'>): string | undefined {
    const id = unique('handle');
    const retainedBytes = estimateRetainedCallBytes(input.args);
    return handles.add({ id, retainedBytes, ...input }) ? id : undefined;
  }

  function invokeCryptoAdapter(
    operation: CryptoAdapterOperation,
    original: Function,
    thisArg: unknown,
    args: unknown[],
    wrapperHandleId: string,
    installDynamic: (operations: CryptoAdapterOperation[]) => void,
  ): unknown {
    const invokeOriginal = (): unknown => operation.invocationMode === 'construct'
      ? Reflect.construct(original, args)
      : Reflect.apply(original, thisArg, args);
    let plan: CryptoAdapterInvocationPlan;
    try {
      plan = operation.describe(thisArg, args, cryptoAdapterToolkit);
    } catch {
      return invokeOriginal();
    }
    const started = performance.now();
    const inputIndex = plan.inputIndex;
    const callHandleId = plan.callableKind && inputIndex >= 0 ? registerHandle({
      kind: plan.callableKind,
      operation: `${plan.crypto.adapterId}.${plan.crypto.operation}`,
      crypto: plan.crypto,
      original,
      thisArg,
      args: [...args],
      inputIndex,
      originalInput: args[inputIndex],
      outputEncoding: plan.outputEncoding || plan.crypto.outputEncoding,
      resultMode: operation.resultMode,
      adaptInput: plan.adaptInput || ((value) => defaultAdaptInput(value, args[inputIndex])),
    }) : undefined;
    const item = observe(() => ({
      kind: 'crypto',
      operation: plan.crypto.operation,
      crypto: plan.crypto,
      wrapperHandleId,
      callHandleId,
      callableCapable: Boolean(callHandleId),
      arguments: plan.arguments,
      byteLength: inputIndex >= 0 ? byteLength(args[inputIndex]) : undefined,
      dataType: inputIndex >= 0 ? dataType(args[inputIndex]) : undefined,
      inputPreview: inputIndex >= 0 ? preview(args[inputIndex]) : undefined,
      inputs: inputIndex >= 0
        ? plan.inputEvidence?.(args[inputIndex]) || collectEvidence(args[inputIndex], '$input')
        : [],
      ...stackInfo(),
    }));
    if (item && callHandleId) {
      const handle = handles.get(callHandleId);
      if (handle) Object.assign(handle, {
        eventId: item.id,
        traceId: item.traceId,
        recordingId: item.recordingId,
        sourceUrl: item.scriptUrl,
      });
    }
    pauseForDeepCapture(wrapperHandleId, item?.scriptUrl);
    if (item) activeEventStack.push(item.id);
    const complete = (output: unknown): void => {
      if (plan.discoverResult) {
        try { installDynamic(plan.discoverResult(output)); } catch { /* Runtime session discovery is optional. */ }
      }
      if (!item) return;
      item.durationMs = Math.max(0, performance.now() - started);
      item.resultByteLength = byteLength(output);
      item.outputPreview = preview(output);
      item.outputs = plan.outputEvidence?.(output) || collectEvidence(output, '$output');
      item.error = plan.outputError?.(output) || item.error;
      const handle = callHandleId ? handles.get(callHandleId) : undefined;
      if (handle) handle.outputDataType = dataType(output);
    };
    const fail = (error: unknown): void => {
      if (item) item.error = errorMessage(error);
    };
    try {
      const output = invokeOriginal();
      if (operation.resultMode === 'promise') {
        if (item) activeEventStack.pop();
        if (output && typeof (output as { then?: unknown }).then === 'function') {
          void (output as Promise<unknown>).then(complete, fail);
        } else {
          complete(output);
        }
      } else {
        if (item) activeEventStack.pop();
        complete(output);
      }
      return output;
    } catch (error) {
      if (item) activeEventStack.pop();
      fail(error);
      throw error;
    }
  }

  const cryptoAdapterToolkit: CryptoAdapterToolkit = {
    unique,
    byteLength,
    dataType,
    fingerprint,
    argument: argumentEvidence,
    collectEvidence: (value, path) => collectEvidence(value, path),
    defaultOutputEvidence: (value) => collectEvidence(value, '$output'),
    defaultAdaptInput,
    bytesForInput,
    bytesToBase64,
  };

  const cryptoAdapterRuntime: CryptoAdapterRuntime = createCryptoAdapterRuntime(
    PAGE_CRYPTO_ADAPTERS,
    { window, crypto: globalThis.crypto },
    cryptoAdapterToolkit,
    {
      unique,
      invoke: invokeCryptoAdapter,
    },
  );

  const communicationBoundaryRuntime: CommunicationBoundaryRuntime = createCommunicationBoundaryRuntime(window, {
    unique,
    describe(value, path) {
      return {
        byteLength: byteLength(value),
        dataType: dataType(value),
        preview: preview(value),
        evidence: collectEvidence(value, path),
      };
    },
    stackInfo,
    emit: (input, context) => {
      if (context) traceRuntime.bindContext(context);
      return observe(() => input, context);
    },
    afterWrapperInvoke: pauseForDeepCapture,
  });

  const networkBoundaryRuntime: NetworkBoundaryRuntime = createNetworkBoundaryRuntime(window, {
    unique,
    byteLength,
    dataType,
    asBytes,
    preview,
    collectEvidence: (value, path) => collectEvidence(value, path),
    stackInfo,
    context: () => traceRuntime.context(),
    emit: (event, context) => { observe(() => event, context); },
  });

  const encodingTransformRuntime: EncodingTransformRuntime = createEncodingTransformRuntime(window, {
    byteLength,
    preview,
    collectEvidence: (value, path) => collectEvidence(value, path),
    stackInfo,
    emit: (event) => { observe(() => ({ kind: 'transform', ...event })); },
  });

  const libraryTransformRuntime: LibraryTransformRuntime = createLibraryTransformRuntime(window, {
    currentTrace: () => traceRuntime.currentContext(),
    collectEvidence: (value, path) => collectEvidence(value, path),
    byteLength,
    dataType,
    preview,
    stackInfo,
    emit: (event, context) => { observe(() => ({ kind: 'transform', ...event }), context); },
  });

  const requestPreparationRuntime: RequestPreparationRuntime = createRequestPreparationRuntime(window, {
    currentTrace: () => traceRuntime.currentContext(),
    collectEvidence: (value, path) => collectEvidence(value, path),
    byteLength,
    dataType,
    preview,
    stackInfo,
    emit: (event, context) => { observe(() => ({ kind: 'transform', ...event }), context); },
  });

  function installObservers(): void {
    bestEffort(patchInteractions);
    cryptoAdapterRuntime.start();
    communicationBoundaryRuntime.start();
    networkBoundaryRuntime.start();
    requestPreparationRuntime.start();
    encodingTransformRuntime.start();
    libraryTransformRuntime.start();
  }

  function stop(): void {
    active = false;
    if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    expiryTimer = undefined;
    cryptoAdapterRuntime.stop();
    communicationBoundaryRuntime.stop();
    networkBoundaryRuntime.stop();
    requestPreparationRuntime.stop();
    encodingTransformRuntime.stop();
    libraryTransformRuntime.stop();
    while (restorers.length) bestEffort(restorers.pop()!);
    activeEventStack.length = 0;
    traceRuntime.releaseContext();
    deepBreakMatcher = undefined;
    restoreAfterDeepBreak = false;
  }

  function resumeRecording(): void {
    if (active || !startedAt) return;
    active = true;
    installObservers();
    if (options.expiresAt) expiryTimer = window.setTimeout(stop, Math.max(0, options.expiresAt - Date.now()));
  }

  function snapshot(limit = options.maxEntries): RecorderSnapshot {
    const trace = traceRuntime.snapshot(limit);
    return {
      version: PAGE_RECORDER_PROTOCOL_VERSION,
      active,
      recordingId,
      startedAt,
      count: trace.count,
      droppedCount: trace.droppedCount,
      retainedCallCount: handles.size,
      retainedCallBytes: handles.retainedBytes,
      retainedCallDroppedCount: handles.droppedCount,
      options: startedAt ? { ...options } : undefined,
      events: trace.events as RecordingEvent[],
      callables: callableMetadata(),
    };
  }

  function normalizedBytes(value: unknown): Uint8Array | undefined {
    const direct = asBytes(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.type !== 'bytes' || typeof record.base64 !== 'string') return undefined;
    const binary = nativeAtob(record.base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesForInput(value: unknown): Uint8Array | undefined {
    return normalizedBytes(value) || (typeof value === 'string' ? encoder.encode(value) : undefined);
  }

  function defaultAdaptInput(value: unknown, originalInput: unknown): unknown {
    if (typeof originalInput === 'string') {
      const bytes = normalizedBytes(value);
      return bytes ? decoder.decode(bytes) : typeof value === 'string' ? value : nativeStringify(value);
    }
    const bytes = bytesForInput(value);
    if (!bytes) return value;
    if (originalInput instanceof ArrayBuffer) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (ArrayBuffer.isView(originalInput)) return bytes;
    return value;
  }

  function createRecordedCallable(handle: RecordedCallHandle, name: string): PageCallableMetadata {
    const id = unique('callable');
    const metadata: PageCallableMetadata = {
      id,
      name: name.trim().slice(0, 120) || handle.operation,
      kind: 'recorded-call',
      operation: handle.operation,
      algorithm: handle.crypto.algorithm,
      crypto: handle.crypto,
      origin: location.origin,
      lifecycle: 'document',
      execution: callableExecutionPolicy(handle.resultMode),
      inputSlots: [{
        id: 'data',
        name: 'data',
        index: 0,
        role: 'data',
        dataType: dataType(handle.originalInput),
        required: true,
        retained: false,
      }],
      output: {
        dataType: handle.outputDataType || 'unknown',
        encoding: handle.outputEncoding || 'auto',
        shape: 'value',
        paths: [],
      },
      provenance: {
        recordingId: handle.recordingId,
        traceId: handle.traceId,
        eventId: handle.eventId,
        sourceUrl: handle.sourceUrl,
        functionName: handle.original.name || undefined,
      },
      createdAt: Date.now(),
    };
    pageCallableRegistry().set(id, {
      metadata,
      invoke(values) {
        if (!values.length) throw new Error('页面函数缺少 data 参数');
        const args = [...handle.args];
        args[handle.inputIndex] = handle.adaptInput(values[0]);
        return Reflect.apply(handle.original, handle.thisArg, args);
      },
    });
    return metadata;
  }

  async function executePageCallable(callableId: string, values: unknown[]): Promise<unknown> {
    const entry = pageCallableRegistry().get(callableId);
    if (!entry) throw new Error('页面函数已经失效，页面可能已经刷新');
    const started = performance.now();
    const result = entry.metadata.kind === 'request-transaction'
      ? await executeRequestTransaction({
        transaction: entry.metadata.transaction || (() => { throw new Error('请求事务缺少边界配置'); })(),
        logicalInput: values[0],
        invoke: (context) => entry.invoke(values, context),
        timeoutMs: entry.metadata.execution.timeoutMs,
      })
      : entry.metadata.kind === 'business-closure' || entry.metadata.kind === 'global-function'
        ? await executeSideEffectFreeCallable(() => entry.invoke(values), entry.metadata.execution)
        : await settleCallableResult(entry.invoke(values), entry.metadata.execution);
    const seen = new WeakSet<object>();
    let nodes = 0;
    const maxBytes = 8 * 1024 * 1024;
    const normalize = (value: unknown, depth = 0): unknown => {
      nodes += 1;
      if (nodes > 100_000) throw new Error('页面函数结果包含过多节点');
      if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') {
        if (encoder.encode(value).byteLength > maxBytes) throw new Error('页面函数字符串结果超过 8 MiB');
        return value;
      }
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function' || typeof value === 'symbol') throw new Error(`页面函数返回了不可序列化的 ${typeof value}`);
      if (depth >= 32) throw new Error('页面函数结果嵌套超过 32 层');
      const bytes = asBytes(value);
      if (bytes) {
        if (bytes.byteLength > maxBytes) throw new Error('页面函数字节结果超过 8 MiB');
        return { type: 'bytes', byteLength: bytes.byteLength, base64: bytesToBase64(bytes) };
      }
      if (value instanceof Date) return value.toISOString();
      if (value instanceof URLSearchParams) return value.toString();
      if (typeof Response !== 'undefined' && value instanceof Response) {
        return { type: 'Response', status: value.status, statusText: value.statusText, url: value.url, headers: Object.fromEntries(value.headers) };
      }
      if (value && typeof value === 'object') {
        const cryptoValue = value as { sigBytes?: unknown; ciphertext?: unknown; toString?: unknown };
        if ((typeof cryptoValue.sigBytes === 'number' || cryptoValue.ciphertext) && typeof cryptoValue.toString === 'function') {
          const text = Reflect.apply(cryptoValue.toString as Function, value, []);
          if (typeof text === 'string' && text !== '[object Object]') return text;
        }
        if (seen.has(value)) throw new Error('页面函数结果包含循环引用');
        seen.add(value);
        try {
          if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
          const output: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = normalize(item, depth + 1);
          return output;
        } finally {
          seen.delete(value);
        }
      }
      throw new Error(`页面函数返回了不可序列化的 ${typeof value}`);
    };
    const value = normalize(result);
    let preview: string;
    try { preview = typeof value === 'string' ? value : nativeStringify(value); } catch { preview = String(value); }
    return {
      callableId,
      type: dataType(result).toLowerCase(),
      preview: preview.slice(0, 8_192),
      value,
      byteLength: encoder.encode(preview).byteLength,
      durationMs: Math.max(0, performance.now() - started),
    };
  }

  const controller: RecorderController = {
    version: PAGE_RECORDER_PROTOCOL_VERSION,
    command(command, input = {}) {
      if (command === 'start') {
        stop();
        options = {
          captureValues: input.captureValues === true,
          maxEntries: Math.max(20, Math.min(Number(input.maxEntries) || 200, 500)),
          maxValueBytes: Math.max(256, Math.min(Number(input.maxValueBytes) || 2_048, 8_192)),
          expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : undefined,
        };
        handles.clear();
        clearRecordedCallables();
        traceRuntime.reset(Number.isSafeInteger(input.sequenceStart) && Number(input.sequenceStart) >= 0
          ? Number(input.sequenceStart)
          : 0);
        recordingId = typeof input.recordingId === 'string' && input.recordingId.trim()
          ? input.recordingId.trim().slice(0, 160)
          : unique('recording');
        startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
          ? input.startedAt
          : Date.now();
        reseedFingerprints();
        active = true;
        installObservers();
        if (options.expiresAt) expiryTimer = window.setTimeout(stop, Math.max(0, options.expiresAt - Date.now()));
        return snapshot();
      }
      if (command === 'resume') {
        if (Number.isSafeInteger(input.sequenceStart)) traceRuntime.advanceSequenceStart(Number(input.sequenceStart));
        resumeRecording();
        return snapshot();
      }
      if (command === 'navigation.record') {
        const navigation = input.navigation as BrowserRecordingNavigation | undefined;
        if (!navigation || typeof navigation.toUrl !== 'string') throw new Error('页面跳转事件无效');
        record({
          kind: 'navigation',
          source: 'browser',
          documentId: typeof input.documentId === 'string' ? input.documentId.slice(0, 160) : undefined,
          operation: String(input.operation || 'navigate').slice(0, 160),
          label: String(input.label || '页面跳转').slice(0, 240),
          url: navigation.toUrl.slice(0, 8_192),
          navigation,
        });
        return snapshot();
      }
      if (command === 'stop') { stop(); return snapshot(); }
      if (command === 'deep.arm') {
        if (!startedAt) throw new Error('请先录制一次页面操作，再进入深度捕获');
        restoreAfterDeepBreak = !active;
        resumeRecording();
        const matcherKind = input.kind === 'boundary' ? 'boundary' : 'crypto';
        const adapterId = String(input.adapterId || '').trim().slice(0, 64);
        const eventKind = String(input.eventKind || '').trim().slice(0, 32);
        const operation = String(input.operation || '').trim().slice(0, 240);
        const wrapperHandleId = String(input.wrapperHandleId || '').trim().slice(0, 160);
        if (!operation || !wrapperHandleId || (matcherKind === 'crypto' ? !adapterId : !['beacon', 'worker', 'message'].includes(eventKind))) {
          throw new Error('深度捕获目标、操作或函数句柄不完整');
        }
        if (!deepCaptureFunction(wrapperHandleId)) {
          const shouldRestore = restoreAfterDeepBreak;
          restoreAfterDeepBreak = false;
          if (shouldRestore) stop();
          throw new Error('目标密码函数已经失效，请重新录制一次当前页面操作');
        }
        deepBreakMatcher = {
          wrapperHandleId,
          operation,
          scriptUrl: typeof input.scriptUrl === 'string' ? input.scriptUrl.slice(0, 2_048) : undefined,
        };
        return { armed: true, kind: matcherKind, adapterId: adapterId || undefined, eventKind: eventKind || undefined, operation, wrapperHandleId };
      }
      if (command === 'deep.function') return deepCaptureFunction(String(input.wrapperHandleId || ''));
      if (command === 'deep.disarm') {
        const shouldRestore = restoreAfterDeepBreak;
        deepBreakMatcher = undefined;
        restoreAfterDeepBreak = false;
        if (shouldRestore) stop();
        return { armed: false };
      }
      if (command === 'clear') {
        stop();
        traceRuntime.reset();
        handles.clear();
        clearRecordedCallables();
        recordingId = undefined;
        startedAt = undefined;
        return snapshot();
      }
      if (command === 'status' || command === 'get') return snapshot(typeof input.limit === 'number' ? input.limit : options.maxEntries);
      if (command === 'callable.create') {
        const callHandleId = String(input.callHandleId || '');
        const handle = handles.get(callHandleId);
        if (!handle) throw new Error('加解密调用句柄不存在或已经失效');
        return createRecordedCallable(handle, String(input.name || handle.operation));
      }
      if (command === 'callable.list') return callableMetadata();
      if (command === 'callable.execute') {
        return executePageCallable(String(input.callableId || ''), Array.isArray(input.args) ? input.args : []);
      }
      if (command === 'callable.delete') {
        pageCallableRegistry().delete(String(input.callableId || ''));
        return callableMetadata();
      }
      if (command === 'transform.execute') {
        const directionName = String(input.directionName) as BrowserTransformDirectionName;
        return executeTransformDirection(
          String(input.profileId || ''),
          directionName,
          input.direction as unknown as BrowserTransformDirection,
          input.packet as unknown as BrowserTransformPacket,
          async (callableId, args) => await executePageCallable(callableId, args) as BrowserPageCallableExecution,
        ).then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({
            ok: false,
            error: {
              code: error instanceof ExtensionError ? error.code : 'transform_page_execution_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
      throw new Error(`不支持的录制命令: ${command}`);
    },
  };

  Object.defineProperty(registry, REGISTRY_KEY, { value: controller, configurable: true, enumerable: false, writable: false });
});
