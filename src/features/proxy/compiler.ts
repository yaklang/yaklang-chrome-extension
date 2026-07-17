import type { ProxyProfile, ProxyRoutingSettings, ProxyRule, ProxyRulePreview } from '@/types/models';

function profileToPac(profile: ProxyProfile, failMode: ProxyRoutingSettings['failMode'] = 'closed'): string {
  if (profile.kind === 'direct') return 'DIRECT';
  if (profile.kind === 'system' || profile.kind === 'pac_script') throw new Error(`${profile.name} 不能嵌套到规则 PAC 中`);
  const host = profile.host || '127.0.0.1';
  const port = profile.port || 8083;
  const proxy = profile.scheme === 'socks4' ? `SOCKS ${host}:${port}`
    : profile.scheme === 'socks5' ? `SOCKS5 ${host}:${port}`
      : profile.scheme === 'https' ? `HTTPS ${host}:${port}` : `PROXY ${host}:${port}`;
  return failMode === 'open' ? `${proxy}; DIRECT` : proxy;
}

function pacLiteral(value: string): string {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function sortedProxyRules(rules: ProxyRule[]): ProxyRule[] {
  return [...rules].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function pacCondition(rawPattern: string): string {
  const pattern = rawPattern.trim();
  if (!pattern) return '';
  if (pattern.includes('://') || pattern.includes('/')) return `shExpMatch(url, ${pacLiteral(pattern)})`;
  if (pattern.startsWith('*.')) {
    const domain = pattern.slice(2);
    return `(host === ${pacLiteral(domain)} || dnsDomainIs(host, ${pacLiteral(`.${domain}`)}))`;
  }
  if (pattern.includes('*') || pattern.includes('?')) return `shExpMatch(host, ${pacLiteral(pattern)})`;
  return `(host === ${pacLiteral(pattern)} || dnsDomainIs(host, ${pacLiteral(`.${pattern}`)}))`;
}

export function compileProxyRules(
  rules: ProxyRule[],
  profiles: ProxyProfile[],
  routing: ProxyRoutingSettings = { defaultProfileId: 'direct', failMode: 'closed' },
): string {
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  const branches = sortedProxyRules(rules)
    .filter((rule) => rule.enabled && rule.patterns.length > 0)
    .flatMap((rule) => {
      const profile = profileMap.get(rule.proxyProfileId);
      if (!profile) return [];
      const conditions = rule.patterns.map(pacCondition).filter(Boolean);
      return conditions.length > 0 ? [`  // ${rule.name} [priority=${rule.priority}]\n  if (${conditions.join(' || ')}) return ${pacLiteral(profileToPac(profile, routing.failMode))};`] : [];
    });
  const fallback = profileMap.get(routing.defaultProfileId) || profileMap.get('direct');
  return `function FindProxyForURL(url, host) {\n${branches.join('\n')}\n  return ${pacLiteral(fallback ? profileToPac(fallback, routing.failMode) : 'DIRECT')};\n}`;
}

function wildcardRegexp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i');
}

export function proxyPatternMatches(rawPattern: string, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const pattern = rawPattern.trim();
    if (!pattern) return false;
    if (pattern.includes('://') || pattern.includes('/')) return wildcardRegexp(pattern).test(rawUrl);
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2).toLowerCase();
      return url.hostname.toLowerCase() === domain || url.hostname.toLowerCase().endsWith(`.${domain}`);
    }
    if (pattern.includes('*') || pattern.includes('?')) return wildcardRegexp(pattern).test(url.hostname);
    return url.hostname.toLowerCase() === pattern.toLowerCase() || url.hostname.toLowerCase().endsWith(`.${pattern.toLowerCase()}`);
  } catch {
    return false;
  }
}

export function previewProxyRules(
  url: string,
  rules: ProxyRule[],
  profiles: ProxyProfile[],
  routing: ProxyRoutingSettings,
): ProxyRulePreview {
  const matches = sortedProxyRules(rules).filter((rule) => rule.enabled && rule.patterns.some((pattern) => proxyPatternMatches(pattern, url)));
  const profileIds = [...new Set(matches.map((rule) => rule.proxyProfileId))];
  const effectiveProfileId = matches[0]?.proxyProfileId || routing.defaultProfileId;
  const profile = profiles.find((item) => item.id === effectiveProfileId) || profiles.find((item) => item.id === 'direct')!;
  return {
    url,
    matchedRuleIds: matches.map((rule) => rule.id),
    effectiveRuleId: matches[0]?.id,
    effectiveProfileId: profile.id,
    effectiveProxy: profileToPac(profile, routing.failMode),
    conflict: profileIds.length > 1,
    conflictProfileIds: profileIds,
  };
}
