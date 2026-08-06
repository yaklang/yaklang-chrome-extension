import { browser, type Browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createOpaqueId } from '@/shared/id';
import {
  PAGE_RECORDER_BRIDGE_CHANNEL,
  PAGE_RECORDER_REQUEST_EVENT,
  PAGE_RECORDER_RESPONSE_EVENT,
  type PageRecorderBridgeRequest,
  type PageRecorderBridgeResponse,
  type PageRecorderRuntimeMessage,
} from './bridge-protocol';

export async function installPageRecorderBridge(ctx: ContentScriptContext): Promise<void> {
  const pending = new Map<string, {
    resolve: (response: PageRecorderBridgeResponse) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }>();
  const { script } = await injectScript('/page-recorder-main-world.js', {
    keepInDom: true,
    modifyScript(element) {
      element.id = createOpaqueId('yakit-page-recorder');
    },
  });

  const onResponse = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
    let response: PageRecorderBridgeResponse;
    try { response = JSON.parse(event.detail) as PageRecorderBridgeResponse; } catch { return; }
    const task = pending.get(response.id);
    if (!task) return;
    globalThis.clearTimeout(task.timer);
    pending.delete(response.id);
    task.resolve(response);
  };
  script.addEventListener(PAGE_RECORDER_RESPONSE_EVENT, onResponse);

  const execute = (message: PageRecorderRuntimeMessage): Promise<PageRecorderBridgeResponse> => {
    const id = createOpaqueId('recorder-request');
    const request: PageRecorderBridgeRequest = { id, command: message.command, input: message.input || {} };
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        pending.delete(id);
        resolve({ id, ok: false, error: 'Firefox 页面录制器响应超时' });
      }, 60_000);
      pending.set(id, { resolve, timer });
      script.dispatchEvent(new CustomEvent(PAGE_RECORDER_REQUEST_EVENT, { detail: JSON.stringify(request) }));
    });
  };

  const onMessage = (
    message: unknown,
    _sender: Browser.runtime.MessageSender,
    sendResponse: (response: PageRecorderBridgeResponse) => void,
  ) => {
    const input = message as PageRecorderRuntimeMessage;
    if (input?.channel !== PAGE_RECORDER_BRIDGE_CHANNEL || typeof input.command !== 'string') return undefined;
    void execute(input).then(sendResponse);
    return true;
  };
  browser.runtime.onMessage.addListener(onMessage);
  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(onMessage);
    script.removeEventListener(PAGE_RECORDER_RESPONSE_EVENT, onResponse);
    script.remove();
    for (const task of pending.values()) globalThis.clearTimeout(task.timer);
    pending.clear();
  });
}
