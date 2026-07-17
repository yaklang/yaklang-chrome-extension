import { describe, expect, it } from 'vitest';
import type { ProxyProfile, ProxyRule } from '@/types/models';
import { compileProxyRules, previewProxyRules, proxyPatternMatches } from './compiler';

const profiles: ProxyProfile[] = [
  { id: 'direct', name: 'Direct', kind: 'direct', bypass: [] },
  { id: 'mitm', name: 'MITM', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8083, bypass: [] },
];
const rules: ProxyRule[] = [
  { id: 'low', name: 'Low', enabled: true, patterns: ['*.example.test'], proxyProfileId: 'direct', priority: 10 },
  { id: 'high', name: 'High', enabled: true, patterns: ['api.example.test'], proxyProfileId: 'mitm', priority: 20 },
];

describe('proxy compiler', () => {
  it('matches exact, subdomain, wildcard and URL patterns', () => {
    expect(proxyPatternMatches('example.test', 'https://api.example.test/path')).toBe(true);
    expect(proxyPatternMatches('*.example.test', 'https://example.test/path')).toBe(true);
    expect(proxyPatternMatches('api?.example.test', 'https://api1.example.test/')).toBe(true);
    expect(proxyPatternMatches('https://*/api/*', 'https://api.example.test/api/1')).toBe(true);
    expect(proxyPatternMatches('example.test', 'not-a-url')).toBe(false);
  });

  it('orders PAC branches by priority and applies fail-open', () => {
    const pac = compileProxyRules(rules, profiles, { defaultProfileId: 'direct', failMode: 'open' });
    expect(pac.indexOf('High [priority=20]')).toBeLessThan(pac.indexOf('Low [priority=10]'));
    expect(pac).toContain('PROXY 127.0.0.1:8083; DIRECT');
    expect(pac.trim().endsWith('}')).toBe(true);
  });

  it('reports deterministic conflicts and winner', () => {
    const preview = previewProxyRules('https://api.example.test/', rules, profiles, { defaultProfileId: 'direct', failMode: 'closed' });
    expect(preview.conflict).toBe(true);
    expect(preview.matchedRuleIds).toEqual(['high', 'low']);
    expect(preview.effectiveProfileId).toBe('mitm');
  });
});
