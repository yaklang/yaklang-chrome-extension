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

        // 发送配置更改消息
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
    isDragging: false,
    startY: 0,
    currentY: 0,
    
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
                top: 30%;
                right: 0;
                transform: translateY(-30%);
                background: white;
                z-index: 2147483647;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                width: 50px;
                height: 40px;
                overflow: hidden;
                transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                            height 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                            background-color 0.2s ease;
            }

            /* 吸附状态 */
            .floating-panel:not(.expanded):not(.dragging) {
                border-radius: 50px 0 0 50px;
                box-shadow: -4px 0 20px rgba(0,0,0,0.15);
                border: 1px solid #eee;
                border-right: none;
            }

            /* 拖动状态 */
            .floating-panel.dragging {
                cursor: grabbing !important;
                user-select: none;
                opacity: 0.95;
                transition: none;
            }

            .floating-panel.dragging * {
                cursor: grabbing !important;
            }

            .floating-panel:active {
                cursor: grabbing;
            }

            .floating-panel .panel-header {
                cursor: grab;
            }

            .floating-panel .panel-header:active {
                cursor: grabbing;
            }

            /* 吸附状态悬浮时 */
            .floating-panel:not(.expanded):hover {
                width: 120px;
                background: #fff7e6;
                border-color: #ffd591;
            }

            /* 展开状态 - 立即应用圆角变化 */
            .floating-panel.expanded {
                width: 180px;
                height: auto;
                max-height: 400px;
                border-radius: 8px 0 0 8px;
                box-shadow: -2px 0 10px rgba(0,0,0,0.1);
                border: 1px solid #eee;
                border-right: none;
                /* 展开时立即应用新的圆角 */
                transition: 
                    width 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                    height 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                    border-radius 0s,
                    background-color 0.2s ease;
            }

            .panel-header {
                height: 40px;
                min-height: 40px;
                display: flex;
                align-items: center;
                padding: 0 8px;
                cursor: pointer;
                user-select: none;
            }

            /* 吸附状态的头部 */
            .floating-panel:not(.expanded) .panel-header {
                background: transparent;
            }

            /* 展开状态的头部 */
            .floating-panel.expanded .panel-header {
                background: #f8f9fa;
                border-bottom: 1px solid #eee;
            }

            .header-content {
                display: flex;
                align-items: center;
                flex: 1;
                overflow: hidden;
            }

            /* 优化图标大小过渡 */
            .yak-icon {
                width: 36px;
                height: 36px;
                min-width: 36px;
                object-fit: contain;
                filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .floating-panel.expanded .yak-icon {
                width: 24px;
                height: 24px;
                min-width: 24px;
            }

            .active-proxy-info {
                display: flex;
                align-items: center;
                margin-left: 8px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #ff6b00;
                font-size: 13px;
                font-weight: 500;
            }

            .active-proxy-info span:first-child {
                margin-right: 6px;
                filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1));
            }

            .panel-content {
                display: none;
                background: white;
                overflow-y: auto;
                max-height: 360px;
                opacity: 0;
                transition: opacity 0.2s ease;
            }

            .floating-panel.expanded .panel-content {
                display: block;
                opacity: 1;
            }

            .panel-content::-webkit-scrollbar {
                width: 4px;
            }

            .panel-content::-webkit-scrollbar-track {
                background: #f5f5f5;
            }

            .panel-content::-webkit-scrollbar-thumb {
                background: #ddd;
                border-radius: 4px;
            }

            .panel-content::-webkit-scrollbar-thumb:hover {
                background: #ccc;
            }

            .proxy-item {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                cursor: pointer;
                transition: all 0.2s;
                white-space: nowrap;
                position: relative;
            }

            .proxy-item:hover {
                background: #fff7e6;
            }

            .proxy-item.active {
                background: #fff7e6;
                color: #ff6b00;
            }

            .proxy-item span:first-child {
                margin-right: 8px;
                font-size: 16px;
                filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1));
            }

            .proxy-status {
                position: absolute;
                right: 12px;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #52c41a;
                box-shadow: 0 0 4px rgba(82,196,26,0.3);
            }

            .proxy-item.active .proxy-status {
                background: #ff6b00;
                box-shadow: 0 0 4px rgba(255,107,0,0.3);
            }

            .divider {
                height: 1px;
                background: #f0f0f0;
                margin: 4px 0;
            }

            .action-button {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                cursor: pointer;
                transition: all 0.2s;
                white-space: nowrap;
                color: #666;
            }

            .action-button:hover {
                background: #fff7e6;
                color: #ff6b00;
            }

            .action-button span:first-child {
                margin-right: 8px;
                filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1));
            }
        `;

        // 创建面板内容
        const panel = document.createElement('div');
        panel.className = 'floating-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <div class="header-content">
                    <img src="${YAK_ICON_URL}" class="yak-icon" alt="Yak" />
                    <div class="active-proxy-info">
                        <!-- 当前代理信息将动态更新 -->
                    </div>
                </div>
            </div>
            <div class="panel-content">
                <!-- 内容将由 _buildPanelHtml 方法动态生成 -->
            </div>
        `;

        // 将样式和面板添加到 shadow DOM
        shadow.appendChild(style);
        shadow.appendChild(panel);
        
        // 确保安全地添加到 body
        try {
            document.body.appendChild(container);
            this.panel = container;
            
            const floatingPanel = shadow.querySelector('.floating-panel');
            const header = shadow.querySelector('.panel-header');
            
            // 添加拖拽功能
            this._initDragFeature(header, floatingPanel);
            
            // 添加自动收起功能
            this._initAutoCollapse(floatingPanel);
            
            // 添加点击展开/收起功能
            header.addEventListener('click', (e) => {
                if (!this.isDragging) {
                    floatingPanel.classList.toggle('expanded');
                }
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

                // 更新当前代理信息显示
                const activeProxyInfo = this.panel.shadowRoot?.querySelector('.active-proxy-info');
                if (activeProxyInfo) {
                    let proxyIcon = '🟢';
                    let proxyName = '直接连接';
                    
                    if (currentProxy.currentMode === 'system') {
                        proxyIcon = '⚙️';
                        proxyName = '系统代理';
                    } else if (currentProxy.currentMode === 'fixed_servers') {
                        const activeConfig = configs.find(c => c.enabled);
                        if (activeConfig) {
                            proxyIcon = activeConfig.proxyType === 'pac_script' ? '📜' : '🌐';
                            proxyName = activeConfig.name || '未命名代理';
                        }
                    }
                    
                    activeProxyInfo.innerHTML = `
                        <span>${proxyIcon}</span>
                        <span>${proxyName}</span>
                    `;
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
                <span>🟢</span>
                <span>直接连接</span>
                ${currentProxy.currentMode === 'direct' ? '<div class="proxy-status"></div>' : ''}
            </div>
            <div class="proxy-item ${currentProxy.currentMode === 'system' ? 'active' : ''}" 
                 data-id="system"
                 title="系统代理">
                <span>⚙️</span>
                <span>系统代理</span>
                ${currentProxy.currentMode === 'system' ? '<div class="proxy-status"></div>' : ''}
            </div>
            <div class="divider"></div>
        `;

        // 添加自定义代理配置
        configs.forEach(config => {
            if (config.proxyType !== 'direct' && config.proxyType !== 'system') {
                const isActive = currentProxy.currentMode === 'fixed_servers' && config.enabled;
                const proxyIcon = config.proxyType === 'pac_script' ? '📜' : '🌐';
                
                // 构建 title 提示信息
                let tooltipText;
                if (config.proxyType === 'pac_script') {
                    tooltipText = 'PAC Script';
                } else {
                    const scheme = config.scheme ? `${config.scheme.toUpperCase()} ` : '';
                    tooltipText = `${scheme}${config.host}:${config.port}`;
                }
                
                html += `
                    <div class="proxy-item ${isActive ? 'active' : ''}" 
                         data-id="${config.id}"
                         title="${tooltipText}">
                        <span>${proxyIcon}</span>
                        <span>${config.name || '未命名代理'}</span>
                        ${isActive ? '<div class="proxy-status"></div>' : ''}
                    </div>
                `;
            }
        });

        html += `
            <div class="divider"></div>
            <div class="action-button add-proxy">
                <span>➕</span>
                <span>添加代理</span>
            </div>
            <div class="action-button settings">
                <span>⚙️</span>
                <span>设置</span>
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
    },
    
    _initDragFeature(header, panel) {
        let isDragging = false;
        let startY = 0;
        let startTop = 0;
        let rafId = null;

        const updatePosition = (e) => {
            if (!isDragging) return;
            
            const deltaY = e.clientY - startY;
            const newTop = startTop + deltaY;
            
            // 限制拖动范围在视窗内
            const maxTop = window.innerHeight - panel.offsetHeight;
            const boundedTop = Math.max(0, Math.min(newTop, maxTop));
            
            // 保持水平位置不变，只改变垂直位置
            panel.style.top = `${boundedTop}px`;
            panel.style.transform = 'translateY(0)'; // 移除默认的 translateY(-50%)
        };

        const onMouseDown = (e) => {
            // 如果点击时是展开状态，则处理展开/收起
            if (panel.classList.contains('expanded')) {
                panel.classList.remove('expanded');
                return;
            }

            if (e.button !== 0) return; // 只响应左键
            
            isDragging = true;
            startY = e.clientY;
            
            // 获取当前实际位置
            const rect = panel.getBoundingClientRect();
            startTop = rect.top;
            
            // 开始拖动时固定当前位置
            panel.style.top = `${startTop}px`;
            panel.style.transform = 'translateY(0)';
            
            // 添加拖动时的视觉反馈
            panel.style.transition = 'none';
            panel.classList.add('dragging');
            
            // 防止文本选择
            e.preventDefault();
        };
        
        const onMouseMove = (e) => {
            if (!isDragging) return;
            
            // 使用 requestAnimationFrame 优化性能
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => updatePosition(e));
        };
        
        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            
            // 清理
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            
            panel.classList.remove('dragging');
            panel.style.transition = '';
            
            // 保存位置
            const top = panel.getBoundingClientRect().top;
            const viewportHeight = window.innerHeight;
            const percentage = (top / viewportHeight) * 100;
            localStorage.setItem('yakitProxyPanelPosition', percentage.toString());
        };

        // 修改事件监听
        header.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove, { passive: true });
        document.addEventListener('mouseup', onMouseUp);

        // 恢复保存的位置
        const savedPosition = localStorage.getItem('yakitProxyPanelPosition');
        if (savedPosition) {
            const top = (parseFloat(savedPosition) / 100) * window.innerHeight;
            panel.style.top = `${top}px`;
            panel.style.transform = 'translateY(0)';
        }
    },
    
    _initAutoCollapse(panel) {
        let leaveTimer = null;
        
        const onMouseLeave = () => {
            if (panel.classList.contains('expanded')) {
                leaveTimer = setTimeout(() => {
                    panel.classList.remove('expanded');
                }, 300); // 300ms 延迟，避免意外触发
            }
        };
        
        const onMouseEnter = () => {
            if (leaveTimer) {
                clearTimeout(leaveTimer);
                leaveTimer = null;
            }
        };
        
        panel.addEventListener('mouseleave', onMouseLeave);
        panel.addEventListener('mouseenter', onMouseEnter);
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

