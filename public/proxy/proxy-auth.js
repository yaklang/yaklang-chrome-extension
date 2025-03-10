// 代理认证管理
import { proxyStore } from '../db/proxy-store.js';

export class ProxyAuth {
    static async setupAuthListener() {
        // 使用 chrome.webRequest.onAuthRequired 的非阻塞版本
        chrome.webRequest.onAuthRequired.addListener(
            async (details) => {
                try {
                    // 获取认证处理器
                    const handlers = await proxyStore.getAuthHandlers();
                    const handler = handlers.find(h => 
                        details.challenger?.host === h.host
                    );

                    if (handler) {
                        // 使用 declarativeNetRequest 规则来处理认证
                        await chrome.declarativeNetRequest.updateDynamicRules({
                            removeRuleIds: [handler.id],
                            addRules: [{
                                id: parseInt(handler.id),
                                priority: 1,
                                action: {
                                    type: 'modifyHeaders',
                                    requestHeaders: [
                                        {
                                            header: 'Proxy-Authorization',
                                            operation: 'set',
                                            value: 'Basic ' + btoa(`${handler.username}:${handler.password}`)
                                        }
                                    ]
                                },
                                condition: {
                                    domains: [handler.host],
                                    resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
                                }
                            }]
                        });
                    }
                } catch (error) {
                    console.error('Auth error:', error);
                }
            },
            { urls: ["<all_urls>"] }
        );
    }

    static async saveAuthHandler(host, username, password) {
        const handler = {
            id: Date.now().toString(),
            host,
            username,
            password
        };
        await proxyStore.saveAuthHandler(handler);
        await this.setupAuthListener(); // 重新设置认证规则
    }

    static async removeAuthHandler(host) {
        const handlers = await proxyStore.getAuthHandlers();
        const handler = handlers.find(h => h.host === host);
        if (handler) {
            await proxyStore.deleteAuthHandler(handler.id);
            // 移除对应的认证规则
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [parseInt(handler.id)]
            });
        }
    }

    static setupErrorHandler() {
        // 使用 storage 记录错误
        return {
            logError: async (error) => {
                const errors = await proxyStore.getErrors() || [];
                errors.push({
                    timestamp: Date.now(),
                    error: error.message || error
                });
                await proxyStore.saveErrors(errors.slice(-100)); // 只保留最近100条错误记录
            }
        };
    }

    // 设置代理认证信息
    static async setProxyAuth(username, password) {
        try {
            await proxyStore.saveAuth({ username, password, timestamp: Date.now() });
            return true;
        } catch (error) {
            console.error('Error setting proxy auth:', error);
            return false;
        }
    }

    // 获取代理认证信息
    static async getProxyAuth() {
        try {
            return await proxyStore.getAuth();
        } catch (error) {
            console.error('Error getting proxy auth:', error);
            return null;
        }
    }

    // 清除代理认证信息
    static async clearProxyAuth() {
        try {
            await proxyStore.clearAuth();
            return true;
        } catch (error) {
            console.error('Error clearing proxy auth:', error);
            return false;
        }
    }
} 