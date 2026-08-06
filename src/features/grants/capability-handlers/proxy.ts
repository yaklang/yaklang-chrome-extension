import type { CapabilityDomainHandler } from '../capability-context';
import { getState } from '@/platform/storage/state';
import { switchProxy } from '@/features/proxy/service';
import { PROXY_CAPABILITY_DOMAIN } from '../capability-domains';

export const proxyCapabilityHandler: CapabilityDomainHandler = {
  ...PROXY_CAPABILITY_DOMAIN,
  async handle({ method, input }) {
    if (method === 'proxy.list') return (await getState()).proxyProfiles;
    if (typeof input.id !== 'string') throw new Error('缺少代理配置 ID');
    await switchProxy(input.id);
    return { activeProxyId: input.id };
  },
};
