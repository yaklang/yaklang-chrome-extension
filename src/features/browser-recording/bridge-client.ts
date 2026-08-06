import { browser } from 'wxt/browser';
import { ExtensionError } from '@/shared/errors';
import type { BrowserTarget } from '@/types/models';
import {
  PAGE_RECORDER_BRIDGE_CHANNEL,
  type PageRecorderBridgeCommand,
  type PageRecorderBridgeResponse,
  type PageRecorderRuntimeMessage,
} from './bridge-protocol';

export async function executeFirefoxPageRecorderCommand(
  target: BrowserTarget,
  command: PageRecorderBridgeCommand,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  let response: PageRecorderBridgeResponse;
  try {
    response = await browser.tabs.sendMessage(target.tabId, {
      channel: PAGE_RECORDER_BRIDGE_CHANNEL,
      command,
      input,
    } satisfies PageRecorderRuntimeMessage, { frameId: target.frameId }) as PageRecorderBridgeResponse;
  } catch (error) {
    throw new ExtensionError('recorder_unavailable', error instanceof Error ? error.message : String(error));
  }
  if (!response?.ok) throw new ExtensionError('recorder_unavailable', response?.error || 'Firefox 页面录制器不可用');
  return response.result;
}
