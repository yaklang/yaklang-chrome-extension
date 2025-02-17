import { db } from './db.js';

class ProxyStore {
    constructor() {
        this.MAX_LOGS = 1000;
    }

    // 代理配置相关操作
    async getProxyConfigs() {
        return await db.getAll(db.stores.PROXY_CONFIGS);
    }

    async saveProxyConfigs(configs) {
        try {
            console.log('Saving proxy configs:', configs);
            
            // 确保配置数组有效
            if (!Array.isArray(configs)) {
                throw new Error('配置必须是数组');
            }

            // 开始事务
            const store = await db.getStore(db.stores.PROXY_CONFIGS, 'readwrite');
            
            // 清除现有配置
            await store.clear();

            // 保存新配置
            for (const config of configs) {
                await store.put(config);
            }

            console.log('Proxy configs saved successfully');
            this.notifyConfigUpdate();
            return true;
        } catch (error) {
            console.error('Error saving proxy configs:', error);
            throw error;
        }
    }

    async getCurrentProxy() {
        return await db.get(db.stores.CURRENT_PROXY, 'current');
    }

    async setCurrentProxy(proxy) {
        await db.put(db.stores.CURRENT_PROXY, proxy, 'current');
    }

    async clearCurrentProxy() {
        await db.delete(db.stores.CURRENT_PROXY, 'current');
    }

    // 代理日志相关操作
    async getLogs() {
        const logs = await db.getAll(db.stores.PROXY_LOGS);
        return logs.sort((a, b) => b.timestamp - a.timestamp);
    }

    async addLog(log) {
        await db.put(db.stores.PROXY_LOGS, log);
        await this.cleanOldLogs();
    }

    async clearLogs() {
        await db.clear(db.stores.PROXY_LOGS);
    }

    async cleanOldLogs() {
        const store = await db.getStore(db.stores.PROXY_LOGS, 'readwrite');
        const countRequest = store.count();
        
        countRequest.onsuccess = () => {
            if (countRequest.result > this.MAX_LOGS) {
                const excess = countRequest.result - this.MAX_LOGS;
                const cursorRequest = store.index('timestamp').openCursor();
                let deleted = 0;
                
                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && deleted < excess) {
                        cursor.delete();
                        deleted++;
                        cursor.continue();
                    }
                };
            }
        };
    }

    // 代理认证相关操作
    async getAuthHandlers() {
        return await db.getAll(db.stores.PROXY_AUTH);
    }

    async saveAuthHandler(handler) {
        await db.put(db.stores.PROXY_AUTH, handler);
    }

    async deleteAuthHandler(id) {
        await db.delete(db.stores.PROXY_AUTH, id);
    }

    async clearAuthHandlers() {
        await db.clear(db.stores.PROXY_AUTH);
    }

    async getErrors() {
        return await db.get(db.stores.PROXY_AUTH, 'errors') || [];
    }

    async saveErrors(errors) {
        await db.put(db.stores.PROXY_AUTH, errors, 'errors');
    }

    async getAuth() {
        return await db.get(db.stores.PROXY_AUTH, 'auth');
    }

    async saveAuth(auth) {
        await db.put(db.stores.PROXY_AUTH, auth, 'auth');
    }

    async clearAuth() {
        await db.delete(db.stores.PROXY_AUTH, 'auth');
    }

    notifyConfigUpdate() {
        chrome.runtime.sendMessage({
            action: 'PROXY_CONFIGS_UPDATED'
        }).catch(() => {
            // 忽略接收者不存在的错误
        });
    }

    async addAndEnableProxy(config) {
        try {
            // 先禁用所有其他代理
            const existingConfigs = await this.getProxyConfigs();
            for (const existingConfig of existingConfigs) {
                if (existingConfig.enabled) {
                    await this.saveProxyConfigs([{
                        ...existingConfig,
                        enabled: false
                    }]);
                }
            }

            // 添加并启用新代理
            await this.saveProxyConfigs([config]);

            // 应用新代理
            await chrome.proxy.settings.set({
                value: {
                    mode: config.proxyType,
                    rules: {
                        singleProxy: {
                            scheme: config.scheme,
                            host: config.host,
                            port: config.port
                        }
                    }
                },
                scope: 'regular'
            });

            return { success: true };
        } catch (error) {
            console.error('Error in addAndEnableProxy:', error);
            return { success: false, error };
        }
    }
}

export const proxyStore = new ProxyStore();