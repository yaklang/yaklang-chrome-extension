import { browser } from 'wxt/browser';
import type { ProxyConfig } from '../types/proxy';
import { getAllProxyConfigs, getProxyConfig, enableProxyConfig, disableAllProxies, getCurrentProxy, setCurrentProxy } from './storage';

/**
 * 获取当前激活的代理模式
 * @returns 返回当前的代理模式（direct, system, 或代理ID）
 */
export async function getCurrentProxyMode(): Promise<string> {
  try {
    // 首先尝试从当前代理存储中获取
    const currentProxyConfig = await getCurrentProxy();
    if (currentProxyConfig) {
      return currentProxyConfig.id;
    }
    
    // 如果没有当前代理记录，则从配置列表查找已启用的代理
    const configs = await getAllProxyConfigs();
    const enabledProxy = configs.find(config => config.enabled);
    
    if (enabledProxy) {
      // 如果找到已启用的代理，更新当前代理存储
      await setCurrentProxy(enabledProxy);
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
      // 直接连接模式
      await browser.proxy.settings.clear({});
    } else if (config.proxyType === 'system') {
      // 系统代理模式
      await browser.proxy.settings.set({
        value: { mode: 'system' },
        scope: 'regular'
      });
    } else if (config.proxyType === 'fixed_servers') {
      // 固定服务器代理
      const proxyConfig = {
        mode: 'fixed_servers',
        rules: {}
      };
      
      // 添加代理规则
      const proxyRule = {
        scheme: config.scheme,
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
        bypassList: config.bypassList || ['localhost', '127.0.0.1']
      };
      
      // 应用代理设置
      await browser.proxy.settings.set({
        value: proxyConfig,
        scope: 'regular'
      });
    } else if (config.proxyType === 'pac_script') {
      // PAC脚本代理
      const pacConfig = {
        mode: 'pac_script',
        pacScript: config.pacScript
      };
      
      // 应用PAC脚本设置
      await browser.proxy.settings.set({
        value: pacConfig,
        scope: 'regular'
      });
    }
    
    return true;
  } catch (error) {
    console.error(`Error switching to proxy mode ${mode}:`, error);
    return false;
  }
} 