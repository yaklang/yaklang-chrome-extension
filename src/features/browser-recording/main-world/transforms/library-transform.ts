import type {
  BrowserRecordingTransform,
  BrowserRecordingValueEvidence,
} from '@/types/models';

interface TraceContext {
  traceId: string;
  interactionId?: string;
}

interface LibraryTransformEvent {
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
  error?: string;
}

export interface LibraryTransformHost {
  currentTrace(): TraceContext | undefined;
  collectEvidence(value: unknown, path: string): BrowserRecordingValueEvidence[];
  byteLength(value: unknown): number | undefined;
  dataType(value: unknown): string;
  preview(value: unknown): string | undefined;
  stackInfo(): { stack?: string; scriptUrl?: string };
  emit(event: LibraryTransformEvent, context: TraceContext): void;
}

export interface LibraryTransformRuntime {
  start(): void;
  stop(): void;
  refresh(): void;
}

interface MethodSpec {
  adapterId: string;
  category: BrowserRecordingTransform['category'];
  key: string;
  label: string;
  operation: string;
  phase: BrowserRecordingTransform['phase'];
  output?(thisArg: unknown, result: unknown): unknown;
}

interface CapturedLibraryInput {
  inputs: BrowserRecordingValueEvidence[];
  byteLength?: number;
  dataType: string;
  inputPreview?: string;
  source: { stack?: string; scriptUrl?: string };
}

const RETRY_DELAYS = [50, 250, 1_000, 3_000] as const;
const MAX_STAGES_PER_TRACE = 48;
const MAX_TRACKED_TRACES = 64;
const MAX_LIBRARY_VALUE_BYTES = 1_048_576;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined;
}

function method(
  owner: Record<string, unknown> | undefined,
  key: string,
): Function | undefined {
  try {
    return typeof owner?.[key] === 'function' ? owner[key] as Function : undefined;
  } catch {
    return undefined;
  }
}

function child(
  owner: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  try {
    return record(owner?.[key]);
  } catch {
    return undefined;
  }
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 512);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function',
  );
}

