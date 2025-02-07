import { ProxyManager } from './proxy/proxy-manager.js';
import { ProxySettings } from './proxy/proxy-settings.js';
import { ProxyAuth } from './proxy/proxy-auth.js';
import { ProxyActionType } from './types/action.js';

// 记录代理日志
async function logProxyRequest(details, proxyConfig, error = null) {
    const log = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        url: details.url,
        proxyId: proxyConfig.id,
        proxyName: proxyConfig.name,
        status: error ? 'error' : 'success',
        errorMessage: error?.message
    };

    const result = await chrome.storage.local.get('proxyLogs');
    const logs = result.proxyLogs || [];
    const updatedLogs = [log, ...logs].slice(0, 1000);
    await chrome.storage.local.set({ proxyLogs: updatedLogs });
}

async function handleSetProxyConfig(config, sendResponse) {
    try {
        if (!config || !config.host || !config.port) {
            sendResponse({ 
                success: false, 
                error: '无效的代理配置' 
            });
            return;
        }

        const proxyConfig = {
            mode: "fixed_servers",
            rules: {
                singleProxy: {
                    scheme: config.scheme || 'http',
                    host: config.host,
                    port: parseInt(config.port)
                },
                bypassList: ["localhost", "127.0.0.1"]
            }
        };

        await chrome.proxy.settings.set({
            value: proxyConfig,
            scope: 'regular'
        });

        const settings = await chrome.proxy.settings.get({});
        const isSuccess = settings.value.mode === "fixed_servers" && 
                         settings.value.rules.singleProxy.host === config.host &&
                         settings.value.rules.singleProxy.port === parseInt(config.port);

        if (isSuccess) {
            await chrome.storage.local.set({
                currentProxy: {
                    ...config,
                    timestamp: Date.now()
                }
            });

            const result = await chrome.storage.local.get('proxyConfigs');
            if (result.proxyConfigs) {
                const updatedConfigs = result.proxyConfigs.map(c => ({
                    ...c,
                    enabled: c.id === config.id
                }));
                await chrome.storage.local.set({ proxyConfigs: updatedConfigs });
            }

            console.log('Proxy successfully set:', settings.value);
            sendResponse({ success: true });
        } else {
            console.error('Proxy settings verification failed');
            sendResponse({ 
                success: false, 
                error: '代理设置验证失败' 
            });
        }
    } catch (error) {
        console.error('Error setting proxy:', error);
        sendResponse({ 
            success: false, 
            error: error.message || '设置代理时发生错误' 
        });
    }
}

async function handleClearProxyConfig(sendResponse) {
    try {
        await chrome.proxy.settings.clear({
            scope: 'regular'
        });

        await chrome.proxy.settings.set({
            value: { mode: "system" },
            scope: 'regular'
        });

        // 只移除当前代理配置，保留代理列表
        await chrome.storage.local.remove([
            'currentProxy',
            'proxyAuthHandlers'
        ]);

        // 更新所有代理的启用状态
        const result = await chrome.storage.local.get('proxyConfigs');
        if (result.proxyConfigs) {
            const updatedConfigs = result.proxyConfigs.map(config => ({
                ...config,
                enabled: false
            }));
            await chrome.storage.local.set({ proxyConfigs: updatedConfigs });
        }

        const settings = await chrome.proxy.settings.get({});
        const isSuccess = settings.value.mode === "system";

        if (isSuccess) {
            console.log('Proxy successfully cleared');
            sendResponse({ success: true });
        } else {
            console.error('Failed to clear proxy settings');
            sendResponse({ 
                success: false, 
                error: '无法清除代理设置' 
            });
        }
    } catch (error) {
        console.error('Error clearing proxy:', error);
        sendResponse({ 
            success: false, 
            error: error.message || '清除代理时发生错误' 
        });
    }
}

async function handleGetProxyStatus(sendResponse) {
    try {
        const settings = await chrome.proxy.settings.get({});
        const currentProxy = await chrome.storage.local.get('currentProxy');
        
        const status = {
            enabled: settings.value.mode === "fixed_servers",
            config: currentProxy.currentProxy || null,
            mode: settings.value.mode
        };

        console.log('Current proxy status:', status);
        sendResponse({
            success: true,
            data: status
        });
    } catch (error) {
        console.error('Error getting proxy status:', error);
        sendResponse({
            success: false,
            error: error.message || '获取代理状态时发生错误'
        });
    }
}

// 导出代理处理器设置函数
export function setupProxyHandlers() {
    // 设置代理错误处理和认证
    ProxyAuth.setupErrorHandler();
    ProxyAuth.setupAuthListener();

    // 消息监听器
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        console.log("Proxy message:", msg);
        
        switch (msg.action) {
            case ProxyActionType.SET_PROXY_CONFIG:
                handleSetProxyConfig(msg.config, sendResponse);
                return true;
                
            case ProxyActionType.CLEAR_PROXY_CONFIG:
                handleClearProxyConfig(sendResponse);
                return true;
                
            case ProxyActionType.GET_PROXY_STATUS:
                handleGetProxyStatus(sendResponse);
                return true;
        }
    });

    // 在扩展启动时初始化
    chrome.runtime.onInstalled.addListener(async () => {
        try {
            // 确保默认配置存在
            await ProxySettings.setDefaultConfigs();
            
            // 清除之前的代理设置
            await handleClearProxyConfig(() => {});
            
            // 设置认证监听
            await ProxyAuth.setupAuthListener();

            // 初始化存储
            const storage = await chrome.storage.local.get(['proxyConfigs', 'proxyLogs']);
            if (!storage.proxyConfigs) {
                await chrome.storage.local.set({ proxyConfigs: [] });
            }
            if (!storage.proxyLogs) {
                await chrome.storage.local.set({ proxyLogs: [] });
            }
        } catch (error) {
            console.error('Error during installation:', error);
        }
    });
}