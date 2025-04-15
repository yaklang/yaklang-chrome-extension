import { browser, type Browser } from 'wxt/browser';
import {ContentActionType, ProxyActionType} from '@/types/action';
import { getCurrentProxyMode, switchProxyMode } from '@/utils/proxy';
import { getProxyConfig, saveProxyConfig } from '@/utils/storage';
import type { ProxyConfig } from '@/types/proxy';

// 固定的代理模式配置
const FIXED_MODES = [
  {
    id: 'direct',
    name: '[直接连接]',
    proxyType: 'direct',
    enabled: false
  },
  {
    id: 'system',
    name: '[系统代理]',
    proxyType: 'system',
    enabled: false
  }
];

export default defineBackground({
  type: 'module',
  
  async main() {
    // 初始化固定模式的代理配置
    await initializeFixedModes();
    
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

// 初始化固定模式的代理配置
async function initializeFixedModes() {
  try {
    // 确保固定模式的配置已保存到数据库
    for (const modeConfig of FIXED_MODES) {
      const existingConfig = await getProxyConfig(modeConfig.id);
      if (!existingConfig) {
        console.log(`初始化固定模式配置: ${modeConfig.id}`);
        await saveProxyConfig(modeConfig as ProxyConfig);
      }
    }
  } catch (error) {
    console.error('初始化固定模式配置失败:', error);
  }
}
