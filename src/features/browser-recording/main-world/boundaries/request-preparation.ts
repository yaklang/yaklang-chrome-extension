import type {
  BrowserRecordingTransform,
  BrowserRecordingValueEvidence,
} from '@/types/models';

interface TraceContext {
  traceId: string;
  interactionId?: string;
}

interface PreparationEvent {
  operation: string;
  label: string;
  transform: BrowserRecordingTransform;
  inputs: BrowserRecordingValueEvidence[];
  outputs: BrowserRecordingValueEvidence[];
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  inputPreview?: string;
  outputPreview?: string;
  stack?: string;
  scriptUrl?: string;
}

export interface RequestPreparationHost {
  currentTrace(): TraceContext | undefined;
  collectEvidence(value: unknown, path: string): BrowserRecordingValueEvidence[];
  byteLength(value: unknown): number | undefined;
  dataType(value: unknown): string;
  preview(value: unknown): string | undefined;
  stackInfo(): { stack?: string; scriptUrl?: string };
  emit(event: PreparationEvent, context: TraceContext): void;
}

export interface RequestPreparationRuntime {
  start(): void;
  stop(): void;
  ensureAxios(): void;
}

const RETRY_DELAYS = [50, 250, 1_000, 3_000] as const;
const MAX_STAGES_PER_TRACE = 32;
const MAX_TRACKED_TRACES = 64;
const MAX_SERIALIZED_BYTES = 262_144;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function method(owner: Record<string, unknown> | undefined, key: string): Function | undefined {
  try { return typeof owner?.[key] === 'function' ? owner[key] as Function : undefined; } catch { return undefined; }
}

function axiosRequestOwner(window: Window): { owner: Record<string, unknown>; key: string } | undefined {
  const axios = record((window as unknown as { axios?: unknown }).axios);
  if (!axios) return undefined;
  const prototype = record(record(axios.Axios)?.prototype);
  if (method(prototype, 'request')) return { owner: prototype!, key: 'request' };
  if (method(axios, 'request')) return { owner: axios, key: 'request' };
  return undefined;
}

function configValue(config: Record<string, unknown> | undefined, key: string): unknown {
  try { return config?.[key]; } catch { return undefined; }
}

function axiosHeaders(value: unknown): unknown {
  const input = record(value);
  try {
    return typeof input?.toJSON === 'function' ? Reflect.apply(input.toJSON as Function, value, []) : value;
  } catch { return value; }
}

