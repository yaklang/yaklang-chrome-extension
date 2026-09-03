import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// package.json is the single source of truth for the version; release
// packaging asserts the built manifest matches it.
const { version } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const CHROMIUM_EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1bj9d0jEOY87aT9nk4Ov7svZVnrFPD0dJsS39exzqMIJGMkGmqQ7J4TfFLlAV3Ckm9uszkMyw1oKKM/5ejd662B2uTcolHcSzmEVKLTGLvwUylWE6YJWcb3b5G88bzkcQepnNdz3gg3JvMhwPBNMk4qeSAHtX7u6S5zjoX4AyvQg5/qs29zViUTZoPcSEprJidaMilKwGxsJ5VpgtUXCE7JoKgadm/CK4iwJF5yCmKrkCi6xFwrt/qfrLAd6qXae7d5PDztxNyU+KSHX6FUHFfvJx9cmeIjIIJiZ35RHV78oT2beATSrU70uxg6in2JMy0z9SnpoV4euJ4Xyh6f/cwIDAQAB';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    build: {
      modulePreload: false,
    },
  }),
  manifest: ({ mode, browser }) => ({
    name: 'Yakit Browser Agent',
    description: 'Yakit 浏览器安全测试工具与 AI 上下文桥接',
    version,
    action: {
      default_title: 'Yakit Browser Agent',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    storage: {
      managed_schema: 'managed-storage-schema.json',
    },
    ...(browser !== 'firefox' ? { key: CHROMIUM_EXTENSION_KEY, incognito: 'spanning' as const } : {}),
    permissions: [
      'proxy',
      'storage',
      'unlimitedStorage',
      'alarms',
      'tabs',
      'scripting',
      'cookies',
      'declarativeNetRequest',
      'webRequest',
      'webNavigation',
      ...(browser === 'firefox' ? ['contextualIdentities' as const] : []),
      ...(browser === 'firefox' ? [] : ['debugger']),
      ...(browser === 'firefox' ? ['webRequestBlocking'] : ['webRequestAuthProvider']),
      ...(browser !== 'firefox' && ['production', 'store', 'enterprise'].includes(mode) ? ['userScripts'] : []),
    ],
    optional_permissions: ['nativeMessaging'],
    host_permissions: [
      '<all_urls>'
    ],
    browser_specific_settings: {
      gecko: {
        id: 'browser-agent@yaklang.com',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['authenticationInfo', 'browsingActivity', 'websiteActivity', 'websiteContent'],
        },
      },
    },
    icons: {
      '16': 'icon/icon16.png',
      '48': 'icon/icon48.png',
      '128': 'icon/icon128.png',
    },
    web_accessible_resources: [
      {
        resources: [
          ...((mode === 'store' || (browser !== 'firefox' && mode === 'production')) ? [] : ['page-main-world.js']),
          ...(browser === 'firefox' ? ['page-recorder-main-world.js'] : []),
          'floating.html', 'yak.svg', 'icon/yakitlogo.png',
        ],
        matches: ['<all_urls>'],
        use_dynamic_url: true,
      },
    ],
    ...(browser !== 'firefox' && ['production', 'store'].includes(mode) ? { minimum_chrome_version: '138' } : {}),
  }),
  hooks: {
    'entrypoints:resolved': (wxt, entrypoints) => {
      if (!(wxt.config.mode === 'store' || (wxt.config.browser !== 'firefox' && wxt.config.mode === 'production'))) return;
      const directEvalEntrypoint = entrypoints.find((entrypoint) => entrypoint.name === 'page-main-world');
      if (directEvalEntrypoint) directEvalEntrypoint.skipped = true;
    },
  },
});
