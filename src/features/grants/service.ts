import { browser } from 'wxt/browser';
import {
  capabilityBaseScope,
  CONTROL_CAPABILITY_SCOPES,
  READ_CAPABILITY_SCOPES,
} from '@/protocol/capabilities';
import { parseCapabilityParams } from '@/protocol/bridge';
import { ExtensionError } from '@/shared/errors';
import { browserInstanceAccess, type CapabilityEngineRequest } from './capability-context';
import { dispatchCapability } from './capability-router';

export { CONTROL_CAPABILITY_SCOPES, READ_CAPABILITY_SCOPES } from '@/protocol/capabilities';

export async function routeCapability(
  method: string,
  params: unknown,
  requestEngine?: CapabilityEngineRequest,
): Promise<unknown> {
  if (method === 'system.ping') {
    const userAgent = globalThis.navigator?.userAgent || '';
    const browserName = /Firefox\//i.test(userAgent)
      ? 'Firefox'
      : /Edg\//i.test(userAgent)
        ? 'Edge'
        : /Chrom(?:e|ium)\//i.test(userAgent)
          ? 'Chrome'
          : undefined;
    return {
      now: Date.now(),
      extensionVersion: browser.runtime.getManifest().version,
      browserName,
    };
  }
  if (import.meta.env.FIREFOX
    && import.meta.env.MODE === 'store'
    && ['browser.invoke', 'browser.eval'].includes(method)) {
    throw new ExtensionError(
      'channel_unavailable',
      'Firefox AMO 渠道不提供页面函数调用或通用 Eval',
    );
  }
  const input = parseCapabilityParams(method, params);
  const required = method === 'browser.eval' && input.mode === 'program'
    ? 'browser.page.eval.program'
    : capabilityBaseScope(method);
  if (!required) throw new Error(`不支持的 Bridge 方法: ${method}`);
  const grant = await browserInstanceAccess(required);
  return dispatchCapability({ method, input, grant, requestEngine });
}
