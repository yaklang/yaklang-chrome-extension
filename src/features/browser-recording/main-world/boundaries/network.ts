import type {
  BrowserRecordingEventKind,
  BrowserRecordingValueEvidence,
} from '@/types/models';

type NetworkKind = Extract<BrowserRecordingEventKind, 'fetch' | 'xhr' | 'form' | 'websocket'>;

export interface NetworkBoundaryEvent {
  kind: NetworkKind;
  operation: string;
  url?: string;
  method?: string;
  statusCode?: number;
  direction?: 'send' | 'receive';
  channelId?: string;
  socketId?: string;
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  inputPreview?: string;
  outputPreview?: string;
  inputs?: BrowserRecordingValueEvidence[];
  outputs?: BrowserRecordingValueEvidence[];
  stack?: string;
  scriptUrl?: string;
  error?: string;
}

export interface NetworkBoundaryTraceContext {
  traceId: string;
  interactionId?: string;
}

export interface NetworkBoundaryHost {
  unique(prefix: string): string;
  byteLength(value: unknown): number | undefined;
  dataType(value: unknown): string;
  asBytes(value: unknown): Uint8Array | undefined;
  preview(value: unknown): string | undefined;
  collectEvidence(value: unknown, path: string): BrowserRecordingValueEvidence[];
  stackInfo(): { stack?: string; scriptUrl?: string };
  context?(): NetworkBoundaryTraceContext | undefined;
  emit(event: NetworkBoundaryEvent, context?: NetworkBoundaryTraceContext): void;
}

export interface NetworkBoundaryRuntime {
  start(): void;
  stop(): void;
}

const MAX_TRACKED_SOCKETS = 64;
const MAX_ASYNC_BINARY_BYTES = 262_144;

interface ResponseCorrelation {
  kind: Extract<NetworkKind, 'fetch' | 'xhr'>;
  channelId: string;
  url: string;
  method: string;
  statusCode?: number;
  headers?: Headers;
  context?: NetworkBoundaryTraceContext;
  emitted: boolean;
  streamOwner?: object;
  streamChunks?: Uint8Array[];
  streamRetainedBytes?: number;
  streamTotalBytes?: number;
}

function bestEffort(operation: () => void): void {
  try { operation(); } catch { /* Network evidence must not change page behavior. */ }
}

