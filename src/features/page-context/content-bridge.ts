import { browser, type Browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createOpaqueId } from '@/shared/id';
import {
  PAGE_BRIDGE_CHANNEL,
  PAGE_REQUEST_EVENT,
  PAGE_RESPONSE_EVENT,
  type PageBridgeRequest,
  type PageBridgeResponse,
  type PageOperation,
} from './protocol';

type InternalMessage = PageOperation & { channel: typeof PAGE_BRIDGE_CHANNEL; timeoutMs?: number };

export async function installPageWorldBridge(ctx: ContentScriptContext): Promise<void> {
  const pending = new Map<string, {
    resolve: (response: PageBridgeResponse) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }>();

  const { script } = await injectScript('/page-main-world.js', {
    keepInDom: true,
    modifyScript(element) {
      element.id = createOpaqueId('yakit-page-bridge');
    },
  });

  const onResponse = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
    let response: PageBridgeResponse;
    try {
      response = JSON.parse(event.detail) as PageBridgeResponse;
    } catch {
      return;
    }
    const task = pending.get(response.id);
    if (!task) return;
    globalThis.clearTimeout(task.timer);
    pending.delete(response.id);
    task.resolve(response);
  };
  script.addEventListener(PAGE_RESPONSE_EVENT, onResponse);
  ctx.onInvalidated(() => {
    script.removeEventListener(PAGE_RESPONSE_EVENT, onResponse);
    script.remove();
    for (const task of pending.values()) globalThis.clearTimeout(task.timer);
    pending.clear();
  });

  const execute = (message: InternalMessage): Promise<PageBridgeResponse> => {
    const id = createOpaqueId('page-request');
    const timeoutMs = Math.min(Math.max(message.timeoutMs || 10_000, 250), 60_000);
    const request: PageBridgeRequest = message.operation === 'eval'
      ? { id, timeoutMs, operation: 'eval', mode: message.mode, code: message.code }
      : { id, timeoutMs, operation: 'invoke', path: message.path, args: message.args };
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        pending.delete(id);
        resolve({ id, ok: false, error: { name: 'TimeoutError', message: `页面执行超过 ${timeoutMs}ms` } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      script.dispatchEvent(new CustomEvent(PAGE_REQUEST_EVENT, { detail: JSON.stringify(request) }));
    });
  };

  const onMessage = (message: unknown, _sender: Browser.runtime.MessageSender, sendResponse: (response: PageBridgeResponse) => void) => {
    const input = message as InternalMessage;
    if (input?.channel !== PAGE_BRIDGE_CHANNEL || !['eval', 'invoke'].includes(input.operation)) return undefined;
    void execute(input).then(sendResponse);
    return true;
  };
  browser.runtime.onMessage.addListener(onMessage);
  ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
}
