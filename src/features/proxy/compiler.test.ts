import { describe, expect, it } from 'vitest';
import type {
  NormalizedProxyRule, ProxyProfile, ProxyRule, ProxyRuleSource,
} from '@/types/models';
import {
  compileProxyRules, previewProxyRules, profileToPac, proxyConditionMatches, type ProxyCompilationInput,
} from './compiler';

const profiles: ProxyProfile[] = [
  { id: 'direct', name: 'Direct', kind: 'direct', bypass: [] },
  { id: 'mitm', name: 'MITM', kind: 'fixed_servers', scheme: 'http', host: '127.0.0.1', port: 8083, bypass: [] },
];

function manualRule(id: string, order: number, type: ProxyRule['condition']['type'], value: string, profileId = 'mitm'): ProxyRule {
  return {
    id, name: id, enabled: true, condition: { type, value }, proxyProfileId: profileId,
    order, createdAt: 1, updatedAt: 1,
  };
}

function source(overrides: Partial<ProxyRuleSource> = {}): ProxyRuleSource {
  return {
    id: 'source', name: 'Source', url: 'https://example.test/rules.txt', format: 'hosts', enabled: true,
    matchProfileId: 'mitm', bypassProfileId: 'direct', order: 0, updateIntervalMinutes: 720,
    revision: 'revision-1', status: 'ready', totalRuleCount: 0, supportedRuleCount: 0,
    ignoredRuleCount: 0, invalidRuleCount: 0, ...overrides,
  };
}

function compilationInput(
  manualRules: ProxyRule[] = [],
  sources: ProxyRuleSource[] = [],
  sourceRules = new Map<string, NormalizedProxyRule[]>(),
): ProxyCompilationInput {
  return {
    manualRules, sources, sourceRules, profiles,
    routing: { defaultProfileId: 'direct', failMode: 'closed' },
  };
}

function executePac(pacScript: string, url: string): string {
  const dnsDomainIs = (host: string, suffix: string) => host.endsWith(suffix);
  const resolver = new Function('dnsDomainIs', `${pacScript};return FindProxyForURL;`)(dnsDomainIs) as (rawUrl: string, host: string) => string;
  return resolver(url, new URL(url).hostname);
}

