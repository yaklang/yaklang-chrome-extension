import { CONTROL_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import type {
  ActiveTabInfo,
  BridgeGrant,
  CapabilityScope,
  ExtensionState,
  GrantCreateInput,
} from '@/types/models';

const DEFAULT_GATEWAY_GRANT_MINUTES = 30;

function targetKey(target: { tabId: number; frameId: number }): string {
  return `${target.tabId}:${target.frameId}`;
}

function tabOrigin(tab: ActiveTabInfo): string {
  try {
    return new URL(tab.url).origin;
  } catch {
    return '';
  }
}

export function gatewayShareActive(
  grant: BridgeGrant | undefined,
  tab: ActiveTabInfo | undefined,
  now = Date.now(),
): boolean {
  if (!grant || !tab || grant.expiresAt <= now) return false;
  if (!CONTROL_CAPABILITY_SCOPES.every((scope) => grant.scopes.includes(scope))) return false;
  const origin = tabOrigin(tab);
  return grant.targets.some((target) => (
    target.tabId === tab.id
    && target.frameId === 0
    && (!origin || target.origin === origin)
  ));
}

export function gatewayShareGrantInput(
  state: ExtensionState,
  tab: ActiveTabInfo,
  now = Date.now(),
): GrantCreateInput {
  const active = state.activeGrant && state.activeGrant.expiresAt > now
    ? state.activeGrant
    : undefined;
  const targets = new Map<string, { tabId: number; frameId: number }>();
  active?.targets.forEach((target) => {
    targets.set(targetKey(target), { tabId: target.tabId, frameId: target.frameId });
  });
  targets.set(targetKey({ tabId: tab.id, frameId: 0 }), { tabId: tab.id, frameId: 0 });

  const scopes = new Set<CapabilityScope>(active?.scopes || []);
  CONTROL_CAPABILITY_SCOPES.forEach((scope) => scopes.add(scope));

  const remainingMinutes = active
    ? Math.ceil((active.expiresAt - now) / 60_000)
    : 0;
  return {
    targets: [...targets.values()],
    scopes: [...scopes],
    durationMinutes: Math.max(DEFAULT_GATEWAY_GRANT_MINUTES, remainingMinutes),
    taskId: active?.taskId,
  };
}

export function authorizationShareGrantInput(
  state: ExtensionState,
  tabs: [ActiveTabInfo, ActiveTabInfo],
  now = Date.now(),
): GrantCreateInput {
  const active = state.activeGrant && state.activeGrant.expiresAt > now
    ? state.activeGrant
    : undefined;
  const scopes = new Set<CapabilityScope>(active?.scopes || []);
  CONTROL_CAPABILITY_SCOPES.forEach((scope) => scopes.add(scope));
  const remainingMinutes = active
    ? Math.ceil((active.expiresAt - now) / 60_000)
    : 0;
  return {
    targets: tabs.map((item) => ({ tabId: item.id, frameId: 0 })),
    scopes: [...scopes],
    durationMinutes: Math.max(DEFAULT_GATEWAY_GRANT_MINUTES, remainingMinutes),
    taskId: active?.taskId,
  };
}
