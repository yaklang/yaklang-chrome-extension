import type { ProxyConfig } from '../types/proxy';

// 数据库名称和存储名称
const DB_NAME = 'yaklang_extension';
const PROXY_STORE_NAME = 'proxy_configs';

// 打开数据库
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onerror = () => reject(request.error);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // 如果存储不存在，创建它
      if (!db.objectStoreNames.contains(PROXY_STORE_NAME)) {
        db.createObjectStore(PROXY_STORE_NAME, { keyPath: 'id' });
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
      const transaction = db.transaction([PROXY_STORE_NAME], 'readonly');
      const store = transaction.objectStore(PROXY_STORE_NAME);
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
      const transaction = db.transaction([PROXY_STORE_NAME], 'readonly');
      const store = transaction.objectStore(PROXY_STORE_NAME);
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
      const transaction = db.transaction([PROXY_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(PROXY_STORE_NAME);
      const request = store.put(config);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (error) {
    console.error('Error saving proxy config:', error);
    return false;
  }
}

// 删除代理配置
export async function deleteProxyConfig(id: string): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PROXY_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(PROXY_STORE_NAME);
      const request = store.delete(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  } catch (error) {
    console.error(`Error deleting proxy config ${id}:`, error);
    return false;
  }
}

// 启用指定的代理，禁用其他
export async function enableProxyConfig(id: string): Promise<boolean> {
  try {
    const configs = await getAllProxyConfigs();
    
    for (const config of configs) {
      const updated = { ...config, enabled: config.id === id };
      await saveProxyConfig(updated);
    }
    
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
    
    for (const config of configs) {
      if (config.enabled) {
        const updated = { ...config, enabled: false };
        await saveProxyConfig(updated);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error disabling all proxies:', error);
    return false;
  }
} 