describe('proxy compiler', () => {
  it('encodes every fixed proxy scheme and the explicit fail-open fallback', () => {
    const fixed = (scheme: NonNullable<ProxyProfile['scheme']>) => ({
      id: scheme, name: scheme, kind: 'fixed_servers' as const, scheme,
      host: '127.0.0.1', port: 2080, bypass: [],
    });
    expect(profileToPac(fixed('http'))).toBe('PROXY 127.0.0.1:2080');
    expect(profileToPac(fixed('https'))).toBe('HTTPS 127.0.0.1:2080');
    expect(profileToPac(fixed('socks4'))).toBe('SOCKS 127.0.0.1:2080');
    expect(profileToPac(fixed('socks5'))).toBe('SOCKS5 127.0.0.1:2080');
    expect(profileToPac(fixed('socks5'), 'open')).toBe('SOCKS5 127.0.0.1:2080; DIRECT');
  });

  it('matches all structured condition families', () => {
    expect(proxyConditionMatches({ type: 'host_exact', value: 'api.example.test' }, 'https://api.example.test/path')).toBe(true);
    expect(proxyConditionMatches({ type: 'host_suffix', value: 'example.test' }, 'https://a.example.test/path')).toBe(true);
    expect(proxyConditionMatches({ type: 'host_wildcard', value: 'api?.example.test' }, 'https://api1.example.test/')).toBe(true);
    expect(proxyConditionMatches({ type: 'url_prefix', value: 'https://example.test/api/' }, 'https://example.test/api/1')).toBe(true);
    expect(proxyConditionMatches({ type: 'url_wildcard', value: '*://*.example.test/*' }, 'https://api.example.test/1')).toBe(true);
    expect(proxyConditionMatches({ type: 'keyword', value: '/login?' }, 'https://example.test/login?next=/')).toBe(true);
    expect(proxyConditionMatches({ type: 'host_exact', value: 'example.test' }, 'not-a-url')).toBe(false);
  });

  it('keeps deterministic manual order in the generated PAC', () => {
    const input = compilationInput([
      manualRule('API through MITM', 0, 'host_exact', 'api.example.test'),
      manualRule('Example direct', 1, 'host_suffix', 'example.test', 'direct'),
    ]);
    const artifact = compileProxyRules(input);
    expect(executePac(artifact.pacScript, 'https://api.example.test/')).toBe('PROXY 127.0.0.1:8083');
    expect(executePac(artifact.pacScript, 'https://www.example.test/')).toBe('DIRECT');
    expect(artifact.manualRuleCount).toBe(2);
  });

  it('compiles subscription exceptions before a shared host trie', () => {
    const rules: NormalizedProxyRule[] = [
      { sourceId: 'source', ordinal: 0, condition: { type: 'host_exact', value: 'allowed.example.test' }, exception: true, raw: '@@||allowed.example.test^' },
      { sourceId: 'source', ordinal: 1, condition: { type: 'host_suffix', value: 'example.test' }, exception: false, raw: '||example.test^' },
    ];
    const input = compilationInput([], [source({ supportedRuleCount: rules.length })], new Map([['source', rules]]));
    const artifact = compileProxyRules(input);
    expect(executePac(artifact.pacScript, 'https://allowed.example.test/')).toBe('DIRECT');
    expect(executePac(artifact.pacScript, 'https://blocked.example.test/')).toBe('PROXY 127.0.0.1:8083');
    expect(artifact.sourceRuleCount).toBe(2);
    expect((artifact.pacScript.match(/function FindProxyForURL/g) || [])).toHaveLength(1);
  });

  it('explains the winning rule and fallback route', () => {
    const input = compilationInput([manualRule('API', 0, 'host_exact', 'api.example.test')]);
    const matched = previewProxyRules('https://api.example.test/', input);
    expect(matched.matchedKind).toBe('manual');
    expect(matched.matchedName).toBe('API');
    expect(matched.effectiveProfileId).toBe('mitm');
    const fallback = previewProxyRules('https://other.test/', input);
    expect(fallback.matchedKind).toBe('default');
    expect(fallback.effectiveProfileId).toBe('direct');
  });

  it('rejects invalid regular expressions before changing browser proxy state', () => {
    const input = compilationInput([manualRule('Broken regex', 0, 'host_regex', '([a-z')]);
    expect(() => compileProxyRules(input)).toThrow('无效的域名正则表达式');
  });

  it('rejects unknown SwitchyOmega result profile names', () => {
    const customRule: NormalizedProxyRule = {
      sourceId: 'source', ordinal: 0, condition: { type: 'host_suffix', value: 'example.test' },
      exception: false, raw: 'example.test +Missing', resultProfileName: 'Missing',
    };
    const input = compilationInput([], [source()], new Map([['source', [customRule]]]));
    expect(() => compileProxyRules(input)).toThrow('引用了未知或不可路由的出口');
  });

  it('compiles 50,000 domain rules into one compact trie within the PAC budget', () => {
    const rules: NormalizedProxyRule[] = Array.from({ length: 50_000 }, (_, ordinal) => ({
      sourceId: 'source', ordinal, condition: { type: 'host_suffix', value: `domain-${ordinal}.example` },
      exception: false, raw: `||domain-${ordinal}.example^`,
    }));
    const input = compilationInput([], [source({ supportedRuleCount: rules.length })], new Map([['source', rules]]));
    const startedAt = performance.now();
    const artifact = compileProxyRules(input);
    const elapsed = performance.now() - startedAt;
    expect(artifact.sourceRuleCount).toBe(50_000);
    expect(artifact.compiledBytes).toBeLessThan(4 * 1024 * 1024);
    expect(elapsed).toBeLessThan(5_000);
    expect(executePac(artifact.pacScript, 'https://domain-49999.example/')).toBe('PROXY 127.0.0.1:8083');
  });

  it('compiles a production-size SwitchyOmega wildcard subscription without exhausting the PAC parser stack', () => {
    const rules: NormalizedProxyRule[] = Array.from({ length: 112_000 }, (_, ordinal) => ({
      sourceId: 'source', ordinal, condition: { type: 'host_wildcard', value: `*.domain-${ordinal}.example` },
      exception: false, raw: `*.domain-${ordinal}.example`,
    }));
    const input = compilationInput([], [source({ supportedRuleCount: rules.length })], new Map([['source', rules]]));
    const artifact = compileProxyRules(input);
    expect(artifact.sourceRuleCount).toBe(112_000);
    expect(artifact.compiledBytes).toBeLessThan(4 * 1024 * 1024);
    expect(executePac(artifact.pacScript, 'https://www.domain-111999.example/')).toBe('PROXY 127.0.0.1:8083');
    expect(executePac(artifact.pacScript, 'https://domain-111999.example/')).toBe('DIRECT');
    const preview = previewProxyRules('https://www.domain-111999.example/', input);
    expect(preview).toMatchObject({ matchedKind: 'source', effectiveProfileId: 'mitm' });
  });
});
