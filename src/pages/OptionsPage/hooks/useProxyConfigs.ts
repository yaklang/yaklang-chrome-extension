import { useState, useEffect } from 'react';
import { ProxyConfig } from '@/types/proxy';
import { ProxyActionType } from '@/types/action';
import { message } from 'antd';

export const useProxyConfigs = () => {
    const [proxyConfigs, setProxyConfigs] = useState<ProxyConfig[]>([]);

    useEffect(() => {
        loadConfigs();
        
        // 监听配置更新
        const handleConfigUpdate = () => {
            loadConfigs();
        };
        
        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === 'PROXY_CONFIGS_UPDATED') {
                handleConfigUpdate();
            }
        });

        return () => {
            chrome.runtime.onMessage.removeListener(handleConfigUpdate);
        };
    }, []);

    const loadConfigs = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_CONFIGS
            });
            if (response.success) {
                setProxyConfigs(response.data || []);
            }
        } catch (error) {
            console.error('Error loading configs:', error);
            message.error('加载配置时发生错误');
        }
    };

    const handleAddProxy = async (config: ProxyConfig) => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.ADD_PROXY_CONFIG,
                config: config
            });
            if (response.success) {
                message.success('添加代理成功');
                loadConfigs();
            } else {
                message.error(response.error || '添加代理失败');
            }
        } catch (error) {
            console.error('Error adding proxy:', error);
            message.error('添加代理时发生错误');
        }
    };

    const handleConfigChange = async (configId: string, field: keyof ProxyConfig, value: any) => {
        try {
            const updatedConfigs = proxyConfigs.map(config => 
                config.id === configId ? { ...config, [field]: value } : config
            );
            
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.UPDATE_PROXY_CONFIG,
                configs: updatedConfigs
            });
            
            if (response?.success) {
                setProxyConfigs(response.data || updatedConfigs);
                message.success('更新配置成功');
            } else {
                message.error(response?.error || '更新配置失败');
                await loadConfigs();
            }
        } catch (error) {
            console.error('Error updating config:', error);
            message.error('更新配置时发生错误');
            await loadConfigs();
        }
    };

    const handleDeleteProxy = async (configId: string) => {
        try {
            console.log('Deleting proxy:', configId);
            const updatedConfigs = proxyConfigs.filter(config => config.id !== configId);
            console.log('Updated configs after delete:', updatedConfigs);
            
            // 使用 Promise 包装消息发送
            const response = await new Promise<any>((resolve) => {
                chrome.runtime.sendMessage({
                    action: ProxyActionType.UPDATE_PROXY_CONFIG,
                    configs: updatedConfigs
                }, (result) => {
                    console.log('Delete response received:', result);
                    resolve(result);
                });
            });
            
            console.log('Delete response:', response);
            
            if (response?.success) {
                setProxyConfigs(response.data || updatedConfigs);
                message.success('删除代理成功');
            } else {
                console.error('Delete failed:', response?.error);
                message.error(response?.error || '删除代理失败');
                await loadConfigs();
            }
        } catch (error) {
            console.error('Error deleting proxy:', error);
            message.error('删除代理时发生错误');
            await loadConfigs();
        }
    };

    const handleApplyConfig = async (configId: string) => {
        try {
            const config = proxyConfigs.find(c => c.id === configId);
            if (!config) return;

            // 先取消当前启用的代理
            const currentEnabled = proxyConfigs.find(c => c.enabled);
            if (currentEnabled && currentEnabled.id !== configId) {
                // 如果当前启用的不是直接连接，需要先清除代理设置
                if (currentEnabled.id !== 'direct') {
                    await chrome.runtime.sendMessage({
                        action: ProxyActionType.CLEAR_PROXY_CONFIG
                    });
                }
            }

            // 应用新的代理设置
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.SET_PROXY_CONFIG,
                config: config
            });

            if (response.success) {
                message.success('代理设置已应用');
            } else {
                message.error(response.error || '应用代理设置失败');
            }
        } catch (error) {
            console.error('Error applying proxy:', error);
            message.error('应用代理设置时发生错误');
        }
    };

    const handleClearProxy = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.CLEAR_PROXY_CONFIG
            });

            if (response.success) {
                message.success('已切换至直接连接');
            } else {
                message.error(response.error || '清除代理设置失败');
            }
        } catch (error) {
            console.error('Error clearing proxy:', error);
            message.error('清除代理设置时发生错误');
        }
    };

    return {
        proxyConfigs,
        handleAddProxy,
        handleConfigChange,
        handleDeleteProxy,
        handleApplyConfig,
        handleClearProxy
    };
}; 