export function createLibraryTransformRuntime(
  scope: Window,
  host: LibraryTransformHost,
): LibraryTransformRuntime {
  const restorers: Array<() => void> = [];
  const retryTimers = new Set<number>();
  const wrappers = new WeakSet<Function>();
  const stagesByTrace = new Map<string, number>();
  let active = false;
  let reentrant = false;

  const admit = (): TraceContext | undefined => {
    let context: TraceContext | undefined;
    try {
      context = host.currentTrace();
    } catch {
      return undefined;
    }
    if (!context) return undefined;
    const count = stagesByTrace.get(context.traceId) || 0;
    if (count >= MAX_STAGES_PER_TRACE) return undefined;
    stagesByTrace.delete(context.traceId);
    stagesByTrace.set(context.traceId, count + 1);
    while (stagesByTrace.size > MAX_TRACKED_TRACES) {
      stagesByTrace.delete(stagesByTrace.keys().next().value!);
    }
    return context;
  };

  const replace = (
    owner: Record<string, unknown>,
    key: string,
    wrapped: Function,
  ): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (
      descriptor
      && (!('value' in descriptor) || (!descriptor.writable && !descriptor.configurable))
    ) return false;
    try {
      if (descriptor) Object.defineProperty(owner, key, { ...descriptor, value: wrapped });
      else owner[key] = wrapped;
    } catch {
      return false;
    }
    wrappers.add(wrapped);
    restorers.push(() => {
      if (owner[key] !== wrapped) return;
      try {
        if (descriptor) Object.defineProperty(owner, key, descriptor);
        else delete owner[key];
      } catch {
        // A page replacement wins during cleanup.
      }
    });
    return true;
  };

  const evidence = (
    values: unknown[],
    prefix: string,
  ): BrowserRecordingValueEvidence[] => values
    .slice(0, 4)
    .flatMap((value, index) => host.collectEvidence(
      value,
      values.length === 1 ? prefix : `${prefix}[${index}]`,
    ))
    .slice(0, 48);

  const emit = (
    spec: MethodSpec,
    context: TraceContext,
    captured: CapturedLibraryInput,
    output: unknown,
    error?: unknown,
  ): void => {
    if (reentrant) return;
    const outputBytes = host.byteLength(output);
    if (
      (captured.byteLength !== undefined && captured.byteLength > MAX_LIBRARY_VALUE_BYTES)
      || (outputBytes !== undefined && outputBytes > MAX_LIBRARY_VALUE_BYTES)
    ) return;
    reentrant = true;
    try {
      host.emit({
        operation: spec.operation,
        label: spec.label,
        transform: {
          adapterId: spec.adapterId,
          providerKind: 'library',
          category: spec.category,
          phase: spec.phase,
        },
        inputs: captured.inputs,
        outputs: error === undefined ? evidence([output], '$output') : [],
        byteLength: captured.byteLength,
        resultByteLength: outputBytes,
        dataType: captured.dataType,
        inputPreview: captured.inputPreview,
        outputPreview: error === undefined ? host.preview(output) : undefined,
        error: error === undefined ? undefined : boundedError(error),
        ...captured.source,
      }, context);
    } catch {
      // Transform evidence is best effort.
    } finally {
      reentrant = false;
    }
  };

  const wrapMethod = (
    owner: Record<string, unknown> | undefined,
    spec: MethodSpec,
  ): void => {
    const original = method(owner, spec.key);
    if (!owner || !original || wrappers.has(original)) return;
    const wrapped = function recordedLibraryTransform(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      if (reentrant) return Reflect.apply(original, this, args);
      const context = admit();
      let captured: CapturedLibraryInput | undefined;
      if (context) {
        reentrant = true;
        try {
          captured = {
            inputs: evidence(args, '$input'),
            byteLength: host.byteLength(args[0]),
            dataType: host.dataType(args[0]),
            inputPreview: host.preview(args[0]),
            source: host.stackInfo(),
          };
        } catch {
          captured = undefined;
        } finally {
          reentrant = false;
        }
      }
      let output: unknown;
      try {
        output = Reflect.apply(original, this, args);
      } catch (error) {
        if (context && captured) emit(spec, context, captured, undefined, error);
        throw error;
      }
      if (!context || !captured) return output;
      if (isPromiseLike(output)) {
        try {
          output.then(
            (resolved) => {
              emit(
                spec,
                context,
                captured,
                resolved,
              );
            },
            (error) => { emit(spec, context, captured, undefined, error); },
          );
        } catch {
          // The original thenable remains authoritative.
        }
      } else {
        emit(
          spec,
          context,
          captured,
          spec.output?.(this, output) ?? output,
        );
      }
      return output;
    };
    replace(owner, spec.key, wrapped);
  };

  const global = scope as unknown as Record<string, unknown>;

  const installMessagePack = (): void => {
    const roots: Array<[Record<string, unknown> | undefined, string]> = [
      [child(global, 'msgpack'), 'messagepack'],
      [child(global, 'MessagePack'), 'messagepack'],
      [child(global, 'msgpackr'), 'msgpackr'],
      [child(global, 'MessagePackr'), 'msgpackr'],
    ];
    for (const [owner, adapterId] of roots) {
      for (const [key, action] of [
        ['encode', 'encode'],
        ['pack', 'encode'],
        ['serialize', 'encode'],
        ['decode', 'decode'],
        ['unpack', 'decode'],
        ['deserialize', 'decode'],
      ] as const) {
        wrapMethod(owner, {
          adapterId,
          category: 'serializer',
          key,
          label: action === 'encode' ? 'MessagePack 序列化' : 'MessagePack 反序列化',
          operation: `${adapterId}.${key}`,
          phase: 'output',
        });
      }
    }
  };

  const installPako = (): void => {
    const owner = child(global, 'pako');
    for (const [key, label] of [
      ['deflate', 'Deflate 压缩'],
      ['deflateRaw', 'Raw Deflate 压缩'],
      ['gzip', 'Gzip 压缩'],
      ['inflate', 'Deflate 解压'],
      ['inflateRaw', 'Raw Deflate 解压'],
      ['ungzip', 'Gzip 解压'],
    ] as const) {
      wrapMethod(owner, {
        adapterId: 'pako',
        category: 'compression',
        key,
        label,
        operation: `pako.${key}`,
        phase: 'output',
      });
    }
    for (const [constructorName, label] of [
      ['Deflate', 'Pako 流式压缩'],
      ['Inflate', 'Pako 流式解压'],
    ] as const) {
      const prototype = child(child(owner, constructorName), 'prototype');
      wrapMethod(prototype, {
        adapterId: 'pako',
        category: 'compression',
        key: 'push',
        label,
        operation: `pako.${constructorName}.push`,
        phase: 'output',
        output: (thisArg, result) => {
          try {
            return record(thisArg)?.result ?? result;
          } catch {
            return result;
          }
        },
      });
    }
  };

  const installCryptoJsCodecs = (): void => {
    const encoders = child(child(global, 'CryptoJS'), 'enc');
    for (const encoding of ['Base64', 'Hex', 'Utf8', 'Latin1', 'Base64url'] as const) {
      const owner = child(encoders, encoding);
      wrapMethod(owner, {
        adapterId: `cryptojs.enc.${encoding.toLowerCase()}`,
        category: 'encoding',
        key: 'parse',
        label: `CryptoJS ${encoding} 解码`,
        operation: `CryptoJS.enc.${encoding}.parse`,
        phase: 'output',
      });
    }
  };

  const installProtobuf = (): void => {
    const protobuf = child(global, 'protobuf');
    const typePrototype = child(child(protobuf, 'Type'), 'prototype');
    const writerPrototype = child(child(protobuf, 'Writer'), 'prototype');
    for (const [key, action] of [
      ['encode', 'encode'],
      ['encodeDelimited', 'encode'],
      ['decode', 'decode'],
      ['decodeDelimited', 'decode'],
    ] as const) {
      wrapMethod(typePrototype, {
        adapterId: 'protobufjs',
        category: 'serializer',
        key,
        label: action === 'encode' ? 'Protobuf 序列化' : 'Protobuf 反序列化',
        operation: `protobufjs.Type.${key}`,
        phase: 'output',
      });
    }
    wrapMethod(writerPrototype, {
      adapterId: 'protobufjs',
      category: 'serializer',
      key: 'finish',
      label: 'Protobuf 输出字节',
      operation: 'protobufjs.Writer.finish',
      phase: 'output',
    });
  };

  const installAxiosInterceptors = (): void => {
    const axios = child(global, 'axios');
    const requestManager = child(child(axios, 'interceptors'), 'request');
    let handlers: unknown[] = [];
    try {
      const value = requestManager?.handlers;
      if (Array.isArray(value)) handlers = value.slice(0, 64);
    } catch {
      handlers = [];
    }
    for (const handler of handlers) {
      wrapMethod(record(handler), {
        adapterId: 'axios.interceptor',
        category: 'request-builder',
        key: 'fulfilled',
        label: 'Axios 请求拦截器',
        operation: 'axios.interceptor.request',
        phase: 'output',
      });
    }
    const originalUse = method(requestManager, 'use');
    if (!requestManager || !originalUse || wrappers.has(originalUse)) return;
    const wrappedUse = function recordedAxiosInterceptorUse(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const output = Reflect.apply(originalUse, this, args);
      installAxiosInterceptors();
      return output;
    };
    replace(requestManager, 'use', wrappedUse);
  };

  const refresh = (): void => {
    if (!active) return;
    installAxiosInterceptors();
    installProtobuf();
    installMessagePack();
    installPako();
    installCryptoJsCodecs();
  };

  const onResourceLoad = (event: Event): void => {
    const target = event.target as { tagName?: unknown } | null;
    if (target?.tagName === 'SCRIPT') refresh();
  };

  return {
    start() {
      if (active) return;
      active = true;
      refresh();
      scope.document.addEventListener('load', onResourceLoad, true);
      for (const delay of RETRY_DELAYS) {
        const timer = scope.setTimeout(() => {
          retryTimers.delete(timer);
          refresh();
        }, delay);
        retryTimers.add(timer);
      }
    },
    stop() {
      if (!active) return;
      active = false;
      scope.document.removeEventListener('load', onResourceLoad, true);
      for (const timer of retryTimers) scope.clearTimeout(timer);
      retryTimers.clear();
      while (restorers.length) {
        try {
          restorers.pop()!();
        } catch {
          // Cleanup remains best effort.
        }
      }
      stagesByTrace.clear();
    },
    refresh,
  };
}
