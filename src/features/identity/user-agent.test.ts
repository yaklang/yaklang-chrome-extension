import { vi, describe, expect, it } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { declarativeNetRequest: {} } }));

import {
  buildUserAgentDnrRules, resolveUserAgent, userAgentHostname, validateUserAgent,
} from './user-agent';
import { BUILTIN_USER_AGENT_PROFILES } from './user-agent-profiles';
import type { UserAgentAssignment, UserAgentProfile } from '@/types/models';

const assignment: UserAgentAssignment = {
  id: 'assignment-1', hostname: 'app.example.test', profileId: 'chrome-windows', createdAt: 1, updatedAt: 2,
};

describe('User-Agent site assignments', () => {
  it('compiles one real request-header rule for each hostname', () => {
    const [rule] = buildUserAgentDnrRules([assignment]);
    expect(rule.condition.urlFilter).toBe('||app.example.test^');
    expect(rule.condition.resourceTypes).toContain('websocket');
    expect(rule.action).toMatchObject({ requestHeaders: [{ header: 'user-agent', operation: 'set' }] });
  });

  it('deduplicates a hostname and ignores missing profiles', () => {
    const rules = buildUserAgentDnrRules([
      assignment,
      { ...assignment, id: 'assignment-2', profileId: 'safari-iphone', updatedAt: 3 },
      { ...assignment, id: 'missing', hostname: 'missing.example.test', profileId: 'missing' },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toMatchObject({
      requestHeaders: [{ value: BUILTIN_USER_AGENT_PROFILES.find((item) => item.id === 'safari-iphone')!.userAgent }],
    });
  });

  it('resolves the effective profile for the current URL', () => {
    expect(resolveUserAgent('https://app.example.test/path', [assignment], [], 'Browser/Default'))
      .toMatchObject({ hostname: 'app.example.test', mode: 'override', profile: { id: 'chrome-windows' } });
    expect(resolveUserAgent('https://other.example.test/', [assignment], [], 'Browser/Default'))
      .toEqual({ hostname: 'other.example.test', mode: 'default', userAgent: 'Browser/Default' });
  });

  it('supports custom profiles and rejects unsafe header values', () => {
    const custom: UserAgentProfile = {
      id: 'custom-1', name: 'Custom', userAgent: 'Yakit-Test/1.0', category: 'custom', builtin: false,
    };
    expect(buildUserAgentDnrRules([{ ...assignment, profileId: custom.id }], [custom])[0].action)
      .toMatchObject({ requestHeaders: [{ value: 'Yakit-Test/1.0' }] });
    expect(validateUserAgent('  Safe-UA/1.0  ')).toBe('Safe-UA/1.0');
    expect(() => validateUserAgent('Injected\r\nX-Test: yes')).toThrow('换行');
  });

  it('only accepts HTTP(S) targets', () => {
    expect(userAgentHostname('http://127.0.0.1:8080/path')).toBe('127.0.0.1');
    expect(() => userAgentHostname('chrome://extensions')).toThrow('HTTP');
  });
});
