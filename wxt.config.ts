import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Yaklang 代理管理',
    description: '一个用于快速切换浏览器代理设置的扩展',
    version: '0.1.0',
    permissions: [
      'proxy',
      'storage',
      'tabs'
    ],
    host_permissions: [
      '<all_urls>'
    ],
    web_accessible_resources: [
      {
        resources: ['yak.svg'],
        matches: ['<all_urls>']
      }
    ],
    icons: {
      "16": "icon/icon16.png",
      "48": "icon/icon48.png",
      "128": "icon/icon128.png"
    },
  }
});
