import type {
  BrowserPageCallableExecutionPolicy,
  BrowserPageCallableResultMode,
} from '@/types/models';

export const DEFAULT_CALLABLE_TIMEOUT_MS = 8_000;
export const MIN_CALLABLE_TIMEOUT_MS = 250;
export const MAX_CALLABLE_TIMEOUT_MS = 30_000;

export function callableExecutionPolicy(
  resultMode: BrowserPageCallableResultMode,
  timeoutMs = DEFAULT_CALLABLE_TIMEOUT_MS,
): BrowserPageCallableExecutionPolicy {
  return {
    resultMode,
    timeoutMs: Math.max(MIN_CALLABLE_TIMEOUT_MS, Math.min(MAX_CALLABLE_TIMEOUT_MS, Math.floor(timeoutMs))),
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function');
}

export async function settleCallableResult(
  value: unknown,
  execution: BrowserPageCallableExecutionPolicy,
): Promise<unknown> {
  const thenable = isThenable(value);
  if (execution.resultMode === 'sync') {
    if (thenable) throw new Error('页面函数声明为同步执行，但返回了 Promise');
    return value;
  }
  if (execution.resultMode === 'promise' && !thenable) {
    throw new Error('页面函数声明为异步执行，但没有返回 Promise');
  }
  if (!thenable) return value;

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`页面函数异步执行超过 ${execution.timeoutMs} ms`));
    }, execution.timeoutMs);
    Promise.resolve(value).then(
      (result) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(result);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
