// 代理认证管理
export class ProxyAuth {
    static async setupAuthListener() {
        try {
            // 保存认证信息到 storage
            const saveAuth = async (config) => {
                await chrome.storage.local.set({
                    proxyAuth: {
                        username: config.username,
                        password: config.password,
                        timestamp: Date.now()
                    }
                });
            };

            // 获取认证信息
            const getAuth = async () => {
                const result = await chrome.storage.local.get('proxyAuth');
                return result.proxyAuth;
            };

            // 清除认证信息
            const clearAuth = async () => {
                await chrome.storage.local.remove('proxyAuth');
            };

            return {
                saveAuth,
                getAuth,
                clearAuth
            };
        } catch (error) {
            console.error('Error setting up auth listener:', error);
            return null;
        }
    }

    static setupErrorHandler() {
        // 在 Manifest V3 中，我们不能使用 chrome.proxy.onProxyError
        // 所以我们只记录错误到 storage
        try {
            const logError = async (error) => {
                const errors = await chrome.storage.local.get('proxyErrors') || [];
                errors.push({
                    timestamp: Date.now(),
                    error: error.message || error
                });
                await chrome.storage.local.set({
                    proxyErrors: errors.slice(-100) // 只保留最近100条错误记录
                });
            };

            return { logError };
        } catch (error) {
            console.error('Error setting up error handler:', error);
            return null;
        }
    }

    // 设置代理认证信息
    static async setProxyAuth(username, password) {
        try {
            await chrome.storage.local.set({
                proxyAuth: {
                    username,
                    password,
                    timestamp: Date.now()
                }
            });
            return true;
        } catch (error) {
            console.error('Error setting proxy auth:', error);
            return false;
        }
    }

    // 获取代理认证信息
    static async getProxyAuth() {
        try {
            const result = await chrome.storage.local.get('proxyAuth');
            return result.proxyAuth || null;
        } catch (error) {
            console.error('Error getting proxy auth:', error);
            return null;
        }
    }

    // 清除代理认证信息
    static async clearProxyAuth() {
        try {
            await chrome.storage.local.remove('proxyAuth');
            return true;
        } catch (error) {
            console.error('Error clearing proxy auth:', error);
            return false;
        }
    }
} 