import type { ProxyConditionType, ProxyProfile, ProxyRuleSourceFormat } from '@/types/models';

export const PROXY_KIND_LABELS: Record<ProxyProfile['kind'], string> = {
  direct: '直接连接',
  system: '系统代理',
  fixed_servers: '固定代理',
  pac_script: 'PAC Script',
};

export const CONDITION_LABELS: Record<ProxyConditionType, string> = {
  host_exact: '精确域名',
  host_suffix: '域名及子域',
  host_wildcard: '域名通配符',
  host_regex: '域名正则',
  url_prefix: 'URL 前缀',
  url_wildcard: 'URL 通配符',
  url_regex: 'URL 正则',
  keyword: 'URL 关键词',
};

export const SOURCE_FORMAT_LABELS: Record<ProxyRuleSourceFormat, string> = {
  auto: '自动识别',
  autoproxy: 'AutoProxy / GFWList',
  switchyomega: 'SwitchyOmega Conditions',
  hosts: '域名 / Hosts 列表',
};

export function proxyProfileDetail(profile: ProxyProfile): string {
  if (profile.kind === 'fixed_servers') return `${profile.scheme || 'http'}://${profile.host}:${profile.port}`;
  if (profile.kind === 'pac_script') return profile.pacUrl || '内联 PAC';
  return PROXY_KIND_LABELS[profile.kind];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes > 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function relativeTime(timestamp?: number): string {
  if (!timestamp) return '尚未更新';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString();
}
