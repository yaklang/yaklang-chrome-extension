import type { UserAgentProfile } from '@/types/models';

export const BUILTIN_USER_AGENT_PROFILES: readonly UserAgentProfile[] = [
  {
    id: 'chrome-windows', name: 'Chrome / Windows', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  },
  {
    id: 'chrome-macos', name: 'Chrome / macOS', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  },
  {
    id: 'edge-windows', name: 'Edge / Windows', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
  },
  {
    id: 'firefox-windows', name: 'Firefox / Windows', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0',
  },
  {
    id: 'firefox-linux', name: 'Firefox / Linux', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0',
  },
  {
    id: 'safari-macos', name: 'Safari / macOS', category: 'desktop', builtin: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  },
  {
    id: 'safari-iphone', name: 'Safari / iPhone', category: 'mobile', builtin: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'safari-ipad', name: 'Safari / iPad', category: 'mobile', builtin: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'chrome-android', name: 'Chrome / Android', category: 'mobile', builtin: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  },
  {
    id: 'googlebot', name: 'Googlebot', category: 'bot', builtin: true,
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },
] as const;

export function getUserAgentProfiles(custom: UserAgentProfile[]): UserAgentProfile[] {
  return [...BUILTIN_USER_AGENT_PROFILES.map((profile) => ({ ...profile })), ...custom.map((profile) => ({ ...profile }))];
}
