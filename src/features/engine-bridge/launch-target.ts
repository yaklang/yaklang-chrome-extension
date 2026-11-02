import type { BridgeConfig, BridgeLaunchTarget, DiscoveredYakEngine } from '@/types/models';

export function bindLaunchTarget(config: BridgeConfig, target: BridgeLaunchTarget): BridgeConfig {
  const previous = config.pairedEngine && { ...config.pairedEngine,
    frontendId: config.pairedEngine.frontendId || config.launchTarget?.frontendId
      || (target.mode === 'engine' && config.endpoint === target.endpoint ? target.frontendId : undefined) };
  const records = [...new Map([...(config.trustedEngines || []), ...(previous ? [previous] : [])]
    .map((engine) => [`${engine.engineIdentityId}:${engine.frontendId || ''}`, engine])).values()].slice(-32);
  return { ...config, launchTarget: target, transport: 'websocket', autoConnect: target.mode === 'engine',
    endpoint: target.mode === 'engine' ? target.endpoint! : config.endpoint,
    trustedEngines: records,
    pairedEngine: target.mode === 'engine' ? records.find((engine) => engine.engineIdentityId === target.engineIdentityId
      && engine.frontendId === target.frontendId) : undefined,
  };
}

export function normalizeLaunchTarget(value: unknown): BridgeLaunchTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'none' };
  const target = value as Record<string, unknown>;
  if (target.mode === 'none') return { mode: 'none' };
  if (target.mode !== 'engine') return { mode: 'none' };
  for (const key of ['engineIdentityId', 'engineInstanceId', 'frontendId', 'frontendName', 'endpoint']) {
    if (typeof target[key] !== 'string' || !target[key] || (target[key] as string).length > (key === 'endpoint' ? 2048 : 160)) return { mode: 'none' };
  }
  try {
    const url = new URL(target.endpoint as string);
    if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.pathname !== '/extension' || url.username || url.password || url.search || url.hash) return { mode: 'none' };
  } catch { return { mode: 'none' }; }
  return {
    mode: 'engine', engineIdentityId: target.engineIdentityId as string, engineInstanceId: target.engineInstanceId as string,
    frontendId: target.frontendId as string, frontendName: target.frontendName as string, endpoint: target.endpoint as string,
  };
}

export function selectLaunchTarget(target: BridgeLaunchTarget, engines: DiscoveredYakEngine[]): DiscoveredYakEngine {
  const matches = engines.filter((engine) => engine.engineIdentityId === target.engineIdentityId
    && (engine.frontendId || 'yak') === target.frontendId);
  const exact = matches.find((engine) => engine.engineInstanceId === target.engineInstanceId);
  if (exact) return exact;
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length > 1
    ? `${target.frontendName} 有多个引擎实例，请在 YTray 中重新选择接入目标`
    : `等待所选的 ${target.frontendName} 引擎启动；不会自动连接其他引擎`);
}
