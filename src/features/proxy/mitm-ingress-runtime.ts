import type { ProxyProfile } from '@/types/models';

export interface ManagedMITMRoute {
  proxyHost: string;
  proxyPort: number;
  host: string;
  port: number;
  expiresAt: number;
  engineIdentityId: string;
  instanceId: string;
}

let routes: ManagedMITMRoute[] = [];

export const managedMITMRoutes = (): ManagedMITMRoute[] => routes;
export const replaceManagedMITMRoutes = (next: ManagedMITMRoute[]): void => { routes = next; };

export function proxyWithMITMIngress(profile: ProxyProfile): ProxyProfile {
  if (profile.kind !== 'fixed_servers' || !['http', 'https'].includes(profile.scheme || 'http')) return profile;
  const route = routes.find((item) => item.proxyHost.toLowerCase() === (profile.host || '127.0.0.1').toLowerCase()
    && item.proxyPort === (profile.port || 8083));
  return route ? { ...profile, host: route.host, port: route.port } : profile;
}

export function startupProxyProfile(startupProxy?: string): ProxyProfile | undefined {
  if (!startupProxy || startupProxy === 'direct') return undefined;
  try {
    const url = new URL(startupProxy);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return { id: '', name: '启动代理', kind: 'fixed_servers', scheme: url.protocol === 'https:' ? 'https' : 'http',
      host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), bypass: [] };
  } catch { return undefined; }
}

export function sameMITMRouting(left: ManagedMITMRoute[], right: ManagedMITMRoute[]): boolean {
  const keys = (values: ManagedMITMRoute[]) => values.map(({ expiresAt: _, ...value }) => JSON.stringify(value)).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}
