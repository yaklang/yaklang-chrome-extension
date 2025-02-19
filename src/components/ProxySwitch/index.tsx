import React, {useEffect, useState} from "react";
import {Menu} from "antd";
import {GlobalOutlined, DisconnectOutlined, SettingOutlined, EditOutlined, PlusOutlined} from "@ant-design/icons";
import {ProxyActionType} from '@/types/action';
import "./index.css";
import type { MenuProps } from 'antd';
import type { ProxyConfig } from '@/types/proxy';

// 添加 YAK 图标 URL 常量
const YAK_ICON_URL = chrome.runtime.getURL('/images/yak.svg');

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
            proxyType: 'direct',
            enabled: false
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

interface ProxySwitchProps {
    proxyConfigs: ProxyConfig[];
    currentProxy: ProxyConfig | null;
    onProxyChange: (config: ProxyConfig) => void;
}

export const ProxySwitch: React.FC<ProxySwitchProps> = () => {
    const [initialized, setInitialized] = useState<boolean>(false);
    const [currentMode, setCurrentMode] = useState<string>('');
    const [customProxies, setCustomProxies] = useState<CustomProxy[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);

    useEffect(() => {
        const init = async () => {
            await Promise.all([
                loadProxyStatus(),
                loadCustomProxies()
            ]);
            setInitialized(true);
        };
        init();
    }, []);

    const loadProxyStatus = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_STATUS
            });
            
            if (!response) {
                console.log('No response from background script');
                return;
            }
            
            if (response.success) {
                const activeMode = response.data.mode;
                if (FIXED_MODES.some(mode => mode.key === activeMode)) {
                    setCurrentMode(activeMode);
                }
            }
        } catch (error) {
            console.error('Error loading proxy status:', error);
            setCurrentMode('direct');
        }
    };

    const loadCustomProxies = async () => {
        try {
            // 首先检查当前是否在 options 页面的上下文中
            const currentUrl = window.location.href;
            const isInOptionsContext = currentUrl.includes('chrome-extension://') && currentUrl.includes('options.html');

            if (isInOptionsContext) {
                // 如果在 options 页面上下文中，直接使用消息通信
                const response = await chrome.runtime.sendMessage({
                    action: ProxyActionType.GET_PROXY_CONFIGS
                });
                
                if (response?.success && response.data) {
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

                    const enabledProxy = response.data.find((proxy: ProxyConfig) => proxy.enabled);
                    if (enabledProxy) {
                        setCurrentMode(enabledProxy.id);
                    } else {
                        setCurrentMode('direct');
                    }
                    return;
                }
            }

            // 如果不在 options 页面上下文中，使用 IndexedDB
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
            } else {
                setCurrentMode('direct');
            }

        } catch (error) {
            console.error('Error loading custom proxies:', error);
            setCustomProxies([]);
            setCurrentMode('direct');
        }
    };

    const handleModeChange = async (mode: string) => {
        if (mode === 'setting') {
            await chrome.runtime.openOptionsPage?.();
            return;
        }

        if (mode === 'add') {
            try {
                const [activeTab] = await chrome.tabs.query({ 
                    active: true,
                    currentWindow: true
                });
                const optionsUrl = chrome.runtime.getURL('/proxy/options.html');
                
                if (activeTab?.url === optionsUrl) {
                    chrome.tabs.sendMessage(activeTab.id!, {
                        action: 'TRIGGER_ADD_PROXY'
                    });
                } else {
                    const tab = await chrome.tabs.create({
                        url: optionsUrl
                    });

                    const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
                        if (tabId === tab.id && changeInfo.status === 'complete') {
                            chrome.tabs.onUpdated.removeListener(listener);
                            chrome.tabs.sendMessage(tab.id!, {
                                action: 'TRIGGER_ADD_PROXY'
                            });
                        }
                    };
                    
                    chrome.tabs.onUpdated.addListener(listener);
                }
            } catch (error) {
                console.error('Failed to get current tab:', error);
            }
            return;
        }

        try {
            setIsLoading(true);
            const fixedMode = FIXED_MODES.find(fixed => fixed.key === mode);
            const customProxy = customProxies.find(proxy => proxy.key === mode);
            
            const config = fixedMode?.config || customProxy?.config;
            if (!config) {
                console.error('No config found for mode:', mode);
                return;
            }

            setCurrentMode(mode);
            
            if (customProxy) {
                setCustomProxies(prev => prev.map(p => ({
                    ...p,
                    enabled: p.key === mode
                })));
            }

            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.SET_PROXY_CONFIG,
                config
            });
            
            if (response?.success === false) {
                throw new Error(response.error || '设置代理失败');
            }

            await loadCustomProxies();
        } catch (error) {
            console.error('Error applying proxy config:', error);
            throw error;
        } finally {
            setIsLoading(false);
        }
    };

    const menuItems: MenuProps['items'] = [
        ...FIXED_MODES.map(mode => ({
            key: mode.key,
            icon: <span className="menu-icon" style={{ color: mode.color }}>{mode.icon}</span>,
            label: mode.name,
            className: `${currentMode === mode.key ? 'menu-item-selected' : ''} ${isLoading ? 'menu-item-loading' : ''}`,
            title: mode.name.replace(/[\[\]]/g, '')
        })),
        { type: 'divider' },
        ...customProxies.map(proxy => ({
            key: proxy.key,
            icon: <span className="menu-icon" style={{ color: proxy.color }}><GlobalOutlined /></span>,
            label: <span style={{ 
                color: currentMode === proxy.key ? 'var(--yakit-primary)' : 'inherit',
                opacity: isLoading ? 0.7 : 1
            }}>{proxy.name}</span>,
            className: `${currentMode === proxy.key ? 'menu-item-selected' : ''} ${isLoading ? 'menu-item-loading' : ''}`,
            title: `${proxy.config.scheme.toUpperCase()} ${proxy.config.host}:${proxy.config.port}`
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

    return initialized ? (
        <div className="proxy-switch-container" style={{ position: 'relative' }}>
            <img 
                src={YAK_ICON_URL} 
                className="panel-watermark" 
                alt="" 
                style={{
                    position: 'absolute',
                    right: 0,
                    bottom: 0,
                    width: '100%',
                    height: '100%',
                    opacity: 0.1,
                    backgroundColor: '#fff7e6',
                    pointerEvents: 'none',
                    objectFit: 'contain',
                    objectPosition: 'right bottom',
                    zIndex: 0
                }}
            />
            <Menu
                items={menuItems}
                selectedKeys={[currentMode]}
                onClick={({ key }) => !isLoading && handleModeChange(key)}
                style={{ width: 180, position: 'relative', zIndex: 1, background: 'transparent' }}
                className={isLoading ? 'menu-loading' : ''}
            />
        </div>
    ) : (
        <div style={{ width: 180, height: 100, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <span>加载中...</span>
        </div>
    );
};