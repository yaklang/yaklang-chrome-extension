import { defineConfig } from 'wxt';

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
    version: '0.2.0',
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
    ...(browser !== 'firefox' ? { incognito: 'spanning' as const } : {}),
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
