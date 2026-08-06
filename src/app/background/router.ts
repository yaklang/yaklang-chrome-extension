import type { Browser } from 'wxt/browser';
import type { ExtensionRequest, ExtensionResponse } from '@/types/messages';

export type BackgroundRequestHandler = (
  request: ExtensionRequest,
  sender: Browser.runtime.MessageSender,
) => Promise<ExtensionResponse | undefined>;

export async function dispatchBackgroundHandlers(
  request: ExtensionRequest,
  sender: Browser.runtime.MessageSender,
  handlers: readonly BackgroundRequestHandler[],
): Promise<ExtensionResponse | undefined> {
  for (const handler of handlers) {
    const response = await handler(request, sender);
    if (response !== undefined) return response;
  }
  return undefined;
}
