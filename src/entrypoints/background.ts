import { browser, type Browser } from 'wxt/browser';
import {ContentActionType, ProxyActionType} from '@/types/action';
import { getCurrentProxyMode, switchProxyMode } from '@/utils/proxy';

export default defineBackground({
  type: 'module',
  
  main() {
    // 初始化代理状态监听
    browser.runtime.onMessage.addListener((message: any, sender: Browser.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      if (message.action === ProxyActionType.GET_PROXY_STATUS) {
        // 获取当前代理状态
        getCurrentProxyMode().then(mode => {
          sendResponse({ success: true, data: { mode } });
        });
        return true;
      } else if (message.action === ProxyActionType.SWITCH_PROXY) {
        // 切换代理
        switchProxyMode(message.mode).then(success => {
          sendResponse({ success });
          
          // 如果切换成功，广播代理状态更改消息
          if (success) {
            browser.runtime.sendMessage({
              action: ContentActionType.PROXY_CONFIGS_UPDATED,
              source: 'background'
            });
          }
        });
        return true;
      }
    });
    
    console.log('代理管理后台服务已启动');
  },
});
