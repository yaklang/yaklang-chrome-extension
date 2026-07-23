import type { BrowserRecordingEventKind, BrowserRecordingValueEvidence } from '@/types/models';

type CommunicationKind = Extract<BrowserRecordingEventKind, 'beacon' | 'worker' | 'message'>;

export interface CommunicationBoundaryEvent {
  kind: CommunicationKind;
  operation: string;
  url?: string;
  method?: string;
  direction?: 'send' | 'receive';
  channelId?: string;
  wrapperHandleId?: string;
  byteLength?: number;
  dataType?: string;
  inputPreview?: string;
  outputPreview?: string;
  inputs?: BrowserRecordingValueEvidence[];
  outputs?: BrowserRecordingValueEvidence[];
  stack?: string;
  scriptUrl?: string;
  error?: string;
}

export interface CommunicationBoundaryHost {
  unique(prefix: string): string;
  describe(value: unknown, path: string): {
    byteLength?: number;
    dataType: string;
    preview?: string;
    evidence: BrowserRecordingValueEvidence[];
  };
  stackInfo(): { stack?: string; scriptUrl?: string };
  emit(
    input: CommunicationBoundaryEvent,
    context?: { traceId: string; interactionId?: string },
  ): { scriptUrl?: string; traceId: string; interactionId?: string } | undefined;
  afterWrapperInvoke(wrapperHandleId: string, scriptUrl?: string): void;
}

export interface CommunicationBoundaryRuntime {
  start(): void;
  stop(): void;
  wrapperFunction(wrapperHandleId: string): Function | undefined;
}

interface KnownWorker {
  worker: Worker;
  channelId: string;
  url?: string;
}

interface KnownPort {
  port: MessagePort;
  channelId: string;
  operationPrefix: 'message-port' | 'shared-worker';
  url?: string;
}

const MAX_KNOWN_CHANNELS = 64;

function ownCallable(owner: Record<string, unknown>, key: string): { descriptor?: PropertyDescriptor; value: Function } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor && (!('value' in descriptor) || (!descriptor.writable && !descriptor.configurable))) return undefined;
  const value = descriptor && 'value' in descriptor ? descriptor.value : owner[key];
  return typeof value === 'function' ? { descriptor, value } : undefined;
}

