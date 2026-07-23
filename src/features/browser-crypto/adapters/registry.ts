import type {
  CryptoAdapterOperation,
  CryptoAdapterScope,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';

export interface CryptoAdapterRuntimeHost {
  unique(prefix: string): string;
  invoke(
    operation: CryptoAdapterOperation,
    original: Function,
    thisArg: unknown,
    args: unknown[],
    wrapperHandleId: string,
    installDynamic: (operations: CryptoAdapterOperation[]) => void,
  ): unknown;
}

export interface CryptoAdapterRuntime {
  start(): void;
  stop(): void;
  ensureDynamic(): void;
  wrapperFunction(wrapperHandleId: string): Function | undefined;
}

const RETRY_DELAYS = [50, 250, 1_000, 3_000] as const;

export function createCryptoAdapterRuntime(
  adapters: PageCryptoAdapter[],
  scope: CryptoAdapterScope,
  toolkit: CryptoAdapterToolkit,
  host: CryptoAdapterRuntimeHost,
): CryptoAdapterRuntime {
  const wrappers = new WeakSet<Function>();
  const handleByTarget = new Map<string, string>();
  const wrapperByHandle = new Map<string, Function>();
  const restorers: Array<() => void> = [];
  const dynamicOperations: Array<{ adapter: PageCryptoAdapter; operation: CryptoAdapterOperation }> = [];
  const retryTimers = new Set<number>();
  let active = false;

  const installOperation = (adapter: PageCryptoAdapter, operation: CryptoAdapterOperation): void => {
    const descriptor = Object.getOwnPropertyDescriptor(operation.owner, operation.key);
    if (descriptor && (!('value' in descriptor) || (!descriptor.writable && !descriptor.configurable))) return;
    const current = descriptor && 'value' in descriptor ? descriptor.value : operation.owner[operation.key];
    if (typeof current !== 'function' || wrappers.has(current)) return;
    const targetKey = `${adapter.manifest.id}:${operation.id}`;
    const wrapperHandleId = handleByTarget.get(targetKey) || host.unique('wrapper');
    handleByTarget.set(targetKey, wrapperHandleId);
    const wrapped = operation.createWrapper(
      current,
      (thisArg, args) => host.invoke(operation, current, thisArg, args, wrapperHandleId, (operations) => {
        for (const discovered of operations.slice(0, 32)) {
          if (!dynamicOperations.some((item) => item.operation === discovered)) {
            dynamicOperations.push({ adapter, operation: discovered });
            if (dynamicOperations.length > 128) dynamicOperations.shift();
          }
          try { installOperation(adapter, discovered); } catch { /* Session discovery is best effort. */ }
        }
      }),
    );
    try {
      if (descriptor) Object.defineProperty(operation.owner, operation.key, { ...descriptor, value: wrapped });
      else operation.owner[operation.key] = wrapped;
    } catch {
      return;
    }
    wrappers.add(wrapped);
    wrapperByHandle.set(wrapperHandleId, wrapped);
    restorers.push(() => {
      if (operation.owner[operation.key] === wrapped) {
        try {
          if (descriptor) Object.defineProperty(operation.owner, operation.key, descriptor);
          else delete operation.owner[operation.key];
        } catch {
          // A page replacement wins over recorder cleanup.
        }
      }
      if (wrapperByHandle.get(wrapperHandleId) === wrapped) wrapperByHandle.delete(wrapperHandleId);
    });
  };

  const install = (dynamicOnly: boolean): void => {
    if (!active) return;
    for (const adapter of adapters) {
      if (dynamicOnly && !adapter.manifest.dynamic) continue;
      let operations: CryptoAdapterOperation[] = [];
      try { operations = adapter.discover(scope); } catch { continue; }
      for (const operation of operations) {
        try { installOperation(adapter, operation); } catch { /* One adapter cannot break recording. */ }
      }
    }
    if (!dynamicOnly) {
      for (const item of dynamicOperations) {
        try { installOperation(item.adapter, item.operation); } catch { /* A stale session is ignored. */ }
      }
    }
  };

  const ensureDynamic = (): void => install(true);
  const onResourceLoad = (event: Event): void => {
    const target = event.target as { tagName?: unknown } | null;
    const ScriptElement = (scope.window as unknown as {
      HTMLScriptElement?: typeof HTMLScriptElement;
    }).HTMLScriptElement;
    const isScript = typeof ScriptElement === 'function'
      ? target instanceof ScriptElement
      : target?.tagName === 'SCRIPT';
    if (isScript) ensureDynamic();
  };

  return {
    start() {
      if (active) return;
      active = true;
      install(false);
      scope.window.document.addEventListener('load', onResourceLoad, true);
      for (const delay of RETRY_DELAYS) {
        const timer = scope.window.setTimeout(() => {
          retryTimers.delete(timer);
          ensureDynamic();
        }, delay);
        retryTimers.add(timer);
      }
    },
    stop() {
      if (!active) return;
      active = false;
      scope.window.document.removeEventListener('load', onResourceLoad, true);
      for (const timer of retryTimers) scope.window.clearTimeout(timer);
      retryTimers.clear();
      while (restorers.length) {
        try { restorers.pop()!(); } catch { /* Cleanup is best effort. */ }
      }
      wrapperByHandle.clear();
    },
    ensureDynamic,
    wrapperFunction(wrapperHandleId) {
      return wrapperByHandle.get(wrapperHandleId);
    },
  };
}
