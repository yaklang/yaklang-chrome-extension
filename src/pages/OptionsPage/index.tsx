import React from 'react';
import { Layout, Tabs } from 'antd';
import { ProxySettings } from './components/ProxySettings';
import { ProxyLogs } from './components/ProxyLogs';
import { useProxyConfigs } from './hooks/useProxyConfigs';
import { useProxyLogs } from './hooks/useProxyLogs';
import { ProxyConfig } from '@/types/proxy';

const { Content } = Layout;

export const OptionsPage: React.FC = () => {
    const { 
        proxyConfigs, 
        handleAddProxy, 
        handleConfigChange, 
        handleDeleteProxy, 
        handleApplyConfig, 
        handleClearProxy 
    } = useProxyConfigs();
    const { proxyLogs, handleClearLogs } = useProxyLogs();

    const handleAdd = () => {
        const newConfig: ProxyConfig = {
            id: Date.now().toString(),
            name: '新建代理',
            proxyType: 'fixed_servers',
            scheme: 'http',
            host: '127.0.0.1',
            port: 8080,
            enabled: false
        };
        handleAddProxy(newConfig);
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
                                    proxyConfigs={proxyConfigs}
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