export function createNetworkBoundaryRuntime(
  scope: Window,
  host: NetworkBoundaryHost,
): NetworkBoundaryRuntime {
  const restorers: Array<() => void> = [];
  const socketCleanups: Array<() => void> = [];
  let active = false;
  let socketSequence = 0;
  const responseCorrelations = new WeakMap<object, ResponseCorrelation>();
  const streamCorrelations = new WeakMap<object, ResponseCorrelation>();
  const readerCorrelations = new WeakMap<object, ResponseCorrelation>();

  const requestConstructor = (): typeof Request | undefined => (
    (scope as unknown as { Request?: typeof Request }).Request
  );

  const headerEvidence = (input: HeadersInit | undefined, path: string): BrowserRecordingValueEvidence[] => {
    if (!input) return [];
    const HeadersConstructor = (scope as unknown as { Headers?: typeof Headers }).Headers;
    if (typeof HeadersConstructor !== 'function') return [];
    const output: BrowserRecordingValueEvidence[] = [];
    try {
      for (const [name, value] of new HeadersConstructor(input)) {
        output.push(...host.collectEvidence(value, `${path}.${name.toLowerCase()}`));
      }
    } catch {
      // Invalid headers remain owned by the page API.
    }
    return output;
  };

  const emitResponse = (
    correlation: ResponseCorrelation,
    body?: unknown,
    error?: unknown,
    options: {
      final?: boolean;
      operation?: 'response' | 'response.chunk';
      actualByteLength?: number;
      includeHeaders?: boolean;
    } = {},
  ): void => {
    if (!active) return;
    const final = options.final !== false;
    if (final && correlation.emitted) return;
    if (final) correlation.emitted = true;
    const bodyEvidence = host.collectEvidence(body, '$body').map((item) => (
      options.actualByteLength !== undefined && item.path === '$body'
        ? { ...item, byteLength: options.actualByteLength }
        : item
    ));
    host.emit({
      kind: correlation.kind,
      operation: options.operation || 'response',
      direction: 'receive',
      channelId: correlation.channelId,
      url: correlation.url,
      method: correlation.method,
      statusCode: correlation.statusCode,
      resultByteLength: options.actualByteLength ?? host.byteLength(body),
      dataType: host.dataType(body),
      outputPreview: host.preview(body),
      outputs: [
        ...bodyEvidence,
        ...(options.includeHeaders === false ? [] : headerEvidence(correlation.headers, '$headers')),
      ],
      error: error === undefined ? undefined : String(error).slice(0, 512),
    }, correlation.context);
  };

  const emitResponseBody = (
    correlation: ResponseCorrelation,
    body?: unknown,
    error?: unknown,
  ): void => {
    const BlobConstructor = (scope as unknown as { Blob?: typeof Blob }).Blob;
    if (typeof BlobConstructor === 'function' && body instanceof BlobConstructor && typeof body.arrayBuffer === 'function') {
      const actualByteLength = body.size;
      void body.slice(0, MAX_ASYNC_BINARY_BYTES).arrayBuffer().then(
        (bytes) => emitResponse(correlation, bytes, error, { actualByteLength }),
        () => emitResponse(correlation, body, error, { actualByteLength }),
      );
      return;
    }
    emitResponse(correlation, body, error);
  };

  const mapResponseStream = (response: Response, correlation: ResponseCorrelation): void => {
    try {
      if (response.body) streamCorrelations.set(response.body, correlation);
    } catch {
      // Opaque or already disturbed responses may not expose a readable body.
    }
  };

  const recordStreamResult = (
    correlation: ResponseCorrelation,
    result: { done?: unknown; value?: unknown },
  ): void => {
    if (result.done === true) {
      const retainedBytes = correlation.streamRetainedBytes || 0;
      const aggregate = new Uint8Array(retainedBytes);
      let offset = 0;
      for (const chunk of correlation.streamChunks || []) {
        aggregate.set(chunk, offset);
        offset += chunk.byteLength;
      }
      emitResponse(correlation, aggregate, undefined, {
        actualByteLength: correlation.streamTotalBytes || 0,
      });
      return;
    }
    const value = result.value;
    let bytes = host.asBytes(value);
    if (!bytes && typeof value === 'string') bytes = new TextEncoder().encode(value);
    const chunkBytes = bytes?.byteLength ?? host.byteLength(value) ?? 0;
    correlation.streamTotalBytes = (correlation.streamTotalBytes || 0) + chunkBytes;
    if (bytes && (correlation.streamRetainedBytes || 0) < MAX_ASYNC_BINARY_BYTES) {
      const available = MAX_ASYNC_BINARY_BYTES - (correlation.streamRetainedBytes || 0);
      const retained = bytes.subarray(0, available).slice();
      correlation.streamChunks = [...(correlation.streamChunks || []), retained];
      correlation.streamRetainedBytes = (correlation.streamRetainedBytes || 0) + retained.byteLength;
    }
    emitResponse(correlation, value, undefined, {
      final: false,
      operation: 'response.chunk',
      actualByteLength: chunkBytes,
      includeHeaders: false,
    });
  };

  const patchReadableStreams = (): void => {
    const Stream = (scope as unknown as { ReadableStream?: typeof ReadableStream }).ReadableStream;
    if (typeof Stream !== 'function') return;
    const originalGetReader = Stream.prototype.getReader;
    const wrappedGetReader = function recordedGetReader(
      this: ReadableStream,
      options?: ReadableStreamGetReaderOptions,
    ): ReadableStreamReader<unknown> {
      const reader = Reflect.apply(originalGetReader, this, options === undefined ? [] : [options]) as ReadableStreamReader<unknown>;
      const correlation = streamCorrelations.get(this);
      if (correlation && !correlation.streamOwner) {
        correlation.streamOwner = reader;
        readerCorrelations.set(reader, correlation);
      }
      return reader;
    } as typeof Stream.prototype.getReader;
    Stream.prototype.getReader = wrappedGetReader;
    restorers.push(() => {
      if (Stream.prototype.getReader === wrappedGetReader) Stream.prototype.getReader = originalGetReader;
    });

    for (const name of ['ReadableStreamDefaultReader', 'ReadableStreamBYOBReader'] as const) {
      const Constructor = (scope as unknown as Record<string, unknown>)[name] as {
        prototype?: { read?: (...args: unknown[]) => Promise<{ done?: unknown; value?: unknown }> };
      } | undefined;
      const prototype = Constructor?.prototype;
      const original = prototype?.read;
      if (!prototype || typeof original !== 'function') continue;
      const wrapped = function recordedStreamRead(this: object, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        const correlation = readerCorrelations.get(this);
        if (correlation && result && typeof result.then === 'function') {
          void result.then(
            (item) => bestEffort(() => recordStreamResult(correlation, item)),
            (error) => bestEffort(() => emitResponse(correlation, undefined, error)),
          );
        }
        return result;
      };
      prototype.read = wrapped;
      restorers.push(() => {
        if (prototype.read === wrapped) prototype.read = original;
      });
    }
  };

  const patchResponseReaders = (): void => {
    const Constructor = (scope as unknown as { Response?: typeof Response }).Response;
    if (typeof Constructor !== 'function') return;
    const prototype = Constructor.prototype;
    const originalClone = prototype.clone;
    const wrappedClone = function recordedResponseClone(this: Response): Response {
      const cloned = Reflect.apply(originalClone, this, []) as Response;
      const correlation = responseCorrelations.get(this);
      if (correlation) {
        responseCorrelations.set(cloned, correlation);
        mapResponseStream(cloned, correlation);
      }
      return cloned;
    };
    prototype.clone = wrappedClone;
    restorers.push(() => {
      if (prototype.clone === wrappedClone) prototype.clone = originalClone;
    });

    for (const method of ['arrayBuffer', 'blob', 'formData', 'json', 'text'] as const) {
      const original = prototype[method] as (this: Response) => Promise<unknown>;
      if (typeof original !== 'function') continue;
      const wrapped = function recordedResponseReader(this: Response): Promise<unknown> {
        const result = Reflect.apply(original, this, []) as Promise<unknown>;
        const correlation = responseCorrelations.get(this);
        if (correlation && result && typeof result.then === 'function') {
          void result.then(
            (body) => emitResponseBody(correlation, body),
            (error) => emitResponse(correlation, undefined, error),
          );
        }
        return result;
      };
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value: wrapped,
      });
      restorers.push(() => {
        if (prototype[method] === wrapped) {
          Object.defineProperty(prototype, method, {
            configurable: true,
            writable: true,
            value: original,
          });
        }
      });
    }
  };

  const requestValue = (input: string | URL | Request): string => {
    const RequestConstructor = requestConstructor();
    return RequestConstructor && input instanceof RequestConstructor ? input.url : String(input);
  };

  const queryEvidence = (input: string | URL | Request): BrowserRecordingValueEvidence[] => {
    const output: BrowserRecordingValueEvidence[] = [];
    try {
      const url = new URL(requestValue(input), scope.location?.href);
      for (const [key, item] of url.searchParams) {
        output.push(...host.collectEvidence(item, `$query.${key}`));
      }
    } catch {
      // The page owns URL validation.
    }
    return output;
  };

  const absoluteRequestUrl = (input: string | URL | Request): string => {
    try {
      return new URL(requestValue(input), scope.location?.href).toString().slice(0, 8_192);
    } catch {
      return requestValue(input).slice(0, 8_192);
    }
  };

  const patchFetch = (): void => {
    const original = scope.fetch;
    if (typeof original !== 'function') return;
    const RequestConstructor = requestConstructor();
    const wrapped: typeof scope.fetch = function recordedFetch(this: Window, input, init) {
      const context = host.context?.();
      const channelId = host.unique('fetch');
      const request = RequestConstructor && input instanceof RequestConstructor ? input : undefined;
      const url = absoluteRequestUrl(request || input);
      const method = (init?.method || request?.method || 'GET').toUpperCase().slice(0, 32);
      bestEffort(() => {
        const body = init?.body;
        host.emit({
          kind: 'fetch',
          operation: 'request',
          direction: 'send',
          channelId,
          url,
          method,
          byteLength: host.byteLength(body),
          dataType: host.dataType(body),
          inputPreview: host.preview(body),
          inputs: [
            ...host.collectEvidence(body, '$body'),
            ...headerEvidence(init?.headers || request?.headers, '$headers'),
            ...queryEvidence(request || input),
          ],
          ...host.stackInfo(),
        }, context);
      });
      let result: ReturnType<typeof scope.fetch>;
      try {
        result = Reflect.apply(original, this, [input, init]);
      } catch (error) {
        bestEffort(() => emitResponse({ kind: 'fetch', channelId, url, method, context, emitted: false }, undefined, error));
        throw error;
      }
      void result.then((response) => {
        bestEffort(() => {
          const correlation: ResponseCorrelation = {
            kind: 'fetch',
            channelId,
            url: response.url || url,
            method,
            statusCode: response.status,
            headers: response.headers,
            context,
            emitted: false,
          };
          responseCorrelations.set(response, correlation);
          mapResponseStream(response, correlation);
          if (response.body === null) emitResponse(correlation);
        });
      }, (error) => bestEffort(() => emitResponse(
        { kind: 'fetch', channelId, url, method, context, emitted: false },
        undefined,
        error,
      )));
      return result;
    };
    scope.fetch = wrapped;
    restorers.push(() => {
      if (scope.fetch === wrapped) scope.fetch = original;
    });
  };

  const patchXhr = (): void => {
    const Constructor = (scope as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    if (typeof Constructor !== 'function') return;
    const states = new WeakMap<XMLHttpRequest, {
      method: string;
      url: string;
      headers: Record<string, string>;
      channelId?: string;
      context?: NetworkBoundaryTraceContext;
    }>();
    const prototype = Constructor.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetHeader = prototype.setRequestHeader;
    const wrappedOpen = function recordedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      bestEffort(() => states.set(this, {
        method: String(method).toUpperCase().slice(0, 32),
        url: absoluteRequestUrl(url),
        headers: {},
      }));
      return Reflect.apply(originalOpen, this, [method, url, ...rest] as Parameters<XMLHttpRequest['open']>);
    } as typeof prototype.open;
    const wrappedSetHeader = function recordedSetRequestHeader(
      this: XMLHttpRequest,
      name: string,
      value: string,
    ) {
      bestEffort(() => {
        const state = states.get(this);
        if (state) state.headers[name.toLowerCase()] = value;
      });
      return Reflect.apply(originalSetHeader, this, [name, value]);
    };
    const wrappedSend = function recordedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const context = host.context?.();
      const channelId = host.unique('xhr');
      bestEffort(() => {
        const state = states.get(this);
        if (state) Object.assign(state, { channelId, context });
        host.emit({
          kind: 'xhr',
          operation: 'request',
          direction: 'send',
          channelId,
          url: state?.url,
          method: state?.method,
          byteLength: host.byteLength(body),
          dataType: host.dataType(body),
          inputPreview: host.preview(body),
          inputs: [
            ...host.collectEvidence(body, '$body'),
            ...host.collectEvidence(state?.headers, '$headers'),
            ...(state?.url ? queryEvidence(state.url) : []),
          ],
          ...host.stackInfo(),
        }, context);
        if (typeof this.addEventListener === 'function') {
          const onLoadEnd = () => bestEffort(() => {
            this.removeEventListener('loadend', onLoadEnd);
            const current = states.get(this);
            let body: unknown;
            try {
              body = !this.responseType || this.responseType === 'text' ? this.responseText : this.response;
            } catch {
              body = this.response;
            }
            let headers: Headers | undefined;
            try {
              const rawHeaders = this.getAllResponseHeaders();
              if (rawHeaders) {
                headers = new Headers();
                for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
                  const separator = line.indexOf(':');
                  if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
                }
              }
            } catch {
              // Response headers may be unavailable for failed or cross-origin requests.
            }
            emitResponseBody({
              kind: 'xhr',
              channelId: current?.channelId || channelId,
              url: this.responseURL || current?.url || '',
              method: current?.method || 'GET',
              statusCode: this.status,
              headers,
              context: current?.context || context,
              emitted: false,
            }, body, this.status === 0 ? 'network request failed or was blocked' : undefined);
          });
          this.addEventListener('loadend', onLoadEnd);
        }
      });
      return Reflect.apply(originalSend, this, [body]);
    };
    prototype.open = wrappedOpen;
    prototype.setRequestHeader = wrappedSetHeader;
    prototype.send = wrappedSend;
    restorers.push(() => {
      if (prototype.open === wrappedOpen) prototype.open = originalOpen;
      if (prototype.setRequestHeader === wrappedSetHeader) prototype.setRequestHeader = originalSetHeader;
      if (prototype.send === wrappedSend) prototype.send = originalSend;
    });
  };

  const patchForms = (): void => {
    const FormConstructor = (scope as unknown as { HTMLFormElement?: typeof HTMLFormElement }).HTMLFormElement;
    const FormDataConstructor = (scope as unknown as { FormData?: typeof FormData }).FormData;
    if (typeof FormConstructor !== 'function') return;
    const onSubmit = (event: Event) => {
      const form = event.target instanceof FormConstructor ? event.target : undefined;
      if (!form) return;
      bestEffort(() => {
        let body: FormData | undefined;
        try {
          if (typeof FormDataConstructor === 'function') body = new FormDataConstructor(form);
        } catch {
          // Ignore custom forms that cannot be serialized.
        }
        host.emit({
          kind: 'form',
          operation: 'request',
          url: form.action.slice(0, 8_192),
          method: form.method.toUpperCase().slice(0, 32),
          byteLength: host.byteLength(body),
          dataType: 'FormData',
          inputPreview: host.preview(body),
          inputs: [
            ...host.collectEvidence(body, '$body'),
            ...queryEvidence(form.action),
          ],
          ...host.stackInfo(),
        });
      });
    };
    scope.document.addEventListener('submit', onSubmit, false);
    restorers.push(() => scope.document.removeEventListener('submit', onSubmit, false));
  };

  const trackSocket = (cleanup: () => void): void => {
    socketCleanups.push(cleanup);
    while (socketCleanups.length > MAX_TRACKED_SOCKETS) bestEffort(socketCleanups.shift()!);
  };

  const patchWebSocket = (): void => {
    const owner = scope as unknown as { WebSocket?: typeof WebSocket };
    const Original = owner.WebSocket;
    if (typeof Original !== 'function') return;
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        bestEffort(() => {
          const socketId = host.unique(`socket-${++socketSequence}`);
          const socketUrl = String(args[0] || '').slice(0, 8_192);
          host.emit({
            kind: 'websocket',
            operation: 'construct',
            url: socketUrl,
            socketId,
            ...host.stackInfo(),
          });
          const originalSend = socket.send;
          let cleaned = false;
          let lastContext: NetworkBoundaryTraceContext | undefined;
          const emitFrame = (
            direction: 'send' | 'receive',
            data: unknown,
            context?: NetworkBoundaryTraceContext,
            source: { stack?: string; scriptUrl?: string } = {},
          ): void => {
            const BlobConstructor = (scope as unknown as { Blob?: typeof Blob }).Blob;
            const emitValue = (value: unknown, actualByteLength?: number, error?: unknown) => {
              if (cleaned || !active) return;
              const evidence = host.collectEvidence(value, '$frame').map((item) => (
                actualByteLength !== undefined && item.path === '$frame'
                  ? { ...item, byteLength: actualByteLength }
                  : item
              ));
              host.emit({
                kind: 'websocket',
                operation: 'frame',
                direction,
                url: socketUrl,
                socketId,
                channelId: socketId,
                ...(direction === 'send'
                  ? { byteLength: actualByteLength ?? host.byteLength(value), inputPreview: host.preview(value), inputs: evidence }
                  : { resultByteLength: actualByteLength ?? host.byteLength(value), outputPreview: host.preview(value), outputs: evidence }),
                dataType: host.dataType(data),
                error: error === undefined ? undefined : String(error).slice(0, 512),
                ...source,
              }, context);
            };
            if (typeof BlobConstructor === 'function' && data instanceof BlobConstructor && typeof data.arrayBuffer === 'function') {
              const actualByteLength = data.size;
              void data.slice(0, MAX_ASYNC_BINARY_BYTES).arrayBuffer().then(
                (bytes) => emitValue(bytes, actualByteLength),
                (error) => emitValue(data, actualByteLength, error),
              );
            } else {
              emitValue(data);
            }
          };
          const wrappedSend = function recordedSend(
            this: WebSocket,
            data: string | ArrayBufferLike | Blob | ArrayBufferView,
          ) {
            const context = host.context?.();
            lastContext = context;
            bestEffort(() => emitFrame('send', data, context, host.stackInfo()));
            return Reflect.apply(originalSend, this, [data]);
          };
          const onMessage = (event: MessageEvent) => bestEffort(() => emitFrame(
            'receive',
            event.data,
            lastContext,
          ));
          const onOpen = () => bestEffort(() => host.emit({
            kind: 'websocket',
            operation: 'open',
            url: socketUrl,
            socketId,
          }));
          const onClose = (event: CloseEvent) => bestEffort(() => host.emit({
            kind: 'websocket',
            operation: 'close',
            url: socketUrl,
            socketId,
            error: event.wasClean ? undefined : `code=${event.code}`,
          }));
          socket.send = wrappedSend;
          socket.addEventListener('message', onMessage);
          socket.addEventListener('open', onOpen);
          socket.addEventListener('close', onClose);
          trackSocket(() => {
            if (cleaned) return;
            cleaned = true;
            if (socket.send === wrappedSend) socket.send = originalSend;
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('close', onClose);
          });
        });
        return socket;
      },
    });
    owner.WebSocket = Wrapped;
    restorers.push(() => {
      if (owner.WebSocket === Wrapped) owner.WebSocket = Original;
    });
  };

  return {
    start() {
      if (active) return;
      active = true;
      for (const patch of [patchReadableStreams, patchResponseReaders, patchFetch, patchXhr, patchForms, patchWebSocket]) bestEffort(patch);
    },
    stop() {
      if (!active) return;
      active = false;
      while (socketCleanups.length) bestEffort(socketCleanups.pop()!);
      while (restorers.length) bestEffort(restorers.pop()!);
      socketSequence = 0;
    },
  };
}
