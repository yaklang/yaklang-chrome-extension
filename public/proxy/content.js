console.log("Content script starting...");

// 代理操作类型常量
const ProxyActionType = {
    SET_PROXY_CONFIG: 'SET_PROXY_CONFIG',
    CLEAR_PROXY_CONFIG: 'CLEAR_PROXY_CONFIG',
    GET_PROXY_STATUS: 'GET_PROXY_STATUS',
    GET_PROXY_CONFIGS: 'GET_PROXY_CONFIGS',
    UPDATE_PROXY_CONFIG: 'UPDATE_PROXY_CONFIG'
};

// 在文件顶部添加常量声明
const YAK_ICON_URL = chrome.runtime.getURL('/images/yak.svg');

// 添加一个通用的消息发送函数
async function sendMessageWithRetry(message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed:`, error);
            if (i === maxRetries - 1) {
                throw error;
            }
            // 等待一小段时间后重试
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

// 获取当前代理状态
async function getCurrentProxy() {
    try {
        const response = await sendMessageWithRetry({ 
            action: ProxyActionType.GET_PROXY_STATUS
        });
        
        if (!response || !response.success) {
            console.log('No valid response from background script');
            return { enable: false, proxy: '', currentMode: 'direct' };
        }

        const status = response.data;
        console.log('Proxy status from background:', status);

        // 返回当前模式
        return {
            enable: status.enabled,
            proxy: status.mode === 'system' ? 'system' : '',
            currentMode: status.mode || 'direct'  // 使用 mode 来判断当前激活的代理
        };
    } catch (error) {
        console.error('Error getting proxy status:', error);
        return { enable: false, proxy: '', currentMode: 'direct' };
    }
}

// 获取所有代理配置
async function getProxyConfigs() {
    try {
        const response = await sendMessageWithRetry({ 
            action: ProxyActionType.GET_PROXY_CONFIGS
        });
        
        if (!response) {
            console.log('No response from background script');
            return [];
        }
        if (!response.success) {
            console.error('Error in response:', response.error);
            return [];
        }
        return response.data || [];
    } catch (error) {
        console.error('Error getting proxy configs:', error);
        return [];
    }
}

// 切换代理
async function switchProxy(config) {
    try {
        console.log('Switching proxy:', config);
        
        // 根据配置类型构建正确的配置对象
        let proxyConfig;
        if (config.proxyType === 'system') {
            proxyConfig = {
                id: 'system',
                name: '[系统代理]',
                proxyType: 'system',
                enabled: true
            };
        } else if (config.proxyType === 'direct') {
            proxyConfig = {
                id: 'direct',
                name: '[直接连接]',
                proxyType: 'direct',
                enabled: false
            };
        } else {
            proxyConfig = {
                ...config,
                enabled: true
            };
        }

        await sendMessageWithRetry({
            action: ProxyActionType.SET_PROXY_CONFIG,
            config: proxyConfig
        });
        
        await PanelManager.updatePanel();
    } catch (error) {
        console.error('Error switching proxy:', error);
    }
}

// 清除代理
async function clearProxy() {
    try {
        const response = await sendMessageWithRetry({
            action: ProxyActionType.SET_PROXY_CONFIG,
            config: {
                id: 'direct',
                name: '[直接连接]',
                proxyType: 'direct',
                enabled: false
            }
        });
        
        console.log('Clear proxy response:', response);
        // 使用 PanelManager 的 updatePanel 方法
        await PanelManager.updatePanel();
    } catch (error) {
        console.error('Error clearing proxy:', error);
    }
}

// 修改 PanelManager
const PanelManager = {
    panel: null,
    messageListener: null,
    _updating: false,
    _updateQueue: Promise.resolve(),
    _currentState: null, // 用于跟踪当前状态
    _lastUpdate: null,  // 添加最后更新时间戳
    _lastState: null,
    _pollingInterval: null,
    
    init() {
        // 确保 document.body 存在
        if (!document.body) {
            console.log('Body not ready, waiting...');
            this.waitForBody();
            return;
        }

        if (this.panel) {
            console.log('Panel already exists, updating...');
            this.updatePanel();
            return;
        }
        
        console.log('Creating new panel...');
        this.createPanel();
    },

    // 添加等待 body 的方法
    waitForBody() {
        if (document.body) {
            this.init();
            return;
        }

        console.log('Setting up MutationObserver for body');
        const observer = new MutationObserver((mutations, obs) => {
            if (document.body) {
                console.log('Body found via observer');
                obs.disconnect();
                this.init();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    },
    
    createPanel() {
        if (!document.body) {
            console.log('Body not available during panel creation');
            return;
        }

        // 创建容器
        const container = document.createElement('div');
        container.id = 'yakit-proxy-panel';
        
        // 创建 shadow DOM
        const shadow = container.attachShadow({ mode: 'open' });
        
        // 添加样式
        const style = document.createElement('style');
        style.textContent = `
            .floating-panel {
                position: fixed;
                top: 20px;
                right: 0;
                width: 180px;
                background: white;
                border-radius: 8px 0 0 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                transition: transform 0.3s ease;
            }

            .floating-panel.collapsed {
                transform: translateX(100%);
            }

            .panel-header {
                padding: 4px;
                border-bottom: 1px solid #eee;
                border-radius: 8px 0 0 0;
                background: #f8f9fa;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .collapse-trigger {
                position: absolute;
                left: -20px;
                top: 0;
                width: 20px;
                height: 100%;
                background: #f8f9fa;
                border-radius: 8px 0 0 8px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: -2px 0 5px rgba(0,0,0,0.1);
            }

            .collapse-trigger:hover {
                background: #e9ecef;
            }

            .collapse-trigger::after {
                content: '◀';
                transition: transform 0.3s ease;
            }

            .floating-panel.collapsed .collapse-trigger::after {
                transform: rotate(180deg);
            }

            .panel-content {
                padding: 4px;
            }

            .proxy-item {
                position: relative;
                display: flex;
                align-items: center;
                padding: 4px 10px;
                cursor: pointer;
                transition: all 0.2s;
                color: #666;
                border-left: 3px solid transparent;
                overflow: hidden;
            }

            .proxy-item > span {
                position: relative;
                z-index: 1;
            }

            .watermark-icon {
                position: absolute;
                right: 0;
                width: 100%;
                height: 100%;
                opacity: 0.3;
                pointer-events: none;
                display: none;
                object-fit: contain;
                object-position: right center;
                padding: 4px;
            }

            .proxy-item.active .watermark-icon {
                display: block;
            }

            .proxy-item.active {
                color: #ff6b00 !important;
                background: #fff7e6;
                border-left: 3px solid #ff6b00;
            }

            .proxy-item.active span:first-child {
                color: #ff6b00 !important;
            }

            .proxy-item span:first-child {
                margin-right: 8px;
                font-size: 16px;
                color: #666;
                transition: color 0.2s;
            }

            .proxy-item:hover {
                background: #f5f5f5;
            }

            .proxy-item:hover span:first-child {
                color: #ff6b00;
            }

            .add-proxy {
                display: flex;
                align-items: center;
                padding: 4px 10px;
                color: #1890ff;
                cursor: pointer;
                border-top: 1px solid #eee;
                transition: all 0.2s;
            }

            .add-proxy:hover {
                background: #f5f5f5;
            }

            .settings {
                padding: 4px 10px;
                color: #666;
                cursor: pointer;
                border-top: 1px solid #eee;
                transition: all 0.2s;
            }

            .settings:hover {
                background: #f5f5f5;
            }

            .panel-header .header-content {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 0 4px;
            }

            .yak-icon {
                width: 24px;
                height: 24px;
                object-fit: contain;
            }

            .divider {
                height: 1px;
                background-color: #eee;
                margin: 4px 0;
            }
        `;

        // 创建面板内容
        const panel = document.createElement('div');
        panel.className = 'floating-panel';
        panel.innerHTML = `
            <div class="collapse-trigger"></div>
            <div class="panel-header">
                <div class="header-content">
                    <img src="${YAK_ICON_URL}" class="yak-icon" alt="Yak" />
                    <span>代理设置</span>
                </div>
            </div>
            <div class="panel-content">
                <div class="proxy-item active">
                    <span>🟢</span>
                    <span>[直接连接]</span>
                </div>
                <div class="proxy-item">
                    <span>⚙️</span>
                    <span>[系统代理]</span>
                </div>
                <div class="divider"></div>
                <div class="add-proxy">
                    <span>➕</span>
                    <span>[添加代理...]</span>
                </div>
                <div class="settings">
                    <span>👨‍💻</span>
                    <span>选项</span>
                </div>
            </div>
        `;

        // 将样式和面板添加到 shadow DOM
        shadow.appendChild(style);
        shadow.appendChild(panel);
        
        // 确保安全地添加到 body
        try {
            document.body.appendChild(container);
            this.panel = container;
            
            // 添加折叠触发器的点击事件
            const floatingPanel = shadow.querySelector('.floating-panel');
            const collapseTrigger = shadow.querySelector('.collapse-trigger');
            
            collapseTrigger.addEventListener('click', () => {
                floatingPanel.classList.toggle('collapsed');
            });
            
            // 设置消息监听和开始轮询
            this.setupMessageListener();
            
            // 初始更新面板
            this.updatePanel();

            // 添加页面卸载时的清理
            window.addEventListener('unload', () => {
                if (this._pollingInterval) {
                    clearInterval(this._pollingInterval);
                }
                if (this.messageListener) {
                    chrome.runtime.onMessage.removeListener(this.messageListener);
                }
            });
        } catch (error) {
            console.error('Error creating panel:', error);
        }
    },
    
    setupMessageListener() {
        if (this.messageListener) {
            chrome.runtime.onMessage.removeListener(this.messageListener);
        }
        
        this.messageListener = async (message, sender) => {
            // 只检查消息是否来自同一个扩展
            if (sender.id !== chrome.runtime.id) {
                return;
            }

            // 处理状态更新消息
            if (message.action === 'PROXY_STATUS_CHANGED' || 
                message.action === 'PROXY_CONFIGS_UPDATED') {
                console.log('Received update message:', message, 'from:', sender);
                await this.updatePanel();
            }
        };
        
        chrome.runtime.onMessage.addListener(this.messageListener);
    },
    
    async updatePanel() {
        if (!this.panel || !document.body.contains(this.panel)) {
            console.log('Panel not in document, recreating...');
            this.createPanel();
            return;
        }
        
        const panel = this.panel.shadowRoot?.querySelector('.panel-content');
        if (!panel) return;

        // 使用更新队列确保更新按顺序执行
        this._updateQueue = this._updateQueue.then(async () => {
            if (this._updating) {
                console.log('Update already in progress, skipping...');
                return;
            }

            try {
                this._updating = true;

                // 获取最新状态
                const [currentProxy, configs] = await Promise.all([
                    getCurrentProxy(),
                    getProxyConfigs()
                ]);

                // 状态没有变化时不更新
                const newState = JSON.stringify({ currentProxy, configs });
                if (this._currentState === newState) {
                    console.log('State unchanged, skipping update');
                    return;
                }
                this._currentState = newState;

                // 再次检查面板状态
                if (!this.panel || !document.body.contains(this.panel)) {
                    console.log('Panel was removed during data fetch');
                    return;
                }

                console.log('Updating panel with:', { currentProxy, configs });

                if (!Array.isArray(configs)) {
                    console.error('Invalid configs:', configs);
                    return;
                }

                // 保存当前激活的项
                const currentActiveId = panel.querySelector('.proxy-item.active')?.dataset.id;

                // 构建新的 HTML
                const newHtml = this._buildPanelHtml(currentProxy, configs);
                
                // 创建一个临时容器来比较内容
                const temp = document.createElement('div');
                temp.innerHTML = newHtml;

                // 只在内容真正改变时更新
                if (panel.innerHTML !== temp.innerHTML) {
                    requestAnimationFrame(() => {
                        panel.innerHTML = newHtml;
                        this._bindEventListeners(panel, configs, currentProxy);
                        
                        // 验证更新后的状态
                        const newActiveId = panel.querySelector('.proxy-item.active')?.dataset.id;
                        if (currentActiveId !== newActiveId) {
                            console.log('Active state changed:', {
                                from: currentActiveId,
                                to: newActiveId
                            });
                        }
                    });
                }
            } catch (error) {
                console.error('Error updating panel:', error);
            } finally {
                this._updating = false;
            }
        }).catch(error => {
            console.error('Error in update queue:', error);
            this._updating = false;
        });

        return this._updateQueue;
    },

    // 将 HTML 构建逻辑抽离成单独的方法
    _buildPanelHtml(currentProxy, configs) {
        let html = `
            <div class="proxy-item ${currentProxy.currentMode === 'direct' ? 'active' : ''}" 
                 data-id="direct"
                 title="直接连接">
                <span style="color: ${currentProxy.currentMode === 'direct' ? '#ff6b00' : '#666'}">🟢</span>
                <span>[直接连接]</span>
                <img src="${YAK_ICON_URL}" class="watermark-icon" alt="" />
            </div>
            <div class="proxy-item ${currentProxy.currentMode === 'system' ? 'active' : ''}" 
                 data-id="system"
                 title="系统代理">
                <span style="color: ${currentProxy.currentMode === 'system' ? '#ff6b00' : '#666'}">⚙️</span>
                <span>[系统代理]</span>
                <img src="${YAK_ICON_URL}" class="watermark-icon" alt="" />
            </div>
            <div class="divider"></div>
        `;

        // 添加自定义代理配置
        configs.forEach(config => {
            if (config.proxyType !== 'direct' && config.proxyType !== 'system') {
                // 判断是否激活：当前模式为 fixed_servers 且配置已启用
                const isActive = currentProxy.currentMode === 'fixed_servers' && 
                               config.enabled;
                
                const tooltipText = config.proxyType === 'pac_script' 
                    ? 'PAC Script'
                    : `${(config.proxyType || 'HTTP').toUpperCase()} ${config.host || ''}:${config.port || ''}`;
                
                const proxyIcon = config.proxyType === 'pac_script' ? '📜' : '🌐';
                
                html += `
                    <div class="proxy-item ${isActive ? 'active' : ''}" 
                         data-id="${config.id}"
                         title="${tooltipText}">
                        <span style="color: ${isActive ? '#ff6b00' : '#666'}">${proxyIcon}</span>
                        <span>${config.name || '未命名代理'}</span>
                        <img src="${YAK_ICON_URL}" class="watermark-icon" alt="" />
                    </div>
                `;
            }
        });

        // 添加操作按钮
        html += `
            <div class="add-proxy">
                <span>➕</span>
                <span>添加代理...</span>
            </div>
            <div class="settings">
                <span>👨‍💻</span>
                <span>选项</span>
            </div>
        `;

        return html;
    },

    _bindEventListeners(panel, configs, currentProxy) {
        // 代理项点击事件
        panel.querySelectorAll('.proxy-item').forEach(item => {
            const id = item.dataset.id;
            
            // 使用事件委托来提高性能
            const clickHandler = async (e) => {
                e.stopPropagation();

                if (this._updating) {
                    console.log('Panel is updating, ignoring click');
                    return;
                }

                // 添加点击反馈
                const originalOpacity = item.style.opacity;
                item.style.opacity = '0.7';

                try {
                    // 立即更新 UI 状态，不等待响应
                    panel.querySelectorAll('.proxy-item').forEach(i => {
                        i.classList.remove('active');
                        i.querySelector('span').style.color = '#666';
                    });
                    item.classList.add('active');
                    item.querySelector('span').style.color = '#ff6b00';

                    if (id === 'direct') {
                        await clearProxy();
                    } else if (id === 'system') {
                        await switchProxy({
                            id: 'system',
                            name: '[系统代理]',
                            proxyType: 'system'
                        });
                    } else {
                        const config = configs.find(c => c.id === id);
                        if (config) {
                            await switchProxy(config);
                        }
                    }
                } catch (error) {
                    console.error('Error handling proxy item click:', error);
                    // 发生错误时恢复原状
                    await this.updatePanel();
                } finally {
                    item.style.opacity = originalOpacity;
                }
            };

            // 使用 { once: true } 确保事件监听器不会重复
            item.addEventListener('click', clickHandler, { once: true });
        });

        // 添加代理按钮
        panel.querySelector('.add-proxy')?.addEventListener('click', async () => {
            try {
                await sendMessageWithRetry({ 
                    action: 'OPEN_OPTIONS_PAGE',
                    triggerAdd: true
                });
            } catch (error) {
                console.error('Error handling add proxy:', error);
            }
        });

        // 设置按钮
        panel.querySelector('.settings')?.addEventListener('click', async () => {
            try {
                await sendMessageWithRetry({ 
                    action: 'OPEN_OPTIONS_PAGE'
                });
            } catch (error) {
                console.error('Error opening options page:', error);
            }
        });
    }
};

// 修改初始化调用
console.log("Setting up initialization...");

// 根据文档状态决定初始化方式
if (document.readyState === 'loading') {
    console.log('Document still loading, waiting for DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', () => {
        console.log('DOMContentLoaded fired');
        PanelManager.init();
    });
} else {
    console.log('Document already loaded, initializing immediately');
    PanelManager.init();
}

// 保留 load 事件作为备份
window.addEventListener('load', () => {
    console.log("Window load triggered");
    if (!PanelManager.panel) {
        PanelManager.init();
    }
});

// 添加更详细的日志
console.log("Document readyState:", document.readyState);
console.log("Document body exists:", !!document.body);
console.log("Document documentElement exists:", !!document.documentElement);
