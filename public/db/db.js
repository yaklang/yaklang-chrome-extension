class Database {
    constructor() {
        this.DB_NAME = 'yaklang_extension';
        this.DB_VERSION = 1;
        this.stores = {
            // 代理日志存储
            PROXY_LOGS: 'proxy_logs',
            // 代理配置列表存储
            PROXY_CONFIGS: 'proxy_configs',
            // 当前代理配置存储
            CURRENT_PROXY: 'current_proxy',
            // 代理认证信息存储
            PROXY_AUTH: 'proxy_auth'
        };
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 代理日志存储
                if (!db.objectStoreNames.contains(this.stores.PROXY_LOGS)) {
                    const logsStore = db.createObjectStore(this.stores.PROXY_LOGS, { keyPath: 'id' });
                    logsStore.createIndex('timestamp', 'timestamp');
                    logsStore.createIndex('resourceType', 'resourceType');
                    logsStore.createIndex('status', 'status');
                }

                // 代理配置列表存储
                if (!db.objectStoreNames.contains(this.stores.PROXY_CONFIGS)) {
                    const configsStore = db.createObjectStore(this.stores.PROXY_CONFIGS, { keyPath: 'id' });
                    configsStore.createIndex('name', 'name');
                    configsStore.createIndex('enabled', 'enabled');
                }

                // 当前代理配置存储
                if (!db.objectStoreNames.contains(this.stores.CURRENT_PROXY)) {
                    db.createObjectStore(this.stores.CURRENT_PROXY);
                }

                // 代理认证信息存储
                if (!db.objectStoreNames.contains(this.stores.PROXY_AUTH)) {
                    const authStore = db.createObjectStore(this.stores.PROXY_AUTH, { keyPath: 'id' });
                    authStore.createIndex('host', 'host');
                }
            };
        });
    }

    async getStore(storeName, mode = 'readonly') {
        const db = await this.initDB();
        const tx = db.transaction(storeName, mode);
        return tx.objectStore(storeName);
    }

    // CRUD 操作
    async get(storeName, key) {
        const store = await this.getStore(storeName);
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll(storeName) {
        const store = await this.getStore(storeName);
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async put(storeName, value, key = undefined) {
        try {
            const store = await this.getStore(storeName, 'readwrite');
            return new Promise((resolve, reject) => {
                const request = key ? store.put(value, key) : store.put(value);
                request.onsuccess = () => {
                    console.log(`Successfully put data in ${storeName}:`, value);
                    resolve(request.result);
                };
                request.onerror = () => {
                    console.error(`Error putting data in ${storeName}:`, request.error);
                    reject(request.error);
                };
            });
        } catch (error) {
            console.error(`Error in put operation for ${storeName}:`, error);
            throw error;
        }
    }

    async delete(storeName, key) {
        const store = await this.getStore(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clear(storeName) {
        const store = await this.getStore(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

export const db = new Database(); 