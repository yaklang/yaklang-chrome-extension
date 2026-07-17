type ObservationKind = 'fetch' | 'xhr' | 'form' | 'websocket' | 'webcrypto' | 'cryptojs';

interface ObserverOptions {
  captureValues: boolean;
  maxEntries: number;
  maxValueBytes: number;
  expiresAt?: number;
}

interface ObserverRecord {
  id: string;
  sequence: number;
  timestamp: number;
  kind: ObservationKind;
  operation: string;
  url?: string;
  method?: string;
  algorithm?: string;
  direction?: 'send' | 'receive';
  socketId?: string;
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  stack?: string;
  scriptUrl?: string;
  sensitiveCaptured: boolean;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}

interface ObserverSnapshot {
  version: 2;
  active: boolean;
  startedAt?: number;
  count: number;
  droppedCount: number;
  options?: ObserverOptions;
  records: ObserverRecord[];
}

interface ObserverController {
  version: 2;
  command(command: 'start' | 'status' | 'list' | 'clear' | 'stop', input?: Partial<ObserverOptions> & { limit?: number }): ObserverSnapshot;
}

interface LegacyObserverController {
  version?: unknown;
  command?: (command: 'stop', input?: Record<string, never>) => unknown;
}

type ObserverRecordInput = Omit<ObserverRecord, 'id' | 'sequence' | 'timestamp' | 'sensitiveCaptured'>;

