// 代理配置管理
export class ProxyManager {
    static async setProxy(config) {
        try {
            const proxyConfig = {
                mode: "fixed_servers",
                rules: {
                    singleProxy: {
                        scheme: config.scheme,
                        host: config.host,
                        port: config.port
                    },
                    bypassList: ["localhost", "127.0.0.1"]
                }
            };

            await chrome.proxy.settings.set({
                value: proxyConfig,
                scope: 'regular'
            });

            // 保存当前配置
            await chrome.storage.local.set({
                currentProxy: {
                    ...config,
                    timestamp: Date.now()
                }
            });

            return true;
        } catch (error) {
            console.error('Error setting proxy:', error);
            return false;
        }
    }

    static async clearProxy() {
        try {
            await chrome.proxy.settings.clear({scope: 'regular'});
            await chrome.storage.local.remove('currentProxy');
            return true;
        } catch (error) {
            console.error('Error clearing proxy:', error);
            return false;
        }
    }

    static async getProxyStatus() {
        try {
            const settings = await chrome.proxy.settings.get({});
            const currentProxy = await chrome.storage.local.get('currentProxy');
            return {
                enabled: settings.value.mode === "fixed_servers",
                config: currentProxy.currentProxy || null
            };
        } catch (error) {
            console.error('Error getting proxy status:', error);
            return {
                enabled: false,
                config: null
            };
        }
    }

    static async deleteProxy(proxyId) {
        try {
            // 获取当前代理配置
            const result = await chrome.storage.local.get(['proxyConfigs', 'currentProxy']);
            const configs = result.proxyConfigs || [];
            const currentProxy = result.currentProxy;

            // 如果要删除的代理正在使用中，先清除代理设置
            if (currentProxy && currentProxy.id === proxyId) {
                await clearProxyConfig();
            }

            // 从配置列表中删除代理
            const updatedConfigs = configs.filter(config => config.id !== proxyId);
            await chrome.storage.local.set({ proxyConfigs: updatedConfigs });

            return true;
        } catch (error) {
            console.error('Error deleting proxy:', error);
            return false;
        }
    }
} 