import { describe, expect, it } from 'vitest';
import { parseProxyRuleSource } from './parser';

describe('proxy rule source parser', () => {
  it('auto-detects and decodes base64 AutoProxy lists', () => {
    const source = '[AutoProxy 0.2]\n! comment\n@@||allowed.example.test^\n||blocked.example.test^\n';
    const parsed = parseProxyRuleSource(btoa(source), 'auto', 'gfw');
    expect(parsed.diagnostics.detectedFormat).toBe('autoproxy');
    expect(parsed.diagnostics.total).toBe(2);
    expect(parsed.diagnostics.supported).toBe(2);
    expect(parsed.rules[0]).toMatchObject({ exception: true, condition: { type: 'host_suffix', value: 'allowed.example.test' } });
    expect(parsed.rules[1]).toMatchObject({ exception: false, condition: { type: 'host_suffix', value: 'blocked.example.test' } });
  });

  it('preserves SwitchyOmega result profile names', () => {
    const parsed = parseProxyRuleSource(`
[SwitchyOmega Conditions]
@with result
HostWildcard: *.internal.example +Yakit MITM
UrlRegex: ^https://public\\.example/ +Direct
`, 'auto', 'omega');
    expect(parsed.diagnostics.detectedFormat).toBe('switchyomega');
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]).toMatchObject({
      condition: { type: 'host_wildcard', value: '*.internal.example' }, resultProfileName: 'Yakit MITM',
    });
    expect(parsed.rules[1]).toMatchObject({ condition: { type: 'url_regex' }, resultProfileName: 'Direct' });
  });

  it('normalizes hosts lists while reporting duplicates and invalid lines', () => {
    const parsed = parseProxyRuleSource(`
0.0.0.0 ads.example
ads.example
127.0.0.1 tracker.example # comment
10.20.30.40 api.internal.example auth.internal.example
not a valid hosts row
`, 'hosts', 'hosts');
    expect(parsed.rules.map((rule) => rule.condition.value)).toEqual([
      'ads.example', 'tracker.example', 'api.internal.example', 'auth.internal.example',
    ]);
    expect(parsed.diagnostics.total).toBe(6);
    expect(parsed.diagnostics.ignored).toBe(1);
    expect(parsed.diagnostics.invalid).toBe(1);
  });
});
