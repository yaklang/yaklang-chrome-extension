import { browser } from 'wxt/browser';
import type { BrowserTarget, PageEvalResult } from '@/types/models';
import { PAGE_BRIDGE_CHANNEL, type PageBridgeResponse, type PageOperation } from './protocol';

export type PageExecutionMode = 'user-scripts' | 'injected-bridge' | 'invoke-only';

interface PageExecutionAdapter {
  readonly mode: PageExecutionMode;
  execute(target: BrowserTarget, operation: PageOperation, timeoutMs: number): Promise<PageEvalResult>;
}

interface UserScriptInjectionResult {
  frameId: number;
  documentId?: string;
  result?: unknown;
  error?: string;
}

interface UserScriptsApi {
  getScripts(): Promise<unknown[]>;
  execute(injection: {
    target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
    js: Array<{ code: string }>;
    world: 'MAIN' | 'USER_SCRIPT';
  }): Promise<UserScriptInjectionResult[]>;
}

type UserScriptExecutionResponse = {
  ok: true;
  result: PageEvalResult;
} | {
  ok: false;
  error: { name: string; message: string; stack?: string };
};

type PageEvaluation = () => unknown | Promise<unknown>;

function evaluationSource(operation: PageOperation): string {
  if (operation.operation !== 'eval') return 'undefined';
  if (operation.mode === 'expression') return `async () => (\n${operation.code}\n)`;
  return `async () => {\n${operation.code}\n}`;
}

export async function executeInUserScriptWorld(
  input: PageOperation & { timeoutMs: number },
  evaluate?: PageEvaluation,
): Promise<UserScriptExecutionResponse> {
  const MAX_DEPTH = 6;
  const MAX_ITEMS = 100;
  const MAX_STRING = 100_000;
  const startedAt = performance.now();

  const serialize = (value: unknown): Omit<PageEvalResult, 'durationMs'> => {
    const seen = new WeakSet<object>();
    let truncated = false;
    const visit = (current: unknown, depth: number): unknown => {
      if (current === null) return null;
      if (typeof current === 'string') {
        if (current.length > MAX_STRING) truncated = true;
        return current.slice(0, MAX_STRING);
      }
      if (typeof current === 'number' || typeof current === 'boolean') return current;
      if (typeof current === 'undefined') return { $type: 'undefined' };
      if (typeof current === 'bigint') return { $type: 'bigint', value: current.toString() };
      if (typeof current === 'symbol') return { $type: 'symbol', value: String(current) };
      if (typeof current === 'function') {
        const source = Function.prototype.toString.call(current);
        if (source.length > 2_000) truncated = true;
        return { $type: 'function', name: current.name || '', source: source.slice(0, 2_000) };
      }
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return { $type: 'max-depth', constructor: (current as object).constructor?.name || 'Object' };
      }
      if (seen.has(current as object)) return { $type: 'circular' };
      seen.add(current as object);
      if (current instanceof Error) return { $type: 'error', name: current.name, message: current.message, stack: current.stack?.slice(0, 10_000) };
      if (current instanceof Date) return { $type: 'date', value: current.toISOString() };
      if (current instanceof RegExp) return { $type: 'regexp', value: String(current) };
      if (current instanceof Node) {
        const element = current instanceof Element ? current : current.parentElement;
        const html = element?.outerHTML || current.textContent || '';
        if (html.length > 10_000) truncated = true;
        return { $type: 'node', name: current.nodeName, html: html.slice(0, 10_000) };
      }
      if (Array.isArray(current)) {
        if (current.length > MAX_ITEMS) truncated = true;
        return current.slice(0, MAX_ITEMS).map((item) => visit(item, depth + 1));
      }
      const output: Record<string, unknown> = {};
      const allKeys = Reflect.ownKeys(current as object);
      if (allKeys.length > MAX_ITEMS) truncated = true;
      for (const key of allKeys.slice(0, MAX_ITEMS)) {
        const name = typeof key === 'symbol' ? `[${String(key)}]` : key;
        try {
          output[name] = visit(Reflect.get(current as object, key), depth + 1);
        } catch (error) {
          output[name] = { $type: 'unreadable', message: error instanceof Error ? error.message : String(error) };
        }
      }
      return output;
    };
    const normalized = visit(value, 0);
    let preview: string;
    try {
      preview = typeof value === 'string' ? value : JSON.stringify(normalized);
    } catch {
      preview = String(value);
    }
    return {
      value: normalized,
      type: value === null ? 'null' : typeof value,
      preview: preview.slice(0, 2_000),
      truncated: truncated || preview.length > 2_000,
    };
  };

  try {
    const operation = (async () => {
      if (input.operation === 'eval') {
        if (!evaluate) throw new Error('页面 Eval 缺少直接 User Script 执行体');
        return await evaluate();
      }
      const segments = input.path.split('.').filter(Boolean);
      let owner: unknown = window;
      let target: unknown = window;
      for (const segment of segments) {
        owner = target;
        target = Reflect.get(target as object, segment);
      }
      if (typeof target !== 'function') throw new TypeError(`${input.path} is not a function`);
      return await Reflect.apply(target, owner, input.args);
    })();
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = globalThis.setTimeout(() => reject(new Error(`页面执行超过 ${input.timeoutMs}ms`)), input.timeoutMs);
    });
    const serialized = serialize(await Promise.race([operation, timeout]).finally(() => {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    }));
    return { ok: true, result: { ...serialized, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 } };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.slice(0, 10_000) : undefined,
      },
    };
  }
}

