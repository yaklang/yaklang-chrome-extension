import { browser } from 'wxt/browser';
import type { ProxyConfig } from '../types/proxy';
import { getAllProxyConfigs, getProxyConfig, enableProxyConfig, disableAllProxies } from './storage';

/**
 * 获取当前激活的代理模式
 * @returns 返回当前的代理模式（direct, system, 或代理ID）
 */
export async function getCurrentProxyMode(): Promise<string> {
  try {
    const configs = await getAllProxyConfigs();
    const enabledProxy = configs.find(config => config.enabled);
    
    if (enabledProxy) {
      return enabledProxy.id;
    }
    
    // 如果没有启用的代理，返回直接连接模式
    return 'direct';
  } catch (error) {
    console.error('Error getting current proxy mode:', error);
    return 'direct';
  }
}

/**
 * 切换到指定的代理模式
 * @param mode 代理模式（ID, direct, 或 system）
 * @returns 是否成功切换
 */
export async function switchProxyMode(mode: string): Promise<boolean> {
  try {
    if (mode === 'direct') {
      // 清除所有代理设置
      await disableAllProxies();
      await browser.proxy.settings.clear({});
      return true;
    }
    
    if (mode === 'system') {
      // 使用系统代理
      await disableAllProxies();
      await browser.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
      return true;
    }
    
    // 使用自定义代理
    const config = await getProxyConfig(mode);
    if (!config) {
      console.error(`Proxy config with ID ${mode} not found`);
      return false;
    }
    
    // 启用选定的代理配置
    await enableProxyConfig(config.id);
    
    // 设置代理
    if (config.proxyType === 'direct') {
      await browser.proxy.settings.clear({});
    } else if (config.proxyType === 'system') {
      await browser.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
    } else {
      // 构建代理配置
      const proxyConfig = {
        mode: 'fixed_servers',
        rules: {}
      };
      
      // 添加代理规则
      const proxyRule = {
        scheme: config.proxyType,
        host: config.host || '',
        port: config.port || 80
      };
      
      // 添加认证信息
      // if (config.username && config.password) {
      //   proxyRule.username = config.username;
      //   proxyRule.password = config.password;
      // }
      
      // 设置代理规则
      proxyConfig.rules = {
        singleProxy: proxyRule,
        bypassList: ['localhost', '127.0.0.1']
      };
      
      // 应用代理设置
      await browser.proxy.settings.set({
        value: proxyConfig,
        scope: 'regular'
      });
    }
    
    return true;
  } catch (error) {
    console.error(`Error switching to proxy mode ${mode}:`, error);
    return false;
  }
} 