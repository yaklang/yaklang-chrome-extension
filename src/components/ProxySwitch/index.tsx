import React, {useEffect, useState} from 'react';
import {Menu} from 'antd';
import {DisconnectOutlined, SettingOutlined, PlusOutlined, CheckOutlined} from '@ant-design/icons';
import {browser,} from 'wxt/browser';
import type {MenuProps} from 'antd';
import type {ProxyConfig} from '@/types/proxy';
import {ContentActionType, ProxyActionType} from '@/types/action';

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
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_STATUS
            });

            if (!response) {
                console.log('No response from background script');
                return;
            }

            if (response.success) {
                const activeMode = response.data.mode;
                setCurrentMode(activeMode);
            }
        } catch (error) {
            console.error('Error loading proxy status:', error);
            setCurrentMode('direct');
        }
    };

    // 加载自定义代理配置
    const loadCustomProxies = async () => {
        try {
            const DB_NAME = 'yaklang_extension';
            const STORE_NAME = 'proxy_configs';

            // 打开数据库
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });

            // 从数据库读取代理配置
            const configs = await new Promise<ProxyConfig[]>((resolve, reject) => {
                try {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.getAll();

                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result || []);
                } catch (error) {
                    reject(error);
                }
            });

            // 处理代理配置
            const proxies = configs
                .filter((proxy: ProxyConfig) => !FIXED_MODES.some(mode => mode.key === proxy.id))
                .map((proxy: ProxyConfig): CustomProxy => ({
                    key: proxy.id,
                    name: proxy.name,
                    color: '#1890ff',
                    config: proxy,
                    enabled: proxy.enabled
                }));
            setCustomProxies(proxies);

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

        try {
            setIsLoading(true);

            // 发送切换代理请求
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.SWITCH_PROXY,
                mode
            });

            if (response && response.success) {
                setCurrentMode(mode);
            }
        } catch (error) {
            console.error(`Error switching to proxy mode ${mode}:`, error);
        } finally {
            setIsLoading(false);
        }
    };

    // 构建菜单项
    const buildMenuItems = () => {
        const items: MenuProps['items'] = [
            ...FIXED_MODES.map(mode => ({
                key: mode.key,
                label: (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <span>{mode.name}</span>
                        {currentMode === mode.key && <span>🟢</span>}
                    </div>
                ),
                icon: mode.icon,
            })),
            {type: 'divider'}
        ];

        // 添加自定义代理
        if (customProxies.length > 0) {
            items.push(
                ...customProxies.map(proxy => ({
                    key: proxy.key,
                    label: (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <span>{proxy.name}</span>
                            {currentMode === proxy.key && <CheckOutlined style={{ color: 'var(--yakit-primary)' }} />}
                        </div>
                    ),
                    icon: <img src={YAK_ICON_URL} alt="YAK" style={{width: 16, height: 16}}/>,
                }))
            );
            items.push({type: 'divider'});
        }

        // 添加设置选项
        items.push({
            key: 'setting',
            label: '代理设置',
            icon: <SettingOutlined/>,
        });

        // 添加新建代理选项
        items.push({
            key: 'add',
            label: '添加代理',
            icon: <PlusOutlined/>,
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
                data-menu-id={currentMode}
            />
            {isLoading && <div className="loading-overlay">切换中...</div>}
        </div>
    );
}; 