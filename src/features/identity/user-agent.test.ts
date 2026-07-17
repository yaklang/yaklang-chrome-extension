import { vi, describe, expect, it } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { declarativeNetRequest: {} } }));

import { buildUserAgentDnrRules } from './user-agent';

describe('User-Agent DNR rules', () => {
  it('normalizes domains and covers browser request resource types', () => {
    const [rule] = buildUserAgentDnrRules([{
      id: 'ua-1', name: 'Test', enabled: true, userAgent: 'Yakit-E2E/1.0', domains: ['https://*.example.test/path'],
    }]);
    expect(rule.condition.urlFilter).toBe('||example.test^');
    expect(rule.condition.resourceTypes).toContain('websocket');
    expect(rule.action).toMatchObject({ requestHeaders: [{ header: 'user-agent', operation: 'set', value: 'Yakit-E2E/1.0' }] });
  });

  it('ignores disabled rules', () => {
    expect(buildUserAgentDnrRules([{ id: 'x', name: 'X', enabled: false, userAgent: 'x', domains: [] }])).toHaveLength(0);
  });
});
