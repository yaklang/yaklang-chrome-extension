import { browser, type Browser } from 'wxt/browser';
import type { BrowserTarget, BrowserPageCallableTransaction } from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { scriptingTarget } from '@/platform/browser/targets';

const RULE_BASE = 1_000_000;
const RULE_LIMIT = RULE_BASE + 10_000;
const queues = new Map<number, Promise<unknown>>();
let ruleQueue: Promise<unknown> = Promise.resolve();

// DNR is tab-scoped: all callables and profiles in that tab share this gate.
export function serializeTabExecution<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(tabId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(run);
  queues.set(tabId, result);
  void result.finally(() => { if (queues.get(tabId) === result) queues.delete(tabId); }).catch(() => undefined);
  return result;
}

async function installRules(tabId: number, prerequisites: BrowserPageCallableTransaction['prerequisites']): Promise<number[]> {
  const run = async () => {
    const occupied = new Set((await browser.declarativeNetRequest.getSessionRules()).map((rule) => rule.id));
    let nextId = RULE_BASE;
    const allocate = () => {
      while (occupied.has(nextId)) nextId++;
      if (nextId >= RULE_LIMIT) throw new Error('页面网络隔离规则已满');
      return nextId++;
    };
    const rules: Browser.declarativeNetRequest.Rule[] = [{
      id: allocate(), priority: 100_000, action: { type: 'block' },
      condition: {
        tabIds: [tabId], urlFilter: '*',
        // Omitting resourceTypes excludes main_frame and lets native form navigation escape.
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
          'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'],
      },
    }];
    for (const step of prerequisites) {
      const url = new URL(step.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('在线前置请求必须使用 HTTP(S)');
      rules.push({
        id: allocate(), priority: 100_001, action: { type: 'allow' },
        condition: {
          tabIds: [tabId], regexFilter: `^${url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          requestMethods: [step.method.toLowerCase() as Browser.declarativeNetRequest.RequestMethod],
          resourceTypes: ['xmlhttprequest'],
        },
      });
    }
    await browser.declarativeNetRequest.updateSessionRules({ addRules: rules });
    return rules.map((rule) => rule.id);
  };
  const result = ruleQueue.then(run, run);
  ruleQueue = result.catch(() => undefined);
  return result;
}

export async function withPageNetworkGuard<T>(
  target: BrowserTarget,
  prerequisites: BrowserPageCallableTransaction['prerequisites'],
  run: () => Promise<T>,
  captureURL?: string,
): Promise<T> {
  const ids = await installRules(target.tabId, prerequisites);
  let blocked: string | undefined;
  let captured!: () => void;
  const capturedRequest = new Promise<void>((resolve) => { captured = resolve; });
  const onError = (details: Browser.webRequest.OnErrorOccurredDetails) => {
    if (details.tabId === target.tabId && /BLOCKED_BY_CLIENT|NS_ERROR_ABORT/.test(details.error)) {
      blocked = details.url;
      if (details.url === captureURL) captured();
    }
  };
  try {
    browser.webRequest.onErrorOccurred.addListener(onError, { urls: ['<all_urls>'], tabId: target.tabId });
    let value: T;
    try {
      value = await run();
    } finally {
      // Native form navigation is queued in the renderer. Drain it before removing
      // browser protection, including when the callable failed during rollback.
      await browser.scripting.executeScript({
        target: scriptingTarget(target),
        func: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      }).catch(() => undefined); // A destroyed document has no queued navigation to drain.
    }
    if (captureURL) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([capturedRequest, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('捕获后未观察到目标请求被浏览器取消，不能确认捕获完成')), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    // Drain browser request-error delivery before reporting a successful replay.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (blocked && !captureURL) throw new ExtensionError('callable_network_blocked', `回放尝试绕过页面拦截，浏览器已阻止请求：${blocked}`);
    return value;
  } finally {
    browser.webRequest.onErrorOccurred.removeListener(onError);
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }
}
