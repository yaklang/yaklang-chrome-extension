import React, {useEffect, useState} from 'react';
import {Menu} from 'antd';
import {DisconnectOutlined, SettingOutlined, PlusOutlined, CheckOutlined} from '@ant-design/icons';
import {browser,} from 'wxt/browser';
import type {MenuProps} from 'antd';
import type {ProxyConfig} from '@/types/proxy';
import {ContentActionType, ProxyActionType} from '@/types/action';
import { getAllProxyConfigs, getCurrentProxy } from '@/utils/storage';

import './index.css';

// YAK 图标 URL
const YAK_ICON_URL = browser.runtime.getURL('/yak.svg');

// 固定的代理模式
const FIXED_MODES = [
    {
        key: 'direct',
        name: '[直接连接]',
        icon: <DisconnectOutlined/>,
        color: '#666',
        config: {
            id: 'direct',
            name: '[直接连接]',
            proxyType: 'direct',
            enabled: false
        }
    },
    {
        key: 'system',
        name: '[系统代理]',
        icon: <SettingOutlined/>,
        color: '#666',
        config: {
            id: 'system',
            name: '[系统代理]',
            proxyType: 'system',
            enabled: false
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
    const [initialized, setInitialized] = useState<boolean>(false);
    const [currentMode, setCurrentMode] = useState<string>('');
    const [customProxies, setCustomProxies] = useState<CustomProxy[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);

    // 监听存储变化
    useEffect(() => {
        const handleMessage = (message: any) => {
            if (message.action === ContentActionType.PROXY_CONFIGS_UPDATED && message.source !== 'proxy_switch') {
                loadCustomProxies();
                loadProxyStatus();
            }
        };

        browser.runtime.onMessage.addListener(handleMessage);
        return () => {
            browser.runtime.onMessage.removeListener(handleMessage);
        };
    }, []);

    // 初始化
    useEffect(() => {
        const init = async () => {
            await loadProxyStatus();
            await loadCustomProxies();
            setInitialized(true);
        };
        init();
    }, []);

    // 获取当前代理状态
    const loadProxyStatus = async () => {
        try {
            // 先尝试从后台脚本获取当前代理状态
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_STATUS
            });

            if (response && response.success) {
                const activeMode = response.data.mode;
                setCurrentMode(activeMode);
                return;
            }

            // 如果后台脚本没有返回，则从存储中获取当前代理
            const currentProxy = await getCurrentProxy();
            if (currentProxy) {
                setCurrentMode(currentProxy.id);
            } else {
                setCurrentMode('direct');
            }
        } catch (error) {
            console.error('Error loading proxy status:', error);
            setCurrentMode('direct');
        }
    };

    // 加载自定义代理配置
    const loadCustomProxies = async () => {
        try {
            // 使用存储API获取所有代理配置
            const configs = await getAllProxyConfigs();

            // 处理代理配置
            const proxies = configs
                .filter((proxy: ProxyConfig) => !['direct', 'system'].includes(proxy.id))
                .map((proxy: ProxyConfig): CustomProxy => ({
                    key: proxy.id,
                    name: proxy.name,
                    color: '#1890ff',
                    config: proxy,
                    enabled: proxy.enabled
                }));
            setCustomProxies(proxies);

            // 查找并设置已启用的代理
            const enabledProxy = configs.find((proxy: ProxyConfig) => proxy.enabled);
            if (enabledProxy) {
                setCurrentMode(enabledProxy.id);
            }
        } catch (error) {
            console.error('Error loading custom proxies:', error);
            setCustomProxies([]);
        }
    };

    // 处理代理模式变更
    const handleModeChange = async (mode: string) => {
        if (mode === 'setting') {
            // 打开设置页面
            await browser.runtime.openOptionsPage?.();
            return;
        }

        if (mode === 'add') {
            // 打开添加代理表单
            try {
                const [activeTab] = await browser.tabs.query({
                    active: true,
                    currentWindow: true
                });

                const optionsUrl = browser.runtime.getURL('/options.html');

                if (activeTab?.url === optionsUrl) {
                    browser.tabs.sendMessage(activeTab.id!, {
                        action: ContentActionType.TRIGGER_ADD_PROXY
                    });
                } else {
                    await browser.tabs.create({
                        url: optionsUrl
                    });
                }
            } catch (error) {
                console.error('Failed to get current tab:', error);
            }
            return;
        }

        // 如果当前已经是选中的模式，不做任何操作
        if (mode === currentMode) return;

        try {
            // 立即更新UI状态，避免闪烁
            setCurrentMode(mode);
            // 显示加载状态但不阻塞UI
            setTimeout(() => setIsLoading(true), 0);

            // 发送切换代理请求
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.SWITCH_PROXY,
                mode
            });

            if (!response || !response.success) {
                // 如果失败，恢复原状态
                console.error('Failed to switch proxy mode');
                await loadProxyStatus(); // 重新加载正确的状态
            } else {
                // 成功时刷新代理列表状态
                await loadCustomProxies();
            }
        } catch (error) {
            console.error(`Error switching to proxy mode ${mode}:`, error);
            await loadProxyStatus(); // 出错时重新加载正确的状态
        } finally {
            setIsLoading(false);
        }
    };

    // 构建菜单项
    const buildMenuItems = () => {
        const items: MenuProps['items'] = [
            ...FIXED_MODES.map(mode => ({
                key: mode.key,
                label: mode.name,
                icon: mode.icon,
                className: `${currentMode === mode.key ? 'active-item' : ''} menu-id-${mode.key}`,
            })),
            {type: 'divider'}
        ];

        // 添加自定义代理
        if (customProxies.length > 0) {
            items.push(
                ...customProxies.map(proxy => {
                    // 构建提示信息：显示代理协议、主机和端口
                    const tooltipText = proxy.config.proxyType === 'fixed_servers' && proxy.config.host && proxy.config.port 
                        ? `${proxy.config.scheme || 'http'}://${proxy.config.host}:${proxy.config.port}`
                        : proxy.config.proxyType === 'pac_script' 
                            ? 'PAC脚本代理'
                            : proxy.config.proxyType === 'auto_detect'
                                ? '自动检测代理'
                                : '';
                    
                    return {
                        key: proxy.key,
                        label: proxy.name,
                        icon: <img 
                                src={YAK_ICON_URL} 
                                alt="YAK" 
                                style={{
                                    width: 20, 
                                    height: 20,
                                    filter: currentMode === proxy.key ? 'brightness(0) invert(1)' : 'none',
                                    transition: 'filter 0.2s ease-in-out'
                                }}
                              />,
                        className: `${currentMode === proxy.key ? 'active-item' : ''} menu-id-${proxy.key}`,
                        title: tooltipText, // 添加悬停提示
                    };
                })
            );
            items.push({type: 'divider'});
        }

        // 添加设置选项
        items.push({
            key: 'setting',
            label: '代理设置',
            icon: <SettingOutlined />,
            className: 'menu-id-setting',
        });

        // 添加新建代理选项
        items.push({
            key: 'add',
            label: '添加代理',
            icon: <PlusOutlined />,
            className: 'menu-id-add',
        });

        return items;
    };

    return (
        <div className="proxy-switch-container">
            <Menu
                className="proxy-menu"
                selectedKeys={[currentMode]}
                items={buildMenuItems()}
                onClick={({key}) => handleModeChange(key)}
            />
            {isLoading && <div className="loading-overlay">切换中...</div>}
        </div>
    );
}; 