export function createCommunicationBoundaryRuntime(
  scope: Window,
  host: CommunicationBoundaryHost,
): CommunicationBoundaryRuntime {
  const handleByTarget = new Map<string, string>();
  const wrapperByHandle = new Map<string, Function>();
  const restorers: Array<() => void> = [];
  const workerChannel = new WeakMap<Worker, string>();
  const workerUrl = new WeakMap<Worker, string>();
  const portChannel = new WeakMap<MessagePort, string>();
  const knownWorkers: KnownWorker[] = [];
  const knownPorts: KnownPort[] = [];
  const traceByChannel = new Map<string, { traceId: string; interactionId?: string }>();
  const workerListenerCleanup = new Map<Worker, () => void>();
  const portListenerCleanup = new Map<MessagePort, () => void>();
  let active = false;

  const handle = (target: string): string => {
    const current = handleByTarget.get(target);
    if (current) return current;
    const created = host.unique('boundary-wrapper');
    handleByTarget.set(target, created);
    return created;
  };

  const rememberWorker = (worker: Worker, url?: string): KnownWorker => {
    let channelId = workerChannel.get(worker);
    if (!channelId) {
      channelId = host.unique('worker-channel');
      workerChannel.set(worker, channelId);
    }
    if (url) workerUrl.set(worker, url);
    let known = knownWorkers.find((item) => item.worker === worker);
    if (!known) {
      known = { worker, channelId, url };
      knownWorkers.push(known);
      if (knownWorkers.length > MAX_KNOWN_CHANNELS) {
        const removed = knownWorkers.shift();
        if (removed) {
          workerListenerCleanup.get(removed.worker)?.();
          workerListenerCleanup.delete(removed.worker);
          workerChannel.delete(removed.worker);
          workerUrl.delete(removed.worker);
          if (!knownWorkers.some((item) => item.channelId === removed.channelId)
            && !knownPorts.some((item) => item.channelId === removed.channelId)) {
            traceByChannel.delete(removed.channelId);
          }
        }
      }
    } else if (url) known.url = url;
    return known;
  };

  const rememberPort = (
    port: MessagePort,
    operationPrefix: KnownPort['operationPrefix'] = 'message-port',
    url?: string,
    forcedChannelId?: string,
  ): KnownPort => {
    let channelId = portChannel.get(port);
    if (!channelId) {
      channelId = forcedChannelId || host.unique('message-channel');
      portChannel.set(port, channelId);
    }
    let known = knownPorts.find((item) => item.port === port);
    if (!known) {
      known = { port, channelId, operationPrefix, url };
      knownPorts.push(known);
      if (knownPorts.length > MAX_KNOWN_CHANNELS) {
        const removed = knownPorts.shift();
        if (removed) {
          portListenerCleanup.get(removed.port)?.();
          portListenerCleanup.delete(removed.port);
          portChannel.delete(removed.port);
          if (!knownPorts.some((item) => item.channelId === removed.channelId)
            && !knownWorkers.some((item) => item.channelId === removed.channelId)) {
            traceByChannel.delete(removed.channelId);
          }
        }
      }
    } else {
      known.operationPrefix = operationPrefix;
      if (url) known.url = url;
    }
    return known;
  };

  const observeWorker = (known: KnownWorker): void => {
    if (workerListenerCleanup.has(known.worker)) return;
    const onMessage = (event: MessageEvent) => {
      const value = host.describe(event.data, '$message');
      host.emit({
        kind: 'worker', operation: 'worker.message', direction: 'receive', channelId: known.channelId,
        url: known.url, byteLength: value.byteLength, dataType: value.dataType,
        outputPreview: value.preview, outputs: value.evidence,
      }, traceByChannel.get(known.channelId));
      for (const port of event.ports || []) observePort(rememberPort(port));
    };
    const onError = (event: ErrorEvent) => host.emit({
      kind: 'worker', operation: 'worker.error', direction: 'receive', channelId: known.channelId,
      url: known.url, error: String(event.message || 'Worker error').slice(0, 512),
    });
    known.worker.addEventListener('message', onMessage);
    known.worker.addEventListener('error', onError);
    workerListenerCleanup.set(known.worker, () => {
      known.worker.removeEventListener('message', onMessage);
      known.worker.removeEventListener('error', onError);
    });
  };

  const observePort = (known: KnownPort): void => {
    if (portListenerCleanup.has(known.port)) return;
    const onMessage = (event: MessageEvent) => {
      const value = host.describe(event.data, '$message');
      host.emit({
        kind: 'message', operation: `${known.operationPrefix}.message`, direction: 'receive',
        channelId: known.channelId, url: known.url, byteLength: value.byteLength,
        dataType: value.dataType, outputPreview: value.preview, outputs: value.evidence,
      }, traceByChannel.get(known.channelId));
      for (const port of event.ports || []) observePort(rememberPort(port));
    };
    const onMessageError = () => host.emit({
      kind: 'message', operation: `${known.operationPrefix}.message-error`, direction: 'receive',
      channelId: known.channelId, url: known.url, error: 'Message could not be deserialized',
    });
    known.port.addEventListener('message', onMessage);
    known.port.addEventListener('messageerror', onMessageError);
    portListenerCleanup.set(known.port, () => {
      known.port.removeEventListener('message', onMessage);
      known.port.removeEventListener('messageerror', onMessageError);
    });
  };

  const transferredPorts = (value: unknown): MessagePort[] => {
    const Port = (scope as unknown as { MessagePort?: typeof MessagePort }).MessagePort;
    if (typeof Port !== 'function') return [];
    let items: unknown[] = [];
    if (Array.isArray(value)) items = value;
    else if (value && typeof value === 'object' && Array.isArray((value as { transfer?: unknown }).transfer)) {
      items = (value as { transfer: unknown[] }).transfer;
    }
    return items.filter((item): item is MessagePort => item instanceof Port);
  };

  const installValue = (
    owner: Record<string, unknown>,
    key: string,
    target: string,
    create: (original: Function, wrapperHandleId: string) => Function,
  ): void => {
    const callable = ownCallable(owner, key);
    if (!callable) return;
    const wrapperHandleId = handle(target);
    const wrapped = create(callable.value, wrapperHandleId);
    try {
      if (callable.descriptor) Object.defineProperty(owner, key, { ...callable.descriptor, value: wrapped });
      else owner[key] = wrapped;
    } catch {
      return;
    }
    wrapperByHandle.set(wrapperHandleId, wrapped);
    restorers.push(() => {
      if (owner[key] === wrapped) {
        try {
          if (callable.descriptor) Object.defineProperty(owner, key, callable.descriptor);
          else delete owner[key];
        } catch {
          // The page owns a later replacement.
        }
      }
      if (wrapperByHandle.get(wrapperHandleId) === wrapped) wrapperByHandle.delete(wrapperHandleId);
    });
  };

  const installSendBeacon = (): void => {
    const navigatorPrototype = Object.getPrototypeOf(scope.navigator) as Record<string, unknown> | null;
    if (!navigatorPrototype) return;
    installValue(navigatorPrototype, 'sendBeacon', 'navigator.sendBeacon', (original, wrapperHandleId) => (
      function recordedSendBeacon(this: Navigator, url: string | URL, data?: BodyInit | null): boolean {
        const source = host.stackInfo();
        const value = host.describe(data, '$body');
        const item = host.emit({
          kind: 'beacon', operation: 'request', method: 'POST', url: String(url).slice(0, 8_192),
          wrapperHandleId, byteLength: value.byteLength, dataType: value.dataType,
          inputPreview: value.preview, inputs: value.evidence, ...source,
        });
        host.afterWrapperInvoke(wrapperHandleId, item?.scriptUrl);
        return Reflect.apply(original, this, [url, data]);
      }
    ));
  };

  const installWorker = (): void => {
    const WorkerConstructor = (scope as unknown as Record<string, unknown>).Worker;
    if (typeof WorkerConstructor !== 'function') return;
    const prototype = (WorkerConstructor as { prototype?: Record<string, unknown> }).prototype;
    if (prototype) installValue(prototype, 'postMessage', 'worker.postMessage', (original, wrapperHandleId) => (
      function recordedWorkerPostMessage(this: Worker, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        const known = rememberWorker(this, workerUrl.get(this));
        observeWorker(known);
        for (const port of transferredPorts(transferOrOptions)) observePort(rememberPort(port));
        const source = host.stackInfo();
        const value = host.describe(message, '$message');
        const item = host.emit({
          kind: 'worker', operation: 'worker.postMessage', direction: 'send', channelId: known.channelId,
          url: known.url, wrapperHandleId, byteLength: value.byteLength, dataType: value.dataType,
          inputPreview: value.preview, inputs: value.evidence, ...source,
        });
        if (item) traceByChannel.set(known.channelId, { traceId: item.traceId, interactionId: item.interactionId });
        host.afterWrapperInvoke(wrapperHandleId, item?.scriptUrl);
        return Reflect.apply(original, this, transferOrOptions === undefined ? [message] : [message, transferOrOptions]);
      }
    ));
    installValue(scope as unknown as Record<string, unknown>, 'Worker', 'worker.constructor', (original) => new Proxy(original, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        const url = String(args[0] || '').slice(0, 8_192);
        const known = rememberWorker(worker, url);
        observeWorker(known);
        host.emit({ kind: 'worker', operation: 'worker.construct', channelId: known.channelId, url, ...host.stackInfo() });
        return worker;
      },
    }));
  };

  const installMessagePorts = (): void => {
    const Port = (scope as unknown as { MessagePort?: typeof MessagePort }).MessagePort;
    if (typeof Port === 'function') {
      installValue(Port.prototype as unknown as Record<string, unknown>, 'postMessage', 'message-port.postMessage', (original, wrapperHandleId) => (
        function recordedMessagePortPostMessage(this: MessagePort, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
          const known = rememberPort(this);
          observePort(known);
          for (const port of transferredPorts(transferOrOptions)) observePort(rememberPort(port));
          const source = host.stackInfo();
          const value = host.describe(message, '$message');
          const item = host.emit({
            kind: 'message', operation: `${known.operationPrefix}.postMessage`, direction: 'send',
            channelId: known.channelId, url: known.url, wrapperHandleId,
            byteLength: value.byteLength, dataType: value.dataType,
            inputPreview: value.preview, inputs: value.evidence, ...source,
          });
          if (item) traceByChannel.set(known.channelId, { traceId: item.traceId, interactionId: item.interactionId });
          host.afterWrapperInvoke(wrapperHandleId, item?.scriptUrl);
          return Reflect.apply(original, this, transferOrOptions === undefined ? [message] : [message, transferOrOptions]);
        }
      ));
    }

    const Channel = (scope as unknown as Record<string, unknown>).MessageChannel;
    if (typeof Channel === 'function') installValue(scope as unknown as Record<string, unknown>, 'MessageChannel', 'message-channel.constructor', (original) => new Proxy(original, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel;
        const channelId = host.unique('message-channel');
        observePort(rememberPort(channel.port1, 'message-port', undefined, channelId));
        observePort(rememberPort(channel.port2, 'message-port', undefined, channelId));
        return channel;
      },
    }));

    const Shared = (scope as unknown as Record<string, unknown>).SharedWorker;
    if (typeof Shared === 'function') installValue(scope as unknown as Record<string, unknown>, 'SharedWorker', 'shared-worker.constructor', (original) => new Proxy(original, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as SharedWorker;
        const url = String(args[0] || '').slice(0, 8_192);
        const known = rememberPort(worker.port, 'shared-worker', url);
        observePort(known);
        host.emit({ kind: 'message', operation: 'shared-worker.construct', channelId: known.channelId, url, ...host.stackInfo() });
        return worker;
      },
    }));

    const onWindowMessage = (event: MessageEvent) => {
      for (const port of event.ports || []) observePort(rememberPort(port));
    };
    scope.addEventListener('message', onWindowMessage, true);
    restorers.push(() => scope.removeEventListener('message', onWindowMessage, true));
  };

  return {
    start() {
      if (active) return;
      active = true;
      installSendBeacon();
      installWorker();
      installMessagePorts();
      for (const worker of knownWorkers) observeWorker(worker);
      for (const port of knownPorts) observePort(port);
    },
    stop() {
      if (!active) return;
      active = false;
      while (restorers.length) {
        try { restorers.pop()!(); } catch { /* Best-effort observer cleanup. */ }
      }
      for (const cleanup of workerListenerCleanup.values()) {
        try { cleanup(); } catch { /* Best effort. */ }
      }
      workerListenerCleanup.clear();
      for (const cleanup of portListenerCleanup.values()) {
        try { cleanup(); } catch { /* Best effort. */ }
      }
      portListenerCleanup.clear();
      knownWorkers.length = 0;
      knownPorts.length = 0;
      traceByChannel.clear();
      wrapperByHandle.clear();
    },
    wrapperFunction(wrapperHandleId) {
      return wrapperByHandle.get(wrapperHandleId);
    },
  };
}
