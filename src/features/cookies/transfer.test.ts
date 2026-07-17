import { vi, describe, expect, it } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import type { BrowserCookie } from '@/types/models';
import { buildCookieUrl, exportCookies } from './transfer';

const cookie = {
  name: 'session', value: 'secret-value', domain: '.example.test', path: '/', secure: true,
  httpOnly: true, hostOnly: false, session: false, sameSite: 'lax', storeId: '0',
} as BrowserCookie;

describe('Cookie transfer', () => {
  it('constructs a domain/path aware URL', () => {
    expect(buildCookieUrl('http://app.example.test/start', { domain: '.example.test', path: 'api', secure: true }))
      .toBe('https://example.test/api');
  });

  it('redacts exports unless values are explicitly requested', () => {
    expect(exportCookies([cookie], 'json', false)).toContain('[REDACTED]');
    expect(exportCookies([cookie], 'netscape', false)).not.toContain('secret-value');
    expect(exportCookies([cookie], 'set-cookie', true)).toContain('session=secret-value');
  });
});
