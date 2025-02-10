import { ProxySettings } from './proxy/proxy-settings.js';
import { ProxyAuth } from './proxy/proxy-auth.js';
import { ProxyActionType } from './types/action.js';
import { proxyLogs } from './proxy/proxy-logs.js';
import { proxyStore } from './db/proxy-store.js';

// 修改代理状态获取函数为 Promise 形式
function getProxySettings() {
    return new Promise((resolve) => {
        chrome.proxy.settings.get({}, resolve);
    });
}

async function handleSetProxyConfig(config, sendResponse) {
    try {
        // 处理直接连接的情况
        if (config.proxyType === 'direct') {
            await new Promise((resolve) => {
                chrome.proxy.settings.set({
                    value: { mode: "direct" },
                    scope: 'regular'
                }, resolve);
            });

            const settings = await getProxySettings();
            const isSuccess = settings.value.mode === "direct";

            if (isSuccess) {
                // 更新存储
                await proxyStore.setCurrentProxy({
                    ...config,
                    timestamp: Date.now()
                });

                // 更新代理列表状态
                const configs = await proxyStore.getProxyConfigs();
                const updatedConfigs = configs.map(c => ({
                    ...c,
                    enabled: c.id === config.id
                }));
                await proxyStore.saveProxyConfigs(updatedConfigs);

                console.log('Direct connection set successfully');
                sendResponse({ success: true });
            } else {
                console.error('Failed to set direct connection');
                sendResponse({ 
                    success: false, 
                    error: '无法设置直接连接' 
                });
            }
            return;
        }

        // 处理代理服务器的情况
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

        await new Promise((resolve) => {
            chrome.proxy.settings.set({
                value: proxyConfig,
                scope: 'regular'
            }, resolve);
        });

        const settings = await getProxySettings();
        const isSuccess = settings.value.mode === "fixed_servers" && 
                         settings.value.rules.singleProxy.host === config.host &&
                         settings.value.rules.singleProxy.port === parseInt(config.port);

        if (isSuccess) {
            await proxyStore.setCurrentProxy({
                ...config,
                timestamp: Date.now()
            });

            const configs = await proxyStore.getProxyConfigs();
            const updatedConfigs = configs.map(c => ({
                ...c,
                enabled: c.id === config.id
            }));
            await proxyStore.saveProxyConfigs(updatedConfigs);

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
        await new Promise((resolve) => {
            chrome.proxy.settings.clear({
                scope: 'regular'
            }, resolve);
        });

        await new Promise((resolve) => {
            chrome.proxy.settings.set({
                value: { mode: "system" },
                scope: 'regular'
            }, resolve);
        });

        // 只移除当前代理配置，保留代理列表
        await proxyStore.clearCurrentProxy();

        // 更新所有代理的启用状态
        const configs = await proxyStore.getProxyConfigs();
        const updatedConfigs = configs.map(config => ({
            ...config,
            enabled: false
        }));
        await proxyStore.saveProxyConfigs(updatedConfigs);

        const settings = await getProxySettings();
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
        const settings = await getProxySettings();
        const currentProxy = await proxyStore.getCurrentProxy();
        
        const status = {
            enabled: settings.value.mode === "fixed_servers",
            config: currentProxy || null,
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

// 添加代理请求监听器
function setupProxyRequestListener() {
    // 监听请求发送
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            // 使用非阻塞方式处理请求
            queueProxyLog(details).catch(error => {
                console.error('Error in proxy request listener:', error);
            });
            // 不需要返回值
        },
        { urls: ["<all_urls>"] }
    );

    // 监听请求错误
    chrome.webRequest.onErrorOccurred.addListener(
        (details) => {
            // 使用非阻塞方式处理错误
            queueProxyLog(details, new Error(details.error)).catch(error => {
                console.error('Error in proxy error listener:', error);
            });
        },
        { urls: ["<all_urls>"] }
    );
}

// 使用队列处理日志
async function queueProxyLog(details, error = null) {
    try {
        // 检查代理状态
        const settings = await getProxySettings();
        if (settings.value.mode !== "fixed_servers") {
            return;
        }

        // 获取当前代理配置
        const currentProxy = await proxyStore.getCurrentProxy();
        if (!currentProxy) {
            return;
        }

        // 记录日志
        await proxyLogs.logRequest(details, currentProxy, error);
    } catch (error) {
        console.error('Error in queueProxyLog:', error);
    }
}

// 导出代理处理器设置函数
export function setupProxyHandlers() {
    // 设置代理错误处理和认证
    ProxyAuth.setupErrorHandler();
    ProxyAuth.setupAuthListener();

    // 设置代理请求监听器
    setupProxyRequestListener();

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

            case ProxyActionType.GET_PROXY_LOGS:
                proxyLogs.getLogs().then(logs => {
                    sendResponse({ 
                        success: true,
                        data: logs 
                    });
                }).catch(error => {
                    sendResponse({ 
                        success: false, 
                        error: error.message 
                    });
                });
                return true;

            case ProxyActionType.CLEAR_PROXY_LOGS:
                proxyLogs.clearLogs().then(() => {
                    sendResponse({ success: true });
                }).catch(error => {
                    sendResponse({ 
                        success: false, 
                        error: error.message 
                    });
                });
                return true;

            case ProxyActionType.GET_PROXY_CONFIGS:
                proxyStore.getProxyConfigs().then(configs => {
                    sendResponse({ 
                        success: true,
                        data: configs 
                    });
                }).catch(error => {
                    sendResponse({ 
                        success: false, 
                        error: error.message 
                    });
                });
                return true;

            case ProxyActionType.ADD_PROXY_CONFIG:
                proxyStore.getProxyConfigs().then(async configs => {
                    const newConfigs = [...configs, msg.config];
                    await proxyStore.saveProxyConfigs(newConfigs);
                    sendResponse({ success: true });
                }).catch(error => {
                    sendResponse({ 
                        success: false, 
                        error: error.message 
                    });
                });
                return true;

            case ProxyActionType.UPDATE_PROXY_CONFIG:
                (async () => {  // 使用立即执行的异步函数
                    try {
                        if (!msg.configs || !Array.isArray(msg.configs)) {
                            throw new Error('无效的配置数据');
                        }
                        
                        console.log('Updating proxy configs:', msg.configs);
                        await proxyStore.saveProxyConfigs(msg.configs);
                        
                        // 获取最新的配置
                        const updatedConfigs = await proxyStore.getProxyConfigs();
                        console.log('Configs updated successfully:', updatedConfigs);
                        
                        // 发送响应
                        sendResponse({ 
                            success: true,
                            data: updatedConfigs
                        });
                    } catch (error) {
                        console.error('Error updating proxy configs:', error);
                        sendResponse({ 
                            success: false, 
                            error: error.message || '更新代理配置失败'
                        });
                    }
                })();
                return true;  // 保持消息端口打开
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
        } catch (error) {
            console.error('Error during installation:', error);
        }
    });
}