import { browser } from 'wxt/browser';
import type { ExtensionAction, ExtensionRequest, ExtensionResponse, RequestInput, RequestOutput } from '@/types/messages';
import { ExtensionError } from '@/shared/errors';

export function parseExtensionResponseEnvelope<T>(input: unknown, action: string): ExtensionResponse<T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExtensionError('runtime_protocol_mismatch', `扩展操作 ${action} 返回的消息不是对象`);
  }
  const value = input as Record<string, unknown>;
  const unexpected = Object.keys(value).find((key) => !['ok', 'data', 'error', 'errorCode', 'errorData'].includes(key));
  if (unexpected) {
    throw new ExtensionError(
      'runtime_protocol_mismatch',
      `扩展操作 ${action} 返回了未声明字段 $.${unexpected}，请重新加载插件`,
    );
  }
  if (typeof value.ok !== 'boolean') {
    throw new ExtensionError('runtime_protocol_mismatch', `扩展操作 ${action} 缺少布尔字段 $.ok`);
  }
  if (!value.ok && value.error !== undefined && typeof value.error !== 'string') {
    throw new ExtensionError('runtime_protocol_mismatch', `扩展操作 ${action} 的 $.error 必须是字符串`);
  }
  if (value.errorCode !== undefined && typeof value.errorCode !== 'string') {
    throw new ExtensionError('runtime_protocol_mismatch', `扩展操作 ${action} 的 $.errorCode 必须是字符串`);
  }
  return value as unknown as ExtensionResponse<T>;
}

export async function request<A extends ExtensionAction>(
  action: A,
  ...args: undefined extends RequestInput<A> ? [payload?: RequestInput<A>] : [payload: RequestInput<A>]
): Promise<RequestOutput<A>> {
  const payload = args[0];
  const response = parseExtensionResponseEnvelope<RequestOutput<A>>(
    await browser.runtime.sendMessage({ action, payload } as ExtensionRequest),
    action,
  );
  if (!response?.ok) {
    throw new ExtensionError(
      response?.errorCode || 'request_failed',
      response?.error || `Extension request failed: ${action}`,
      response?.errorData,
    );
  }
  return response.data as RequestOutput<A>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
