import type { ProxyConfig } from '../types/proxy';

// 数据库名称和存储名称
const DB_NAME = 'yaklang_extension';
const STORES = {
  PROXY_CONFIGS: 'proxy_configs',  // 代理配置列表存储
  CURRENT_PROXY: 'current_proxy',  // 当前代理配置存储
  PROXY_AUTH: 'proxy_auth'         // 代理认证信息存储
};

const DB_VERSION = 2; // 增加版本号以触发数据库升级

// 打开数据库
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // 检查并创建各个存储对象
      if (!db.objectStoreNames.contains(STORES.PROXY_CONFIGS)) {
        db.createObjectStore(STORES.PROXY_CONFIGS, { keyPath: 'id' });
      }
      
      if (!db.objectStoreNames.contains(STORES.CURRENT_PROXY)) {
        db.createObjectStore(STORES.CURRENT_PROXY, { keyPath: 'id' });
      }
      
      if (!db.objectStoreNames.contains(STORES.PROXY_AUTH)) {
        db.createObjectStore(STORES.PROXY_AUTH, { keyPath: 'id' });
      }
    };
    
    request.onsuccess = () => resolve(request.result);
  });
}

// 获取所有代理配置
export async function getAllProxyConfigs(): Promise<ProxyConfig[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readonly');
      const store = transaction.objectStore(STORES.PROXY_CONFIGS);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  } catch (error) {
    console.error('Error getting proxy configs:', error);
    return [];
  }
}

// 获取单个代理配置
export async function getProxyConfig(id: string): Promise<ProxyConfig | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readonly');
      const store = transaction.objectStore(STORES.PROXY_CONFIGS);
      const request = store.get(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch (error) {
    console.error(`Error getting proxy config ${id}:`, error);
    return null;
  }
}

// 保存代理配置
export async function saveProxyConfig(config: ProxyConfig): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readwrite');
      const store = transaction.objectStore(STORES.PROXY_CONFIGS);
      const request = store.put(config);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        // 如果代理被启用，更新当前代理
        if (config.enabled) {
          setCurrentProxy(config).catch(console.error);
        }
        resolve(true);
      };
    });
  } catch (error) {
    console.error('Error saving proxy config:', error);
    return false;
  }
}

// 批量保存代理配置
export async function saveProxyConfigs(configs: ProxyConfig[]): Promise<boolean> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readwrite');
    const store = transaction.objectStore(STORES.PROXY_CONFIGS);
    
    // 获取所有现有配置
    const existingConfigs = await getAllProxyConfigs();
    
    // 保留固定模式配置（direct和system）
    const fixedModeConfigs = existingConfigs.filter(config => 
      config.id === 'direct' || config.id === 'system'
    );
    
    // 确保新保存的配置不会覆盖固定模式的enabled状态
    const nonFixedConfigs = configs.filter(config => 
      config.id !== 'direct' && config.id !== 'system'
    );
    
    // 合并配置
    const allConfigs = [...fixedModeConfigs, ...nonFixedConfigs];
    
    // 更新enabled状态
    const updatedConfigs = allConfigs.map(config => ({
      ...config,
      enabled: configs.some(c => c.id === config.id && c.enabled)
    }));
    
    // 清除所有配置
    await new Promise<void>((resolve, reject) => {
      const clearRequest = store.clear();
      clearRequest.onerror = () => reject(clearRequest.error);
      clearRequest.onsuccess = () => resolve();
    });
    
    // 保存所有配置
    for (const config of updatedConfigs) {
      await new Promise<void>((resolve, reject) => {
        const putRequest = store.put(config);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => resolve();
      });
      
      // 如果代理被启用，更新当前代理
      if (config.enabled) {
        await setCurrentProxy(config);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error saving proxy configs:', error);
    return false;
  }
}

// 删除代理配置
export async function deleteProxyConfig(id: string): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readwrite');
      const store = transaction.objectStore(STORES.PROXY_CONFIGS);
      const request = store.delete(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (error) {
    console.error(`Error deleting proxy config ${id}:`, error);
    return false;
  }
}

// 设置当前代理
export async function setCurrentProxy(proxy: ProxyConfig): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.CURRENT_PROXY], 'readwrite');
      const store = transaction.objectStore(STORES.CURRENT_PROXY);
      const request = store.put({ ...proxy, id: 'current' });
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (error) {
    console.error('Error setting current proxy:', error);
    return false;
  }
}

// 获取当前代理
export async function getCurrentProxy(): Promise<ProxyConfig | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.CURRENT_PROXY], 'readonly');
      const store = transaction.objectStore(STORES.CURRENT_PROXY);
      const request = store.get('current');
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch (error) {
    console.error('Error getting current proxy:', error);
    return null;
  }
}

// 清除当前代理
export async function clearCurrentProxy(): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORES.CURRENT_PROXY], 'readwrite');
      const store = transaction.objectStore(STORES.CURRENT_PROXY);
      const request = store.delete('current');
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (error) {
    console.error('Error clearing current proxy:', error);
    return false;
  }
}

// 启用指定的代理，禁用其他
export async function enableProxyConfig(id: string): Promise<boolean> {
  try {
    // 获取所有配置
    const configs = await getAllProxyConfigs();
    
    // 查找目标代理
    const targetProxy = configs.find(config => config.id === id);
    if (!targetProxy) {
      console.error(`找不到ID为 ${id} 的代理配置`);
      return false;
    }
    
    // 创建更新后的代理配置
    const updatedConfigs = configs.map(config => ({
      ...config,
      enabled: config.id === id
    }));
    
    // 保存到数据库
    const db = await openDB();
    const transaction = db.transaction([STORES.PROXY_CONFIGS], 'readwrite');
    const store = transaction.objectStore(STORES.PROXY_CONFIGS);
    
    // 逐个更新配置
    for (const config of updatedConfigs) {
      await new Promise<void>((resolve, reject) => {
        const request = store.put(config);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    }
    
    // 设置当前代理
    await setCurrentProxy({
      ...targetProxy,
      enabled: true
    });
    
    return true;
  } catch (error) {
    console.error(`Error enabling proxy config ${id}:`, error);
    return false;
  }
}

// 禁用所有代理
export async function disableAllProxies(): Promise<boolean> {
  try {
    const configs = await getAllProxyConfigs();
    const updatedConfigs = configs.map(config => ({
      ...config,
      enabled: false
    }));
    
    // 保存更新后的配置列表
    await saveProxyConfigs(updatedConfigs);
    
    // 清除当前代理
    await clearCurrentProxy();
    
    return true;
  } catch (error) {
    console.error('Error disabling all proxies:', error);
    return false;
  }
} 