const injectedBridgeAdapter: PageExecutionAdapter = {
  mode: 'injected-bridge',
  async execute(target, operation, timeoutMs) {
    const response = await browser.tabs.sendMessage(target.tabId, {
      channel: PAGE_BRIDGE_CHANNEL,
      ...operation,
      timeoutMs,
    }, target.documentId ? { documentId: target.documentId } : { frameId: target.frameId }) as PageBridgeResponse;
    if (!response?.ok) throw new Error(response?.error?.message || '页面主世界执行失败');
    return response.result;
  },
};

const userScriptsAdapter: PageExecutionAdapter = {
  mode: 'user-scripts',
  async execute(target, operation, timeoutMs) {
    const userScripts = (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
    if (!userScripts?.execute) {
      throw new Error('User Scripts API 不可用；Chrome 138+ 还需要在扩展详情中启用“允许用户脚本”');
    }
    const input = JSON.stringify({ ...operation, timeoutMs }).replaceAll('<', '\\u003c');
    const code = `(${executeInUserScriptWorld.toString()})(${input},${evaluationSource(operation)})`;
    const [injection] = await userScripts.execute({
      target: target.documentId
        ? { tabId: target.tabId, documentIds: [target.documentId] }
        : { tabId: target.tabId, frameIds: [target.frameId] },
      world: 'MAIN',
      js: [{ code }],
    });
    if (!injection) throw new Error('User Scripts API 没有返回主框架执行结果');
    if (injection.error) throw new Error(injection.error);
    const response = injection.result as UserScriptExecutionResponse | undefined;
    if (!response) throw new Error('User Scripts API 返回了空执行结果');
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  },
};

const enterpriseAdapter: PageExecutionAdapter = {
  mode: 'user-scripts',
  async execute(target, operation, timeoutMs) {
    const userScripts = (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
    if (!userScripts?.execute || !userScripts.getScripts) {
      return injectedBridgeAdapter.execute(target, operation, timeoutMs);
    }
    try {
      await userScripts.getScripts();
    } catch {
      return injectedBridgeAdapter.execute(target, operation, timeoutMs);
    }
    return userScriptsAdapter.execute(target, operation, timeoutMs);
  },
};

const invokeOnlyAdapter: PageExecutionAdapter = {
  mode: 'invoke-only',
  async execute() {
    throw new Error('Firefox AMO 渠道仅提供结构化浏览器命令，不包含页面函数调用或 Eval');
  },
};

const executionAdapter = import.meta.env.FIREFOX && import.meta.env.MODE === 'store'
  ? invokeOnlyAdapter
  : !import.meta.env.FIREFOX
  && (import.meta.env.MODE === 'production' || import.meta.env.MODE === 'store')
  ? userScriptsAdapter
  : !import.meta.env.FIREFOX && import.meta.env.MODE === 'enterprise'
  ? enterpriseAdapter
  : injectedBridgeAdapter;

export function getPageExecutionMode(): PageExecutionMode {
  return executionAdapter.mode;
}

export function executePageOperation(target: BrowserTarget, operation: PageOperation, timeoutMs = 10_000): Promise<PageEvalResult> {
  return executionAdapter.execute(target, operation, Math.min(Math.max(timeoutMs, 250), 60_000));
}
