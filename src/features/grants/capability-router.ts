import type {
  CapabilityDomainHandler,
  CapabilityRouteContext,
} from './capability-context';
import { navigationCapabilityHandler } from './capability-handlers/navigation';
import { handoffCapabilityHandler } from './capability-handlers/handoff';
import { networkCapabilityHandler } from './capability-handlers/network';
import { recordingCapabilityHandler } from './capability-handlers/recording';
import { transformCapabilityHandler } from './capability-handlers/transform';
import { pageCapabilityHandler } from './capability-handlers/page';
import { proxyCapabilityHandler } from './capability-handlers/proxy';

export const CAPABILITY_HANDLERS: readonly CapabilityDomainHandler[] = [
  navigationCapabilityHandler,
  handoffCapabilityHandler,
  networkCapabilityHandler,
  recordingCapabilityHandler,
  transformCapabilityHandler,
  pageCapabilityHandler,
  proxyCapabilityHandler,
];

export function capabilityOwners(method: string): CapabilityDomainHandler[] {
  return CAPABILITY_HANDLERS.filter((handler) => handler.owns(method));
}

export async function dispatchCapability(context: CapabilityRouteContext): Promise<unknown> {
  const owners = capabilityOwners(context.method);
  if (owners.length === 0) throw new Error(`不支持的 Bridge 方法: ${context.method}`);
  if (owners.length > 1) {
    throw new Error(
      `Bridge 方法 ${context.method} 被多个领域重复注册: ${owners.map((item) => item.id).join(', ')}`,
    );
  }
  return owners[0].handle(context);
}
