import { proxyStore } from '../db/proxy-store.js';

// 代理配置存储和管理
export class ProxySettings {
    static async importSettings(settings) {
        try {
            if (Array.isArray(settings) && settings.every(s => s.proxyType)) {
                await proxyStore.saveProxyConfigs(settings);
                return {success: true};
            }
            return {success: false, error: "Invalid settings format"};
        } catch (error) {
            return {success: false, error: error.message};
        }
    }

    static async exportSettings() {
        try {
            const configs = await proxyStore.getProxyConfigs();
            return {success: true, settings: configs || []};
        } catch (error) {
            return {success: false, error: error.message};
        }
    }

    static async setDefaultConfigs() {
        const configs = await proxyStore.getProxyConfigs();
        if (!configs || configs.length === 0) {
            // 设置默认的直接连接配置
            await proxyStore.saveProxyConfigs([
                {
                    id: 'direct',
                    name: '直接连接',
                    proxyType: 'direct',
                    enabled: false
                },
                {
                    id: 'system',
                    name: '系统代理',
                    proxyType: 'system',
                    enabled: false
                }
            ]);
        }
        // 确保日志存储已初始化
        const logs = await proxyStore.getLogs();
        if (!logs || logs.length === 0) {
            await proxyStore.clearLogs();
        }
    }
} 