import { browser } from 'wxt/browser';
import type { BridgeConfig, EnterprisePolicy, EnterprisePolicyStatus, ExtensionState } from '@/types/models';
import { ExtensionError } from '@/shared/errors';

interface ManagedStorageArea {
  get(keys?: null): Promise<Record<string, unknown>>;
}

function stringValue(input: unknown, maxLength: number): string | undefined {
  return typeof input === 'string' && input.trim() && input.length <= maxLength ? input.trim() : undefined;
}

export async function getEnterprisePolicy(): Promise<EnterprisePolicyStatus> {
  const area = (browser.storage as unknown as { managed?: ManagedStorageArea }).managed;
  if (!area) return { managed: false, policy: {}, warnings: [] };
  let input: Record<string, unknown>;
  try {
    input = await area.get(null);
  } catch {
    return { managed: false, policy: {}, warnings: [] };
  }
  const warnings: string[] = [];
  const policy: EnterprisePolicy = {};
  if (input.bridgeTransport === 'native' || input.bridgeTransport === 'websocket') policy.bridgeTransport = input.bridgeTransport;
  if (input.bridgeEndpoint !== undefined) {
    const value = stringValue(input.bridgeEndpoint, 2_048);
    if (value) policy.bridgeEndpoint = value; else warnings.push('bridgeEndpoint 无效');
  }
  if (input.nativeHost !== undefined) {
    const value = stringValue(input.nativeHost, 253);
    if (value) policy.nativeHost = value; else warnings.push('nativeHost 无效');
  }
  for (const key of ['autoConnect', 'disableWebSocket', 'floatingPanelEnabled', 'allowProgramEval'] as const) {
    if (typeof input[key] === 'boolean') policy[key] = input[key];
  }
  if (Number.isSafeInteger(input.maxGrantMinutes) && Number(input.maxGrantMinutes) >= 5 && Number(input.maxGrantMinutes) <= 1_440) {
    policy.maxGrantMinutes = Number(input.maxGrantMinutes);
  } else if (input.maxGrantMinutes !== undefined) warnings.push('maxGrantMinutes 无效');
  if (Array.isArray(input.grantAllowedOrigins)) {
    const origins: string[] = [];
    for (const item of input.grantAllowedOrigins.slice(0, 500)) {
      try {
        if (typeof item !== 'string') throw new Error('not a string');
        const origin = new URL(item).origin;
        if (origin === 'null' || !/^https?:/.test(origin)) throw new Error('not HTTP(S)');
        origins.push(origin);
      } catch {
        warnings.push('grantAllowedOrigins 包含无效 origin');
      }
    }
    policy.grantAllowedOrigins = [...new Set(origins)];
  }
  return { managed: Object.keys(input).length > 0, policy, warnings: [...new Set(warnings)] };
}

export function applyPolicyToBridge(config: BridgeConfig, policy: EnterprisePolicy): BridgeConfig {
  const transport = policy.disableWebSocket ? 'native' : policy.bridgeTransport || config.transport;
  return {
    ...config,
    transport,
    endpoint: policy.bridgeEndpoint || config.endpoint,
    nativeHost: policy.nativeHost || config.nativeHost,
    autoConnect: policy.autoConnect ?? config.autoConnect,
  };
}

export function applyPolicyToState(state: ExtensionState, policy: EnterprisePolicy): ExtensionState {
  return {
    ...state,
    bridge: applyPolicyToBridge(state.bridge, policy),
    floatingPanel: {
      ...state.floatingPanel,
      enabled: policy.floatingPanelEnabled ?? state.floatingPanel.enabled,
    },
  };
}

export function assertGrantPolicy(
  policy: EnterprisePolicy,
  input: { durationMinutes: number; origins: string[]; programEval: boolean },
): number {
  if (input.programEval && policy.allowProgramEval === false) {
    throw new ExtensionError('policy_denied', '企业策略禁止 browser.page.eval.program');
  }
  if (policy.grantAllowedOrigins?.length) {
    const denied = input.origins.find((origin) => !policy.grantAllowedOrigins!.includes(origin));
    if (denied) throw new ExtensionError('policy_denied', `企业策略不允许授权 origin: ${denied}`);
  }
  return Math.min(input.durationMinutes, policy.maxGrantMinutes || input.durationMinutes);
}
