import { browser } from 'wxt/browser';
import type { ExtensionAction, ExtensionRequest, ExtensionResponse, RequestInput, RequestOutput } from '@/types/messages';

export async function request<A extends ExtensionAction>(
  action: A,
  ...args: undefined extends RequestInput<A> ? [payload?: RequestInput<A>] : [payload: RequestInput<A>]
): Promise<RequestOutput<A>> {
  const payload = args[0];
  const response = (await browser.runtime.sendMessage({ action, payload } as ExtensionRequest)) as ExtensionResponse<RequestOutput<A>>;
  if (!response?.ok) {
    throw new Error(response?.error || `Extension request failed: ${action}`);
  }
  return response.data as RequestOutput<A>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
