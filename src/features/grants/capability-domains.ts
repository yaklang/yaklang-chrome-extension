export type CapabilityDomainId =
  | 'navigation-isolation'
  | 'authorization'
  | 'handoff'
  | 'network'
  | 'recording-callable-debugger'
  | 'transform'
  | 'page'
  | 'proxy';

export interface CapabilityDomainDefinition {
  id: CapabilityDomainId;
  owns(method: string): boolean;
}

function exactMethods(id: CapabilityDomainId, methods: readonly string[]): CapabilityDomainDefinition {
  const owned = new Set(methods);
  return { id, owns: (method) => owned.has(method) };
}

export const NAVIGATION_CAPABILITY_DOMAIN = exactMethods('navigation-isolation', [
  'browser.tabs',
  'browser.frames',
  'browser.isolation.inspect',
  'browser.isolation.proof',
  'browser.isolation.incognito.open',
  'browser.isolation.container.open',
  'browser.isolation.container.list',
  'browser.isolation.container.remove',
]);

export const AUTHORIZATION_CAPABILITY_DOMAIN: CapabilityDomainDefinition = {
  id: 'authorization',
  owns: (method) => method.startsWith('browser.authorization.'),
};

export const HANDOFF_CAPABILITY_DOMAIN: CapabilityDomainDefinition = {
  id: 'handoff',
  owns: (method) => method.startsWith('browser.handoff.'),
};

export const NETWORK_CAPABILITY_DOMAIN: CapabilityDomainDefinition = {
  id: 'network',
  owns: (method) => method.startsWith('browser.network.'),
};

export const RECORDING_CAPABILITY_DOMAIN: CapabilityDomainDefinition = {
  id: 'recording-callable-debugger',
  owns: (method) => method.startsWith('browser.recording.')
    || method.startsWith('browser.callable.')
    || method.startsWith('browser.deep_capture.'),
};

export const TRANSFORM_CAPABILITY_DOMAIN: CapabilityDomainDefinition = {
  id: 'transform',
  owns: (method) => method === 'browser.packet.compare'
    || method.startsWith('browser.profile.')
    || method.startsWith('browser.transform.'),
};

export const PAGE_CAPABILITY_DOMAIN = exactMethods('page', [
  'browser.context',
  'browser.node.inspect',
  'browser.node.action',
  'browser.cookies',
  'browser.takeover',
  'browser.invoke',
  'browser.eval',
]);

export const PROXY_CAPABILITY_DOMAIN = exactMethods('proxy', [
  'proxy.list',
  'proxy.switch',
]);

export const CAPABILITY_DOMAINS: readonly CapabilityDomainDefinition[] = [
  NAVIGATION_CAPABILITY_DOMAIN,
  AUTHORIZATION_CAPABILITY_DOMAIN,
  HANDOFF_CAPABILITY_DOMAIN,
  NETWORK_CAPABILITY_DOMAIN,
  RECORDING_CAPABILITY_DOMAIN,
  TRANSFORM_CAPABILITY_DOMAIN,
  PAGE_CAPABILITY_DOMAIN,
  PROXY_CAPABILITY_DOMAIN,
];

export function capabilityDomainOwners(method: string): CapabilityDomainDefinition[] {
  return CAPABILITY_DOMAINS.filter((domain) => domain.owns(method));
}
