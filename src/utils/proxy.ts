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
 * 检查浏览器是否支持代理API
 * @returns 是否支持代理API
 */
function hasProxySupport(): boolean {
  return browser.proxy !== undefined && browser.proxy.settings !== undefined;
}

/**
 * 检测当前浏览器是否为 Firefox
 * @returns 是否为 Firefox 浏览器
 */
function isFirefox(): boolean {
  // 使用 WXT 提供的环境变量检测浏览器
  if (typeof import.meta.env !== 'undefined') {
    // 首选方式：使用 WXT 的内置环境变量
    if (import.meta.env.FIREFOX !== undefined) {
      return Boolean(import.meta.env.FIREFOX);
    }
    if (import.meta.env.BROWSER === 'firefox') {
      return true;
    }
  }
  return false;
}

/**
 * 修复Firefox和Chrome的代理配置差异
 * @param config 代理配置
 * @returns 浏览器特定的代理配置
 */
function createBrowserProxyConfig(config: ProxyConfig): any {
  // 不同浏览器的代理配置格式
  const firefoxBrowser = isFirefox();
  
  if (config.proxyType === 'direct') {
    return null; // 直接连接模式返回null，由clear方法处理
  } else if (config.proxyType === 'system') {
    // 系统代理模式对两种浏览器都一样
    return { mode: 'system' };
  } else if (config.proxyType === 'fixed_servers') {
    if (firefoxBrowser) {
      // Firefox格式
      const proxyConfig: any = {
        proxyType: 'manual'
      };
      
      if (config.scheme === 'http' || config.scheme === 'https') {
        proxyConfig.http = `${config.scheme}://${config.host}:${config.port}`;
        proxyConfig.ssl = `${config.scheme}://${config.host}:${config.port}`;
        proxyConfig.httpProxyAll = true;
      } else if (config.scheme === 'socks4' || config.scheme === 'socks5') {
        proxyConfig.socks = `${config.host}:${config.port}`;
        proxyConfig.socksVersion = config.scheme === 'socks4' ? 4 : 5;
        proxyConfig.proxyDNS = true;
      }
      
      // 设置绕过代理的列表
      if (config.bypassList && config.bypassList.length > 0) {
        proxyConfig.passthrough = config.bypassList.join(', ');
      }
      
      return proxyConfig;
    } else {
      // Chrome格式
      const proxyConfig: any = {
        mode: 'fixed_servers',
        rules: {}
      };
      
      // 添加代理规则
      const proxyRule = {
        scheme: config.scheme,
        host: config.host || '',
        port: config.port || 80
      };
      
      // 设置代理规则
      proxyConfig.rules = {
        singleProxy: proxyRule,
        bypassList: config.bypassList || ['localhost', '127.0.0.1']
      };
      
      return proxyConfig;
    }
  } else if (config.proxyType === 'pac_script') {
    if (firefoxBrowser) {
      // Firefox格式
      return {
        proxyType: 'autoConfig',
        autoConfigUrl: config.pacScript?.url,
        autoLogin: true
      };
    } else {
      // Chrome格式
      return {
        mode: 'pac_script',
        pacScript: config.pacScript
      };
    }
  }
  
  return null;
}

/**
 * 切换到指定的代理模式
 * @param mode 代理模式（ID, direct, 或 system）
 * @returns 是否成功切换
 */
export async function switchProxyMode(mode: string): Promise<boolean> {
  try {
    // 检查代理API是否可用
    if (!hasProxySupport()) {
      console.error('Proxy API not supported in this browser');
      return false;
    }

    // 获取对应的代理配置
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
    } else {
      // 获取浏览器特定的代理配置
      const proxyConfig = createBrowserProxyConfig(config);
      
      if (proxyConfig !== null) {
        // 应用代理设置
        await browser.proxy.settings.set({
          value: proxyConfig,
          scope: 'regular'
        });
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error switching to proxy mode ${mode}:`, error);
    
    // 更详细的错误信息
    if (typeof error === 'object' && error !== null) {
      console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    
    return false;
  }
} 