export function createRequestPreparationRuntime(
  window: Window,
  host: RequestPreparationHost,
): RequestPreparationRuntime {
  const restorers: Array<() => void> = [];
  const retryTimers = new Set<number>();
  const wrappers = new WeakSet<Function>();
  const stagesByTrace = new Map<string, number>();
  let active = false;
  let reentrant = false;

  const admit = (): TraceContext | undefined => {
    const context = host.currentTrace();
    if (!context) return undefined;
    const count = stagesByTrace.get(context.traceId) || 0;
    if (count >= MAX_STAGES_PER_TRACE) return undefined;
    stagesByTrace.delete(context.traceId);
    stagesByTrace.set(context.traceId, count + 1);
    while (stagesByTrace.size > MAX_TRACKED_TRACES) stagesByTrace.delete(stagesByTrace.keys().next().value!);
    return context;
  };

  const emit = (factory: () => PreparationEvent): void => {
    if (reentrant) return;
    const context = admit();
    if (!context) return;
    reentrant = true;
    try { host.emit(factory(), context); } catch { /* Transform evidence is best effort. */ } finally { reentrant = false; }
  };

  const replace = (owner: Record<string, unknown>, key: string, wrapped: Function): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor && (!('value' in descriptor) || (!descriptor.writable && !descriptor.configurable))) return false;
    try {
      if (descriptor) Object.defineProperty(owner, key, { ...descriptor, value: wrapped });
      else owner[key] = wrapped;
    } catch { return false; }
    wrappers.add(wrapped);
    restorers.push(() => {
      if (owner[key] !== wrapped) return;
      try {
        if (descriptor) Object.defineProperty(owner, key, descriptor);
        else delete owner[key];
      } catch { /* A page replacement wins during cleanup. */ }
    });
    return true;
  };

  const installJson = (): void => {
    const json = record((window as unknown as { JSON?: unknown }).JSON);
    const original = method(json, 'stringify');
    if (!json || !original || wrappers.has(original)) return;
    const wrapped = function recordedJsonStringify(this: JSON, ...args: unknown[]): unknown {
      const output = Reflect.apply(original, this, args);
      const input = args[0];
      if (input && typeof input === 'object' && typeof output === 'string') {
        const resultBytes = host.byteLength(output);
        if (resultBytes !== undefined && resultBytes <= MAX_SERIALIZED_BYTES) emit(() => ({
          operation: 'JSON.stringify',
          label: 'JSON 序列化',
          transform: {
            adapterId: 'native.json',
            providerKind: 'native',
            category: 'serializer',
            phase: 'output',
          },
          inputs: host.collectEvidence(input, '$input'),
          outputs: host.collectEvidence(output, '$output'),
          byteLength: host.byteLength(input),
          resultByteLength: resultBytes,
          dataType: host.dataType(input),
          inputPreview: host.preview(input),
          outputPreview: host.preview(output),
          ...host.stackInfo(),
        }));
      }
      return output;
    };
    replace(json, 'stringify', wrapped);
  };

  const installUrlSearchParams = (): void => {
    const Constructor = (window as unknown as { URLSearchParams?: typeof URLSearchParams }).URLSearchParams;
    const prototype = Constructor?.prototype as unknown as Record<string, unknown> | undefined;
    if (!prototype) return;
    const nativeToString = method(prototype, 'toString');
    if (nativeToString && !wrappers.has(nativeToString)) {
      const wrapped = function recordedSearchParamsToString(this: URLSearchParams): string {
        const output = Reflect.apply(nativeToString, this, []) as string;
        if (host.byteLength(output)! <= MAX_SERIALIZED_BYTES) emit(() => ({
          operation: 'URLSearchParams.toString',
          label: 'Query/Form 序列化',
          transform: {
            adapterId: 'native.url-search-params',
            providerKind: 'native',
            category: 'serializer',
            phase: 'output',
          },
          inputs: host.collectEvidence(this, '$input'),
          outputs: host.collectEvidence(output, '$output'),
          byteLength: host.byteLength(this),
          resultByteLength: host.byteLength(output),
          dataType: 'URLSearchParams',
          inputPreview: host.preview(this),
          outputPreview: host.preview(output),
          ...host.stackInfo(),
        }));
        return output;
      };
      replace(prototype, 'toString', wrapped);
    }
    const nativeSort = method(prototype, 'sort');
    if (nativeSort && nativeToString && !wrappers.has(nativeSort)) {
      const wrapped = function recordedSearchParamsSort(this: URLSearchParams): void {
        const before = Reflect.apply(nativeToString, this, []) as string;
        Reflect.apply(nativeSort, this, []);
        const after = Reflect.apply(nativeToString, this, []) as string;
        emit(() => ({
          operation: 'URLSearchParams.sort',
          label: 'Query 参数排序',
          transform: {
            adapterId: 'native.url-search-params',
            providerKind: 'native',
            category: 'canonicalization',
            phase: 'output',
          },
          inputs: host.collectEvidence(before, '$input'),
          outputs: host.collectEvidence(after, '$output'),
          byteLength: host.byteLength(before),
          resultByteLength: host.byteLength(after),
          dataType: 'URLSearchParams',
          inputPreview: host.preview(before),
          outputPreview: host.preview(after),
          ...host.stackInfo(),
        }));
      };
      replace(prototype, 'sort', wrapped);
    }
  };

  const ensureAxios = (): void => {
    if (!active) return;
    const resolved = axiosRequestOwner(window);
    if (!resolved) return;
    const original = method(resolved.owner, resolved.key);
    if (!original || wrappers.has(original)) return;
    const wrapped = function recordedAxiosRequest(this: unknown, ...args: unknown[]): unknown {
      emit(() => {
        const config = record(typeof args[0] === 'string' ? args[1] : args[0]);
        const body = configValue(config, 'data');
        const headers = axiosHeaders(configValue(config, 'headers'));
        const query = configValue(config, 'params');
        const evidence = [
          ...host.collectEvidence(body, '$body'),
          ...host.collectEvidence(headers, '$headers'),
          ...host.collectEvidence(query, '$query'),
        ].slice(0, 48);
        return {
          operation: 'axios.request',
          label: 'Axios 请求准备',
          transform: {
            adapterId: 'axios',
            providerKind: 'library',
            category: 'request-builder',
            phase: 'boundary',
          },
          inputs: evidence,
          outputs: evidence.map((item) => ({ ...item })),
          byteLength: host.byteLength(body),
          dataType: host.dataType(body),
          inputPreview: host.preview(body),
          ...host.stackInfo(),
        };
      });
      return Reflect.apply(original, this, args);
    };
    replace(resolved.owner, resolved.key, wrapped);
  };

  const onResourceLoad = (event: Event): void => {
    const target = event.target as { tagName?: unknown } | null;
    if (target?.tagName === 'SCRIPT') ensureAxios();
  };

  return {
    start() {
      if (active) return;
      active = true;
      installJson();
      installUrlSearchParams();
      ensureAxios();
      window.document.addEventListener('load', onResourceLoad, true);
      for (const delay of RETRY_DELAYS) {
        const timer = window.setTimeout(() => {
          retryTimers.delete(timer);
          ensureAxios();
        }, delay);
        retryTimers.add(timer);
      }
    },
    stop() {
      if (!active) return;
      active = false;
      window.document.removeEventListener('load', onResourceLoad, true);
      for (const timer of retryTimers) window.clearTimeout(timer);
      retryTimers.clear();
      while (restorers.length) {
        try { restorers.pop()!(); } catch { /* Cleanup remains best effort. */ }
      }
      stagesByTrace.clear();
    },
    ensureAxios,
  };
}
