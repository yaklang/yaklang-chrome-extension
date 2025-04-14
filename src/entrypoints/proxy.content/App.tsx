import React, {useState, useEffect, useRef} from 'react';
import {browser} from 'wxt/browser';
import type {ProxyConfig} from '@/types/proxy.ts';

// Constants - using string literal instead of getURL since it will be replaced at build time
const YAK_ICON_URL = browser.runtime.getURL("/yak.svg");

// Action types from the application
const ProxyActionType = {
    SET_PROXY_CONFIG: "SET_PROXY_CONFIG",
    CLEAR_PROXY_CONFIG: "CLEAR_PROXY_CONFIG",
    GET_PROXY_STATUS: "GET_PROXY_STATUS",
    GET_PROXY_CONFIGS: "GET_PROXY_CONFIGS",
    UPDATE_PROXY_CONFIG: "UPDATE_PROXY_CONFIG",
};

// Export anonymous component directly as default export
const App: React.FC = () => {
    // State
    const [expanded, setExpanded] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [activeTab, setActiveTab] = useState('proxy');
    const [proxyStatus, setProxyStatus] = useState({
        enable: false,
        proxy: '',
        currentMode: 'direct'
    });
    const [proxyConfigs, setProxyConfigs] = useState<ProxyConfig[]>([]);

    // Refs
    const panelRef = useRef<HTMLDivElement>(null);
    const dragStartRef = useRef({y: 0, top: 0});
    const timeoutRef = useRef<number | null>(null);

    // Setup message listener for updates
    useEffect(() => {
        const messageListener = async (message: any) => {
            if (message.action === "PROXY_STATUS_CHANGED" || message.action === "PROXY_CONFIGS_UPDATED") {
                await fetchProxyStatus();
                await fetchProxyConfigs();
            }
        };

        browser.runtime.onMessage.addListener(messageListener);

        // Initial data fetch
        fetchProxyStatus();
        fetchProxyConfigs();

        // Position from localStorage if available
        const savedPosition = localStorage.getItem("yakitProxyPanelPosition");
        if (savedPosition && panelRef.current) {
            const top = (parseFloat(savedPosition) / 100) * window.innerHeight;
            panelRef.current.style.top = `${top}px`;
            panelRef.current.style.transform = 'translateY(0)';
        }

        return () => {
            browser.runtime.onMessage.removeListener(messageListener);
            if (timeoutRef.current !== null) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    // Fetch current proxy status
    const fetchProxyStatus = async () => {
        try {
            const response = await sendMessageWithRetry({
                action: ProxyActionType.GET_PROXY_STATUS,
            });

            if (response && response.success) {
                const status = response.data;
                setProxyStatus({
                    enable: status.enabled,
                    proxy: status.mode === "system" ? "system" : "",
                    currentMode: status.mode || "direct",
                });
            }
        } catch (error) {
            console.error("Error fetching proxy status:", error);
        }
    };

    // Fetch proxy configurations
    const fetchProxyConfigs = async () => {
        try {
            const response = await sendMessageWithRetry({
                action: ProxyActionType.GET_PROXY_CONFIGS,
            });

            if (response && response.success) {
                setProxyConfigs(response.data || []);
            }
        } catch (error) {
            console.error("Error fetching proxy configs:", error);
        }
    };

    // Send message with retry logic
    const sendMessageWithRetry = async (message: any, maxRetries = 3) => {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await browser.runtime.sendMessage(message);
            } catch (error) {
                console.warn(`Attempt ${i + 1} failed:`, error);
                if (i === maxRetries - 1) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    };

    // Handle switching to a different proxy
    const handleProxySwitch = async (config: ProxyConfig) => {
        try {
            await sendMessageWithRetry({
                action: ProxyActionType.SET_PROXY_CONFIG,
                config,
            });

            // Update the UI
            await fetchProxyStatus();
        } catch (error) {
            console.error("Error switching proxy:", error);
        }
    };

    // Open options page
    const openOptionsPage = async (triggerAdd = false) => {
        try {
            await sendMessageWithRetry({
                action: "OPEN_OPTIONS_PAGE",
                triggerAdd,
            });
        } catch (error) {
            console.error("Error opening options page:", error);
        }
    };

    // Handle dragging functionality
    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (expanded) {
            setExpanded(false);
            return;
        }

        if (e.button !== 0) return; // Only left mouse button

        setIsDragging(true);

        const rect = panelRef.current?.getBoundingClientRect();
        if (rect) {
            dragStartRef.current = {
                y: e.clientY,
                top: rect.top,
            };
        }

        e.preventDefault();
    };

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isDragging) return;

        const deltaY = e.clientY - dragStartRef.current.y;
        const newTop = dragStartRef.current.top + deltaY;

        // Limit drag range to viewport
        const maxTop = window.innerHeight - (panelRef.current?.offsetHeight || 0);
        const boundedTop = Math.max(0, Math.min(newTop, maxTop));

        if (panelRef.current) {
            panelRef.current.style.top = `${boundedTop}px`;
            panelRef.current.style.transform = 'translateY(0)';
        }
    };

    const handleMouseUp = () => {
        if (!isDragging) return;

        setIsDragging(false);

        // Save position
        if (panelRef.current) {
            const top = panelRef.current.getBoundingClientRect().top;
            const percentage = (top / window.innerHeight) * 100;
            localStorage.setItem("yakitProxyPanelPosition", percentage.toString());
        }
    };

    // Handle mouse enter to clear any auto-collapse timeouts
    const handleMouseEnter = () => {
        if (timeoutRef.current !== null) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    };

    // Handle mouse leave to auto-collapse the panel
    const handleMouseLeave = () => {
        if (expanded) {
            timeoutRef.current = window.setTimeout(() => {
                setExpanded(false);
                timeoutRef.current = null;
            }, 300);
        }
    };

    // Get active proxy name and icon
    let proxyIcon = "🟢";
    let proxyName = "直接连接";

    if (proxyStatus.currentMode === "system") {
        proxyIcon = "⚙️";
        proxyName = "系统代理";
    } else if (proxyStatus.currentMode === "fixed_servers") {
        const activeConfig = proxyConfigs.find(c => c.enabled);
        if (activeConfig) {
            proxyIcon = activeConfig.proxyType === "pac_script" ? "📜" : "🌐";
            proxyName = activeConfig.name || "未命名代理";
        }
    }

    return (
        <div
            ref={panelRef}
            className={`floating-panel ${expanded ? 'expanded' : ''} ${isDragging ? 'dragging' : ''}`}
            data-active-tab={activeTab}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onMouseEnter={handleMouseEnter}
        >
            <div
                className="panel-header"
                onMouseDown={handleMouseDown}
                onClick={() => !isDragging && setExpanded(!expanded)}
            >
                <div className="header-content">
                    <img src={YAK_ICON_URL} className="yak-icon" alt="Yak"/>
                    <div className="active-proxy-info">
                        <span>{proxyIcon}</span>
                        <span>{proxyName}</span>
                    </div>
                </div>
            </div>

            {expanded && (
                <div className="panel-content">
                    <div className="tabs-container">
                        <div className="tab-list">
                            <button
                                className={`tab-button ${activeTab === 'proxy' ? 'active' : ''}`}
                                onClick={() => setActiveTab('proxy')}
                                title="代理设置"
                            >
                                🌐
                            </button>
                            <button
                                className={`tab-button ${activeTab === 'links' ? 'active' : ''}`}
                                onClick={() => setActiveTab('links')}
                                title="页面链接"
                            >
                                🔗
                            </button>
                        </div>

                        <div className="tab-content">
                            <div className={`tab-panel ${activeTab === 'proxy' ? 'active' : ''}`} data-panel="proxy">
                                <div
                                    className={`proxy-item ${proxyStatus.currentMode === 'direct' ? 'active' : ''}`}
                                    onClick={() => handleProxySwitch({
                                        id: 'direct',
                                        name: '[直接连接]',
                                        proxyType: 'direct',
                                        enabled: false
                                    })}
                                    title="直接连接"
                                >
                                    <span>🟢</span>
                                    <span>直接连接</span>
                                    {proxyStatus.currentMode === 'direct' && <div className="proxy-status"></div>}
                                </div>

                                <div
                                    className={`proxy-item ${proxyStatus.currentMode === 'system' ? 'active' : ''}`}
                                    onClick={() => handleProxySwitch({
                                        id: 'system',
                                        name: '[系统代理]',
                                        proxyType: 'system',
                                        enabled: true
                                    })}
                                    title="系统代理"
                                >
                                    <span>⚙️</span>
                                    <span>系统代理</span>
                                    {proxyStatus.currentMode === 'system' && <div className="proxy-status"></div>}
                                </div>

                                <div className="divider"></div>

                                {proxyConfigs.map(config => {
                                    if (config.proxyType !== 'direct' && config.proxyType !== 'system') {
                                        const isActive = proxyStatus.currentMode === 'fixed_servers' && config.enabled;
                                        const proxyIcon = config.proxyType === 'pac_script' ? '📜' : '🌐';
                                        const tooltipText = config.proxyType === 'pac_script'
                                            ? 'PAC Script'
                                            : `${config.scheme ? `${config.scheme.toUpperCase()} ` : ''}${config.host}:${config.port}`;

                                        return (
                                            <div
                                                key={config.id}
                                                className={`proxy-item ${isActive ? 'active' : ''}`}
                                                onClick={() => handleProxySwitch({...config, enabled: true})}
                                                title={tooltipText}
                                            >
                                                <span>{proxyIcon}</span>
                                                <span>{config.name || '未命名代理'}</span>
                                                {isActive && <div className="proxy-status"></div>}
                                            </div>
                                        );
                                    }
                                    return null;
                                })}

                                <div className="divider"></div>

                                <div className="action-button" onClick={() => openOptionsPage(true)}>
                                    <span>➕</span>
                                    <span>添加代理</span>
                                </div>

                                <div className="action-button" onClick={() => openOptionsPage(false)}>
                                    <span>⚙️</span>
                                    <span>设置</span>
                                </div>
                            </div>

                            <div className={`tab-panel ${activeTab === 'links' ? 'active' : ''}`} data-panel="links">
                                {/* Links panel content will be added in the future */}
                                <div className="links-placeholder" style={{padding: '16px', textAlign: 'center'}}>
                                    <p>链接面板功能将在未来版本中实现</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;