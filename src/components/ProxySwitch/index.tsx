import React, {useEffect, useState} from "react";
import {Menu} from "antd";
import {GlobalOutlined, DisconnectOutlined, SettingOutlined, EditOutlined, PlusOutlined} from "@ant-design/icons";
import {ProxyActionType} from '@/types/action';
import "./index.css";
import type { MenuProps } from 'antd';
import type { ProxyConfig } from '@/types/proxy';

// 固定的代理模式
const FIXED_MODES = [
    {
        key: 'direct',
        name: '[直接连接]',
        icon: <DisconnectOutlined />,
        color: '#666',
        config: {
            id: 'direct',
            name: '[直接连接]',
            proxyType: 'direct'
        }
    },
    {
        key: 'system',
        name: '[系统代理]',
        icon: <SettingOutlined />,
        color: '#666',
        config: {
            id: 'system',
            name: '[系统代理]',
            proxyType: 'system'
        }
    }
];

interface CustomProxy {
    key: string;
    name: string;
    color: string;
    config: ProxyConfig;
    enabled?: boolean;
}

export const ProxySwitch: React.FC = () => {
    const [currentMode, setCurrentMode] = useState<string>('direct');
    const [customProxies, setCustomProxies] = useState<CustomProxy[]>([]);

    useEffect(() => {
        loadProxyStatus();
        loadCustomProxies();
    }, []);

    const loadProxyStatus = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_STATUS
            });
            
            if (response.success) {
                const activeMode = response.data.mode;
                setCurrentMode(activeMode);

                if (FIXED_MODES.some(mode => mode.key === activeMode)) {
                    setCurrentMode(activeMode);
                }
            }
        } catch (error) {
            console.error('Error loading proxy status:', error);
        }
    };

    const loadCustomProxies = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_CONFIGS
            });
            
            if (response.success && response.data) {
                const proxies = response.data
                    .filter((proxy: ProxyConfig) => !FIXED_MODES.some(mode => mode.key === proxy.id))
                    .map((proxy: ProxyConfig): CustomProxy => ({
                        key: proxy.id,
                        name: proxy.name,
                        color: '#1890ff',
                        config: proxy,
                        enabled: proxy.enabled
                    }));
                setCustomProxies(proxies);

                const enabledProxy = proxies.find((proxy: ProxyConfig) => proxy.enabled);
                if (enabledProxy) {
                    setCurrentMode(enabledProxy.key);
                }
            }
        } catch (error) {
            console.error('Error loading custom proxies:', error);
        }
    };

    const handleApplyConfig = async (mode: string) => {
        try {
            const fixedMode = FIXED_MODES.find(fixed => fixed.key === mode);
            const customProxy = customProxies.find(proxy => proxy.key === mode);
            
            const config = fixedMode?.config || customProxy?.config;

            if (!config) {
                console.error('No config found for mode:', mode);
                return;
            }

            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.SET_PROXY_CONFIG,
                config
            });
            
            if (response.success) {
                setCurrentMode(mode);
                await loadCustomProxies();
            }
        } catch (error) {
            console.error('Failed to apply proxy config:', error);
        }
    };

    const handleModeChange = async (mode: string) => {
        if (mode === 'setting') {
            chrome.runtime.openOptionsPage?.();
            return;
        }

        if (mode === 'add') {
            chrome.runtime.openOptionsPage?.();
            return;
        }

        try {
            await handleApplyConfig(mode);
        } catch (error) {
            console.error('Failed to change proxy mode:', error);
        }
    };

    const menuItems: MenuProps['items'] = [
        ...FIXED_MODES.map(mode => ({
            key: mode.key,
            icon: <span className="menu-icon" style={{ color: mode.color }}>{mode.icon}</span>,
            label: mode.name,
            className: currentMode === mode.key ? 'menu-item-selected' : ''
        })),
        { type: 'divider' },
        ...customProxies.map(proxy => ({
            key: proxy.key,
            icon: <span className="menu-icon" style={{ color: proxy.color }}><GlobalOutlined /></span>,
            label: <span style={{ color: proxy.enabled ? 'var(--yakit-primary)' : 'inherit' }}>{proxy.name}</span>,
            className: proxy.enabled ? 'menu-item-selected' : ''
        })),
        {
            key: 'add',
            icon: <PlusOutlined />,
            label: '添加代理...',
            className: 'menu-item-add'
        },
        { type: 'divider' },
        {
            key: 'setting',
            icon: <EditOutlined />,
            label: '选项'
        }
    ];

    return (
        <Menu
            items={menuItems}
            selectedKeys={[currentMode]}
            onClick={({ key }) => handleModeChange(key)}
            style={{ width: 180 }}
        />
    );
};