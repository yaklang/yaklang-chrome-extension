import React, {useEffect, useState, useRef} from "react";
import {Menu} from "antd";
import {
    DisconnectOutlined,
    SettingOutlined,
    PlusOutlined,
    CheckOutlined,
} from "@ant-design/icons";
import {browser} from "wxt/browser";
import type {MenuProps} from "antd";
import type {ProxyConfig} from "@/types/proxy";
import {ContentActionType, ProxyActionType} from "@/types/action";
import {getAllProxyConfigs, getCurrentProxy} from "@/utils/storage";

import "./index.css";

// YAK 图标 URL
const YAK_ICON_URL = browser.runtime.getURL("/yak.svg");

// 固定的代理模式
const FIXED_MODES = [
    {
        key: "direct",
        name: "[直接连接]",
        icon: <DisconnectOutlined/>,
        color: "#666",
        config: {
            id: "direct",
            name: "[直接连接]",
            proxyType: "direct",
            enabled: false,
        },
    },
    {
        key: "system",
        name: "[系统代理]",
        icon: <SettingOutlined/>,
        color: "#666",
        config: {
            id: "system",
            name: "[系统代理]",
            proxyType: "system",
            enabled: false,
        },
    },
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
    const [currentMode, setCurrentMode] = useState<string>("direct"); // 默认选中直接连接
    const [customProxies, setCustomProxies] = useState<CustomProxy[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const loadingTimeoutRef = useRef<number | null>(null);
    
    // 监听存储变化
    useEffect(() => {
        const handleMessage = (message: any) => {
            if (
                message.action === ContentActionType.PROXY_CONFIGS_UPDATED &&
                message.source !== "proxy_switch"
            ) {
                console.log("proxy_switch 收到代理配置更新消息", message);

                loadCustomProxies();
                loadProxyStatus();
            }
        };

        browser.runtime.onMessage.addListener(handleMessage);
        return () => {
            browser.runtime.onMessage.removeListener(handleMessage);
            // 清除可能存在的超时计时器
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
            }
        };
    }, []);

    // 初始化
    useEffect(() => {
        let mounted = true;
        
        const init = async () => {
            try {
                await loadProxyStatus();
                if (mounted) {
                    await loadCustomProxies();
                    setInitialized(true);
                }
            } catch (error) {
                console.error("初始化失败:", error);
                if (mounted) {
                    setInitialized(true);
                }
            }
        };
        
        init();
        
        return () => {
            mounted = false;
        };
    }, []);

    // 获取当前代理状态
    const loadProxyStatus = async () => {
        try {
            // 先尝试从后台脚本获取当前代理状态
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.GET_PROXY_STATUS,
            });
            console.log("proxy_switch 获取当前代理状态", response);

            if (response && response.success) {
                const activeMode = response.data.mode;
                console.log("获取到当前代理模式:", activeMode);
                setCurrentMode(activeMode);
                return;
            }

            // 如果后台脚本没有返回，则从存储中获取当前代理
            const currentProxy = await getCurrentProxy();
            if (currentProxy) {
                console.log("从存储获取到当前代理:", currentProxy.id);
                setCurrentMode(currentProxy.id);
            } else {
                console.log("未找到当前代理，使用默认值 direct");
                setCurrentMode("direct");
            }
        } catch (error) {
            console.error("Error loading proxy status:", error);
            setCurrentMode("direct");
        }
    };

    // 加载自定义代理配置
    const loadCustomProxies = async () => {
        try {
            // 使用存储API获取所有代理配置
            const configs = await getAllProxyConfigs();

            // 处理代理配置
            const proxies = configs
                .filter(
                    (proxy: ProxyConfig) => !["direct", "system"].includes(proxy.id)
                )
                .map(
                    (proxy: ProxyConfig): CustomProxy => ({
                        key: proxy.id,
                        name: proxy.name,
                        color: "#1890ff",
                        config: proxy,
                        enabled: proxy.enabled,
                    })
                );
            setCustomProxies(proxies);
            console.log("proxy_switch proxies", proxies);
            
            // 查找并设置已启用的代理
            const enabledProxy = configs.find((proxy: ProxyConfig) => proxy.enabled);
            if (enabledProxy) {
                console.log("proxy_switch enabledProxy", enabledProxy);
                setCurrentMode(enabledProxy.id);
            }
        } catch (error) {
            console.error("Error loading custom proxies:", error);
            setCustomProxies([]);
        }
    };

    // 处理代理模式变更
    const handleModeChange = async (mode: string) => {
        if (mode === "setting") {
            // 打开设置页面
            await browser.runtime.openOptionsPage?.();
            return;
        }

        if (mode === "add") {
            // 打开添加代理表单
            try {
                const [activeTab] = await browser.tabs.query({
                    active: true,
                    currentWindow: true,
                });

                const optionsUrl = browser.runtime.getURL("/options.html");

                if (activeTab?.url === optionsUrl) {
                    browser.tabs.sendMessage(activeTab.id!, {
                        action: ContentActionType.TRIGGER_ADD_PROXY,
                    });
                } else {
                    await browser.tabs.create({
                        url: optionsUrl,
                    });
                }
            } catch (error) {
                console.error("Failed to get current tab:", error);
            }
            return;
        }
        console.log("proxy_switch 处理代理模式变更", mode);
        
        // 如果当前已经是选中的模式，不做任何操作
        if (mode === currentMode) return;
        
        // 清除之前可能存在的加载超时
        if (loadingTimeoutRef.current) {
            clearTimeout(loadingTimeoutRef.current);
        }

        try {
            // 先更新UI，让用户感知到变化
            setCurrentMode(mode);
            setIsLoading(true);
            
            // 设置超时保护，确保加载状态最终会被清除
            loadingTimeoutRef.current = window.setTimeout(() => {
                setIsLoading(false);
            }, 5000); // 5秒超时保护

            // 发送切换代理请求
            const response = await browser.runtime.sendMessage({
                action: ProxyActionType.SWITCH_PROXY,
                mode,
                source: "proxy_switch",
            });

            // 请求完成后，清除超时保护
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
                loadingTimeoutRef.current = null;
            }

            if (!response || !response.success) {
                // 如果失败，恢复原状态
                console.error("Failed to switch proxy mode");
                await loadProxyStatus(); // 重新加载正确的状态
            } else {
                console.log("代理模式切换成功:", mode);
                setCurrentMode(mode);
            }
        } catch (error) {
            console.error(`Error switching to proxy mode ${mode}:`, error);
            await loadProxyStatus(); // 出错时重新加载正确的状态
        } finally {
            // 无论如何，最终要关闭加载状态
            setIsLoading(false);
        }
    };

    // 构建菜单项
    const buildMenuItems = () => {
        const items: MenuProps["items"] = [
            ...FIXED_MODES.map((mode) => ({
                key: mode.key,
                label: mode.name,
                icon: mode.icon,
                className: `${currentMode === mode.key ? "active-item" : ""} menu-id-${
                    mode.key
                }`,
            })),
            {type: "divider"},
        ];

        // 添加自定义代理
        if (customProxies.length > 0) {
            items.push(
                ...customProxies.map((proxy) => {
                    // 构建提示信息：显示代理协议、主机和端口
                    const tooltipText =
                        proxy.config.proxyType === "fixed_servers" &&
                        proxy.config.host &&
                        proxy.config.port
                            ? `${proxy.config.scheme || "http"}://${proxy.config.host}:${
                                proxy.config.port
                            }`
                            : proxy.config.proxyType === "pac_script"
                                ? "PAC脚本代理"
                                : proxy.config.proxyType === "auto_detect"
                                    ? "自动检测代理"
                                    : "";

                    // Firefox 兼容性：确保 active-item 类始终应用正确
                    const isActive = currentMode === proxy.key;

                    return {
                        key: proxy.key,
                        label: proxy.name,
                        icon: (
                            <img
                                src={YAK_ICON_URL}
                                alt="YAK"
                                style={{
                                    width: 20,
                                    height: 20,
                                    filter: isActive ? "brightness(0) invert(1)" : "none",
                                    transition: "filter 0.2s ease-in-out",
                                }}
                            />
                        ),
                        className: `${isActive ? "active-item" : ""} menu-id-${proxy.key}`,
                        title: tooltipText, // 添加悬停提示
                    };
                })
            );
            items.push({type: "divider"});
        }

        // 添加设置选项
        items.push({
            key: "setting",
            label: "代理设置",
            icon: <SettingOutlined/>,
            className: "menu-id-setting",
        });

        // 添加新建代理选项
        items.push({
            key: "add",
            label: "添加代理",
            icon: <PlusOutlined/>,
            className: "menu-id-add",
        });

        return items;
    };

    // 只在加载完成后渲染内容
    if (!initialized) {
        return <div className="proxy-switch-container loading">加载中...</div>;
    }

    return (
        <div className="proxy-switch-container">
            <Menu
                className="proxy-menu"
                selectedKeys={[currentMode]}
                defaultSelectedKeys={[currentMode]}
                items={buildMenuItems()}
                onClick={({key}) => handleModeChange(key)}
            />
            {isLoading && (
                <div className="loading-overlay">
                    切换中...
                </div>
            )}
        </div>
    );
};
