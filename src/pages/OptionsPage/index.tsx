import React, { useState, useEffect, useRef } from 'react';
import { Layout, Tabs, message } from 'antd';
import { ProxySettings } from './components/ProxySettings';
import { ProxyLogs } from './components/ProxyLogs';
import { useProxyConfigs } from './hooks/useProxyConfigs';
import { useProxyLogs } from './hooks/useProxyLogs';
import { ProxyConfig } from '@/types/proxy';
import { ProxyActionType } from '@/types/action';

const { Content } = Layout;

interface ProxySettingsProps {
    proxyConfigs: ProxyConfig[];
    onAdd: (config: ProxyConfig) => void;
    onChange: (configId: string, field: keyof ProxyConfig | 'config', value: any) => void;
    onDelete: (configId: string) => void;
    onApply: (configId: string) => Promise<void>;
    onClear: (configId: string) => Promise<void>;
}

export const OptionsPage: React.FC = () => {
    const { 
        proxyConfigs, 
        handleAddProxy, 
        handleConfigChange: handleConfigChangeHook, 
        handleDeleteProxy, 
        handleApplyConfig, 
        handleClearProxy 
    } = useProxyConfigs();
    const { proxyLogs, handleClearLogs } = useProxyLogs();
    const [proxyConfigsState, setProxyConfigs] = useState<ProxyConfig[]>([]);

    useEffect(() => {
        setProxyConfigs(proxyConfigs);
    }, [proxyConfigs]);

    // 通知 background 页面已准备就绪
    useEffect(() => {
        chrome.runtime.sendMessage({ action: 'OPTIONS_PAGE_READY' });
        
        const messageListener = (
            message: any,
            sender: chrome.runtime.MessageSender,
            sendResponse: (response?: any) => void
        ) => {
            if (message.action === 'TRIGGER_ADD_PROXY') {
                const proxySettingsElement = document.querySelector('.add-proxy-btn');
                if (proxySettingsElement) {
                    (proxySettingsElement as HTMLElement).click();
                }
            }
            sendResponse();
        };

        chrome.runtime.onMessage.addListener(messageListener);
        return () => {
            chrome.runtime.onMessage.removeListener(messageListener);
        };
    }, []);

    const handleAdd = async (config: ProxyConfig) => {
        try {
            await handleAddProxy(config);
        } catch (error) {
            console.error('Failed to add proxy:', error);
            message.error('添加代理失败');
        }
    };

    const handleConfigChange = async (configId: string, field: keyof ProxyConfig | 'config', value: any) => {
        try {
            const updatedConfigs = proxyConfigsState.map(config => {
                if (config.id === configId) {
                    if (field === 'config') {
                        // 如果是整个配置更新
                        return value;
                    } else {
                        // 如果是单个字段更新
                        return {
                            ...config,
                            [field]: value
                        };
                    }
                }
                return config;
            });

            // 更新 IndexedDB
            await chrome.runtime.sendMessage({
                action: ProxyActionType.UPDATE_PROXY_CONFIG,
                configs: updatedConfigs
            });

            // 更新本地状态
            setProxyConfigs(updatedConfigs);

            message.success('更新配置成功');
        } catch (error) {
            console.error('Failed to update config:', error);
            message.error('更新配置失败');
        }
    };

    return (
        <Layout style={{ height: '100vh' }}>
            <Content style={{ padding: '24px' }}>
                <Tabs
                    defaultActiveKey="1"
                    items={[
                        {
                            key: '1',
                            label: '代理设置',
                            children: (
                                <ProxySettings
                                    proxyConfigs={proxyConfigsState}
                                    onAdd={handleAdd}
                                    onChange={handleConfigChange}
                                    onDelete={handleDeleteProxy}
                                    onApply={handleApplyConfig}
                                    onClear={handleClearProxy}
                                />
                            )
                        },
                        {
                            key: '2',
                            label: '代理日志',
                            children: (
                                <ProxyLogs
                                    logs={proxyLogs}
                                    onClearLogs={handleClearLogs}
                                />
                            )
                        }
                    ]}
                />
            </Content>
        </Layout>
    );
}; 