export default defineUnlistedScript(() => {
  const REGISTRY_KEY = '__YAKIT_PAGE_OBSERVER_V2__';
  const LEGACY_REGISTRY_KEY = '__YAKIT_PAGE_OBSERVER_V1__';
  const registry = window as unknown as Record<string, unknown>;
  const existing = registry[REGISTRY_KEY] as ObserverController | undefined;
  if (existing?.version === 2) return;
  const legacy = registry[LEGACY_REGISTRY_KEY] as LegacyObserverController | undefined;
  try {
    if (legacy?.version === 1 && typeof legacy.command === 'function') legacy.command('stop');
  } catch {
    // A stale observer must not block the current controller from installing.
  }

  const encoder = new TextEncoder();
  const restorers: Array<() => void> = [];
  let cryptoJsTimer: number | undefined;
  let expiryTimer: number | undefined;
  let active = false;
  let startedAt: number | undefined;
  let observationSession = 0;
  let sequence = 0;
  let socketSequence = 0;
  let droppedCount = 0;
  let records: ObserverRecord[] = [];
  let options: ObserverOptions = { captureValues: false, maxEntries: 100, maxValueBytes: 2_048 };

  function dataType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return typeof value;
    return Object.prototype.toString.call(value).slice(8, -1);
  }

  function byteLength(value: unknown): number | undefined {
    try {
      if (typeof value === 'string') return encoder.encode(value).byteLength;
      if (value instanceof Blob) return value.size;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof URLSearchParams) return encoder.encode(value.toString()).byteLength;
      if (typeof FormData !== 'undefined' && value instanceof FormData) {
        let total = 0;
        for (const [key, item] of value.entries()) total += encoder.encode(key).byteLength + (typeof item === 'string' ? encoder.encode(item).byteLength : item.size);
        return total;
      }
      if (value && typeof value === 'object' && typeof (value as { sigBytes?: unknown }).sigBytes === 'number') {
        return Math.max(0, (value as { sigBytes: number }).sigBytes);
      }
      if (value !== undefined) return encoder.encode(JSON.stringify(value)).byteLength;
    } catch {
      return undefined;
    }
    return undefined;
  }

  function preview(value: unknown): string | undefined {
    if (!options.captureValues || value === undefined) return undefined;
    try {
      let output: string;
      if (typeof value === 'string') output = value;
      else if (value instanceof URLSearchParams) output = value.toString();
      else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob) output = `[binary ${byteLength(value) || 0} bytes]`;
      else if (typeof FormData !== 'undefined' && value instanceof FormData) {
        output = JSON.stringify([...value.entries()].map(([key, item]) => [key, typeof item === 'string' ? item : `[file ${item.size} bytes]`]));
      } else if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
        const cryptoText = (value as { toString(): string }).toString();
        output = cryptoText === '[object Object]' ? JSON.stringify(value) : cryptoText;
      } else output = String(value);
      const bytes = encoder.encode(output);
      if (bytes.byteLength <= options.maxValueBytes) return output;
      return new TextDecoder().decode(bytes.slice(0, options.maxValueBytes));
    } catch {
      return `[${dataType(value)}]`;
    }
  }

  function stackInfo(): { stack?: string; scriptUrl?: string } {
    try {
      const stack = new Error().stack?.split('\n').slice(2, 10).join('\n').slice(0, 4_096);
      const scriptUrl = stack?.match(/https?:\/\/[^\s)]+/)?.[0]?.slice(0, 2_048);
      return { stack, scriptUrl };
    } catch {
      return {};
    }
  }

  function record(input: ObserverRecordInput): ObserverRecord | undefined {
    if (!active) return undefined;
    const nextSequence = sequence + 1;
    const item: ObserverRecord = {
      id: `observation-${startedAt || Date.now()}-${observationSession}-${nextSequence}`,
      sequence: nextSequence,
      timestamp: Date.now(),
      sensitiveCaptured: options.captureValues,
      ...input,
    };
    sequence = nextSequence;
    records.push(item);
    while (records.length > options.maxEntries) {
      records.shift();
      droppedCount += 1;
    }
    return item;
  }

  function observe(factory: () => ObserverRecordInput): ObserverRecord | undefined {
    if (!active) return undefined;
    try {
      return record(factory());
    } catch {
      droppedCount += 1;
      return undefined;
    }
  }

  function bestEffort(operation: () => void): void {
    try {
      operation();
    } catch {
      // Observation is diagnostic and must never change the target page's behavior.
    }
  }

  function errorMessage(error: unknown): string {
    try {
      return (error instanceof Error ? error.message : String(error)).slice(0, 512);
    } catch {
      return 'Unknown error';
    }
  }

  function algorithmSummary(value: unknown): string | undefined {
    if (typeof value === 'string') return value.slice(0, 160);
    if (!value || typeof value !== 'object') return undefined;
    const algorithm = value as Record<string, unknown>;
    const name = typeof algorithm.name === 'string' ? algorithm.name : 'unknown';
    const parts = [name];
    if (typeof algorithm.namedCurve === 'string') parts.push(`curve=${algorithm.namedCurve}`);
    if (typeof algorithm.length === 'number') parts.push(`length=${algorithm.length}`);
    if (typeof algorithm.tagLength === 'number') parts.push(`tag=${algorithm.tagLength}`);
    const hash = algorithm.hash;
    if (typeof hash === 'string') parts.push(`hash=${hash}`);
    else if (hash && typeof hash === 'object' && typeof (hash as { name?: unknown }).name === 'string') parts.push(`hash=${(hash as { name: string }).name}`);
    if (algorithm.iv !== undefined) parts.push(`ivBytes=${byteLength(algorithm.iv) || 0}`);
    if (algorithm.salt !== undefined) parts.push(`saltBytes=${byteLength(algorithm.salt) || 0}`);
    return parts.join(' ').slice(0, 240);
  }

  function patchFetch(): void {
    const original = window.fetch;
    if (typeof original !== 'function') return;
    const wrapped: typeof window.fetch = function observedFetch(this: Window, input, init) {
      observe(() => {
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
        const url = request?.url || String(input);
        const method = init?.method || request?.method || 'GET';
        const body = init?.body;
        return { kind: 'fetch', operation: 'fetch', url: url.slice(0, 8_192), method: method.toUpperCase().slice(0, 32), byteLength: byteLength(body), dataType: dataType(body), inputPreview: preview(body), ...stackInfo() };
      });
      return Reflect.apply(original, this, [input, init]);
    };
    window.fetch = wrapped;
    restorers.push(() => { if (window.fetch === wrapped) window.fetch = original; });
  }

  function patchXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    const states = new WeakMap<XMLHttpRequest, { method: string; url: string; headerCount: number }>();
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetHeader = prototype.setRequestHeader;
    const wrappedOpen = function observedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      bestEffort(() => {
        states.set(this, { method: String(method).toUpperCase().slice(0, 32), url: String(url).slice(0, 8_192), headerCount: 0 });
      });
      return Reflect.apply(originalOpen, this, [method, url, ...rest] as Parameters<XMLHttpRequest['open']>);
    } as typeof prototype.open;
    const wrappedSetHeader = function observedSetRequestHeader(this: XMLHttpRequest, name: string, value: string) {
      bestEffort(() => {
        const state = states.get(this);
        if (state) state.headerCount += 1;
      });
      return Reflect.apply(originalSetHeader, this, [name, value]);
    };
    const wrappedSend = function observedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      observe(() => {
        const state = states.get(this);
        return { kind: 'xhr', operation: 'send', url: state?.url, method: state?.method, byteLength: byteLength(body), dataType: dataType(body), inputPreview: preview(body), ...stackInfo() };
      });
      return Reflect.apply(originalSend, this, [body]);
    };
    const restore = () => {
      if (prototype.open === wrappedOpen) prototype.open = originalOpen;
      if (prototype.setRequestHeader === wrappedSetHeader) prototype.setRequestHeader = originalSetHeader;
      if (prototype.send === wrappedSend) prototype.send = originalSend;
    };
    try {
      prototype.open = wrappedOpen;
      prototype.setRequestHeader = wrappedSetHeader;
      prototype.send = wrappedSend;
    } catch (error) {
      bestEffort(restore);
      throw error;
    }
    restorers.push(restore);
  }

  function patchForms(): void {
    const onSubmit = (event: Event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : undefined;
      if (!form) return;
      observe(() => {
        let body: FormData | undefined;
        try { body = new FormData(form); } catch { /* Some custom forms cannot be serialized. */ }
        return {
          kind: 'form', operation: 'submit', url: form.action.slice(0, 8_192), method: form.method.toUpperCase().slice(0, 32),
          byteLength: byteLength(body), dataType: 'FormData', inputPreview: preview(body), ...stackInfo(),
        };
      });
    };
    document.addEventListener('submit', onSubmit, true);
    restorers.push(() => document.removeEventListener('submit', onSubmit, true));
  }

  function patchWebSocket(): void {
    const Original = window.WebSocket;
    if (typeof Original !== 'function') return;
    const Wrapped = new Proxy(Original, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        bestEffort(() => {
          const socketId = `socket-${startedAt || Date.now()}-${observationSession}-${++socketSequence}`;
          const socketUrl = String(args[0] || '').slice(0, 8_192);
          observe(() => ({ kind: 'websocket', operation: 'construct', url: socketUrl, socketId, ...stackInfo() }));
          const originalSend = socket.send;
          const wrappedSend = function observedSend(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            observe(() => ({ kind: 'websocket', operation: 'frame', direction: 'send', url: socketUrl, socketId, byteLength: byteLength(data), dataType: dataType(data), inputPreview: preview(data), ...stackInfo() }));
            return Reflect.apply(originalSend, this, [data]);
          };
          const onOpen = () => observe(() => ({ kind: 'websocket', operation: 'open', url: socketUrl, socketId }));
          const onMessage = (event: MessageEvent) => observe(() => ({ kind: 'websocket', operation: 'frame', direction: 'receive', url: socketUrl, socketId, byteLength: byteLength(event.data), dataType: dataType(event.data), outputPreview: preview(event.data) }));
          const onClose = (event: CloseEvent) => observe(() => ({ kind: 'websocket', operation: 'close', url: socketUrl, socketId, error: event.wasClean ? undefined : `code=${event.code}` }));
          const onError = () => observe(() => ({ kind: 'websocket', operation: 'error', url: socketUrl, socketId, error: 'WebSocket error' }));
          restorers.push(() => {
            if (socket.send === wrappedSend) socket.send = originalSend;
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('close', onClose);
            socket.removeEventListener('error', onError);
          });
          socket.send = wrappedSend;
          socket.addEventListener('open', onOpen);
          socket.addEventListener('message', onMessage);
          socket.addEventListener('close', onClose);
          socket.addEventListener('error', onError);
        });
        return socket;
      },
    });
    window.WebSocket = Wrapped;
    restorers.push(() => { if (window.WebSocket === Wrapped) window.WebSocket = Original; });
  }

  function patchWebCrypto(): void {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return;
    const prototype = Object.getPrototypeOf(subtle) as Record<string, unknown>;
    const operations = ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'deriveBits', 'deriveKey', 'generateKey', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey'] as const;
    for (const operation of operations) {
      const original = prototype[operation];
      if (typeof original !== 'function') continue;
      const wrapped = function observedWebCrypto(this: SubtleCrypto, ...args: unknown[]) {
        const item = observe(() => {
          const input = args.find((value, index) => index > 0 && (typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)));
          return { kind: 'webcrypto', operation, algorithm: algorithmSummary(args[0]), byteLength: byteLength(input), dataType: dataType(input), inputPreview: preview(input), ...stackInfo() };
        });
        try {
          const result = Reflect.apply(original, this, args) as Promise<unknown>;
          void result.then((output) => {
            if (item) {
              item.resultByteLength = byteLength(output);
              item.outputPreview = preview(output);
            }
          }, (error) => { if (item) item.error = errorMessage(error); });
          return result;
        } catch (error) {
          if (item) item.error = errorMessage(error);
          throw error;
        }
      };
      prototype[operation] = wrapped;
      restorers.push(() => { if (prototype[operation] === wrapped) prototype[operation] = original; });
    }
  }

  const cryptoJsRestorers: Array<() => void> = [];
  const cryptoJsWrappers = new WeakSet<Function>();
  function patchCryptoJs(): void {
    const cryptoJs = (window as unknown as { CryptoJS?: Record<string, unknown> }).CryptoJS;
    if (!cryptoJs) return;
    const paths = [
      'AES.encrypt', 'AES.decrypt', 'DES.encrypt', 'DES.decrypt', 'TripleDES.encrypt', 'TripleDES.decrypt',
      'RC4.encrypt', 'RC4.decrypt', 'Rabbit.encrypt', 'Rabbit.decrypt', 'MD5', 'SHA1', 'SHA224', 'SHA256',
      'SHA384', 'SHA512', 'SHA3', 'RIPEMD160', 'HmacMD5', 'HmacSHA1', 'HmacSHA224', 'HmacSHA256',
      'HmacSHA384', 'HmacSHA512', 'PBKDF2', 'EvpKDF',
    ];
    for (const path of paths) {
      const segments = path.split('.');
      let owner: Record<string, unknown> = cryptoJs;
      for (const segment of segments.slice(0, -1)) {
        const next = owner[segment];
        if (!next || typeof next !== 'object') { owner = {}; break; }
        owner = next as Record<string, unknown>;
      }
      const key = segments.at(-1)!;
      const original = owner[key];
      if (typeof original !== 'function' || cryptoJsWrappers.has(original)) continue;
      const wrapped = function observedCryptoJs(this: unknown, ...args: unknown[]) {
        const item = observe(() => ({ kind: 'cryptojs', operation: path, algorithm: path.split('.')[0], byteLength: byteLength(args[0]), dataType: dataType(args[0]), inputPreview: preview(args[0]), ...stackInfo() }));
        try {
          const output = Reflect.apply(original, this, args);
          if (item) {
            item.resultByteLength = byteLength(output);
            item.outputPreview = preview(output);
          }
          return output;
        } catch (error) {
          if (item) item.error = errorMessage(error);
          throw error;
        }
      };
      owner[key] = wrapped;
      cryptoJsWrappers.add(wrapped);
      const restore = () => { if (owner[key] === wrapped) owner[key] = original; };
      cryptoJsRestorers.push(restore);
    }
  }

  function stop(): void {
    active = false;
    if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    if (cryptoJsTimer !== undefined) window.clearInterval(cryptoJsTimer);
    expiryTimer = undefined;
    cryptoJsTimer = undefined;
    while (cryptoJsRestorers.length) {
      const restore = cryptoJsRestorers.pop();
      if (restore) bestEffort(restore);
    }
    while (restorers.length) {
      const restore = restorers.pop();
      if (restore) bestEffort(restore);
    }
  }

  function snapshot(limit = options.maxEntries): ObserverSnapshot {
    return {
      version: 2,
      active,
      startedAt,
      count: records.length,
      droppedCount,
      options: startedAt ? { ...options } : undefined,
      records: records.slice(-Math.max(0, Math.min(limit, options.maxEntries))),
    };
  }

  const controller: ObserverController = {
    version: 2,
    command(command, input = {}) {
      if (command === 'start') {
        stop();
        options = {
          captureValues: input.captureValues === true,
          maxEntries: Math.max(10, Math.min(Number(input.maxEntries) || 100, 200)),
          maxValueBytes: Math.max(256, Math.min(Number(input.maxValueBytes) || 2_048, 8_192)),
          expiresAt: typeof input.expiresAt === 'number' ? input.expiresAt : undefined,
        };
        records = [];
        droppedCount = 0;
        sequence = 0;
        socketSequence = 0;
        observationSession += 1;
        startedAt = Date.now();
        active = true;
        for (const patch of [patchFetch, patchXhr, patchForms, patchWebSocket, patchWebCrypto, patchCryptoJs]) {
          bestEffort(patch);
        }
        cryptoJsTimer = window.setInterval(() => bestEffort(patchCryptoJs), 1_000);
        if (options.expiresAt) expiryTimer = window.setTimeout(stop, Math.max(0, options.expiresAt - Date.now()));
      } else if (command === 'clear') {
        records = [];
        droppedCount = 0;
      } else if (command === 'stop') stop();
      return snapshot(typeof input.limit === 'number' ? input.limit : options.maxEntries);
    },
  };

  Object.defineProperty(registry, REGISTRY_KEY, { value: controller, configurable: true, enumerable: false, writable: false });
});
