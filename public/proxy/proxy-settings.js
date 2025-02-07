// 代理配置存储和管理
export const ProxySettings = {
    async importSettings(settings) {
        try {
            if (Array.isArray(settings) && settings.every(s => s.proxyType)) {
                await chrome.storage.local.set({proxyConfigs: settings});
                return {success: true};
            }
            return {success: false, error: "Invalid settings format"};
        } catch (error) {
            return {success: false, error: error.message};
        }
    },

    async exportSettings() {
        try {
            const {proxyConfigs} = await chrome.storage.local.get('proxyConfigs');
            return {success: true, settings: proxyConfigs || []};
        } catch (error) {
            return {success: false, error: error.message};
        }
    },

    async setDefaultConfigs() {
        const result = await chrome.storage.local.get('proxyConfigs');
        if (!result.proxyConfigs) {
            const defaultConfigs = [{
                id: 'direct',
                name: '直接连接',
                proxyType: 'direct',
                enabled: false
            }];
            await chrome.storage.local.set({ proxyConfigs: defaultConfigs });
        }
        // 确保 proxyLogs 存在
        const logsResult = await chrome.storage.local.get('proxyLogs');
        if (!logsResult.proxyLogs) {
            await chrome.storage.local.set({ proxyLogs: [] });
        }
    }
}; 