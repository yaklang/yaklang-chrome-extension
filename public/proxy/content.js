console.log("Content script starting...");

// 代理操作类型常量
const ProxyActionType = {
    SET_PROXY_CONFIG: 'SET_PROXY_CONFIG',
    CLEAR_PROXY_CONFIG: 'CLEAR_PROXY_CONFIG',
    GET_PROXY_STATUS: 'GET_PROXY_STATUS',
    GET_PROXY_CONFIGS: 'GET_PROXY_CONFIGS',
    UPDATE_PROXY_CONFIG: 'UPDATE_PROXY_CONFIG'
};

// 添加一个通用的消息发送函数
async function sendMessageWithRetry(message, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await chrome.runtime.sendMessage(message);
            return response;
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
        
        if (!response) {
            console.log('No response from background script');
            return { enable: false, proxy: '' };
        }

        // 检查响应格式
        if (!response.success) {
            console.error('Error in proxy status response:', response.error);
            return { enable: false, proxy: '' };
        }

        const status = response.data;
        console.log('Proxy status from background:', status);

        // 根据状态返回正确的格式
        if (status.mode === 'fixed_servers' && status.enabled && status.config) {
            const config = status.config;
            // 只在确实有配置时才返回代理信息
            if (config.scheme && config.host && config.port) {
                return {
                    enable: true,
                    proxy: `${config.scheme}://${config.host}:${config.port}`
                };
            }
        }
        
        // 对于直连或系统代理，返回相应状态
        return {
            enable: false,
            proxy: status.mode === 'system' ? 'system' : ''
        };
    } catch (error) {
        console.error('Error getting proxy status:', error);
        return { enable: false, proxy: '' };
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
        await sendMessageWithRetry({
            action: ProxyActionType.SET_PROXY_CONFIG,
            config: config
        });
        
        await updatePanel();
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
        await updatePanel();
    } catch (error) {
        console.error('Error clearing proxy:', error);
    }
}

// 更新面板显示
async function updatePanel() {
    const panel = document.getElementById('yakit-proxy-panel')?.shadowRoot?.querySelector('.panel-content');
    if (!panel) return;

    const currentProxy = await getCurrentProxy();
    const configs = await getProxyConfigs();
    
    console.log('Current proxy status:', currentProxy);
    
    // 修改这里的判断逻辑
    let html = `
        <div class="proxy-item ${currentProxy.proxy === '' ? 'active' : ''}" data-id="direct">
            <span style="color: ${currentProxy.proxy === '' ? '#ff6b00' : '#666'}">🔴</span>
            <span>[直接连接]</span>
        </div>
        <div class="proxy-item ${currentProxy.proxy === 'system' ? 'active' : ''}" data-id="system">
            <span style="color: ${currentProxy.proxy === 'system' ? '#ff6b00' : '#666'}">⚙️</span>
            <span>[系统代理]</span>
        </div>
    `;

    // 添加自定义代理配置
    configs.forEach(config => {
        if (config.id !== 'direct' && config.id !== 'system') {
            // 检查当前代理是否与配置匹配
            const isActive = currentProxy.enable && 
                           currentProxy.proxy === `${config.scheme}://${config.host}:${config.port}`;
            html += `
                <div class="proxy-item ${isActive ? 'active' : ''}" data-id="${config.id}">
                    <span style="color: ${isActive ? '#ff6b00' : '#666'}">🌐</span>
                    <span>${config.name}</span>
                </div>
            `;
        }
    });

    // 修改添加操作按钮部分
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

    panel.innerHTML = html;

    // 添加事件监听
    panel.querySelectorAll('.proxy-item').forEach(item => {
        item.addEventListener('click', async () => {
            const id = item.dataset.id;
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
        });
    });

    // 修改添加代理和选项按钮的事件处理
    panel.querySelector('.add-proxy')?.addEventListener('click', async () => {
        try {
            // 通过发送消息给 background script 来处理添加代理
            await sendMessageWithRetry({ 
                action: 'OPEN_OPTIONS_PAGE',
                triggerAdd: true  // 标记需要触发添加代理
            });
        } catch (error) {
            console.error('Error handling add proxy:', error);
        }
    });

    panel.querySelector('.settings')?.addEventListener('click', async () => {
        try {
            // 通过发送消息给 background script 来打开选项页
            await sendMessageWithRetry({ 
                action: 'OPEN_OPTIONS_PAGE'
            });
        } catch (error) {
            console.error('Error opening options page:', error);
        }
    });
}

// 创建并注入悬浮框
function createFloatingPanel() {
    console.log("Creating floating panel...");
    
    // 检查是否已存在面板
    if (document.getElementById('yakit-proxy-panel')) {
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
            width: 200px;
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
            padding: 12px;
        }

        .proxy-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            cursor: pointer;
            transition: all 0.2s;
            color: #666;
            border-left: 3px solid transparent;
        }

        .proxy-item:hover {
            background: #f5f5f5;
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

        .proxy-item:hover span:first-child {
            color: #ff6b00;
        }

        .add-proxy {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            color: #1890ff;
            cursor: pointer;
            border-top: 1px solid #eee;
            transition: all 0.2s;
        }

        .add-proxy:hover {
            background: #f5f5f5;
        }

        .settings {
            padding: 8px 12px;
            color: #666;
            cursor: pointer;
            border-top: 1px solid #eee;
            transition: all 0.2s;
        }

        .settings:hover {
            background: #f5f5f5;
        }
    `;

    // 创建面板内容
    const panel = document.createElement('div');
    panel.className = 'floating-panel';
    panel.innerHTML = `
        <div class="collapse-trigger"></div>
        <div class="panel-header">
            <span>代理设置</span>
        </div>
        <div class="panel-content">
            <div class="proxy-item active">
                <span>🔴</span>
                <span>[直接连接]</span>
            </div>
            <div class="proxy-item">
                <span>⚙️</span>
                <span>[系统代理]</span>
            </div>
            <div class="add-proxy">
                <span>➕</span>
                <span>添加代理...</span>
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
    
    // 将容器添加到页面
    document.body.appendChild(container);

    // 添加事件监听器
    const addEventListeners = () => {
        // 收起/展开功能
        panel.querySelector('.collapse-trigger')?.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('collapsed');
        });

        // 添加代理按钮
        panel.querySelector('.add-proxy')?.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS_PAGE' });
        });

        // 设置按钮
        panel.querySelector('.settings')?.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS_PAGE' });
        });
    };

    // 初始化事件监听器
    addEventListeners();

    // 初始更新面板
    updatePanel();

    // 添加代理变化监听
    let messageListener = (message) => {
        if (message.action === 'PROXY_STATUS_CHANGED') {
            updatePanel();
        }
    };

    // 确保只添加一次监听器
    chrome.runtime.onMessage.removeListener(messageListener);
    chrome.runtime.onMessage.addListener(messageListener);

    // 验证面板是否成功创建
    console.log("Panel created:", {
        containerExists: !!document.getElementById('yakit-proxy-panel'),
        containerVisible: window.getComputedStyle(container).display !== 'none',
        shadowRoot: !!container.shadowRoot,
        panelElement: !!container.shadowRoot?.querySelector('.floating-panel')
    });
}

// 使用 MutationObserver 确保在 DOM 准备好时创建面板
function initPanel() {
    if (document.body) {
        console.log("Body found, creating panel");
        // 确保background script已经准备好
        sendMessageWithRetry({ action: 'PING' })
            .then(() => {
                createFloatingPanel();
            })
            .catch(error => {
                console.error('Failed to initialize panel:', error);
                // 可以在这里添加重试逻辑
                setTimeout(initPanel, 1000);
            });
    } else {
        console.log("Body not found, waiting...");
        const observer = new MutationObserver((mutations, obs) => {
            if (document.body) {
                console.log("Body found via observer");
                obs.disconnect();
                initPanel();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }
}

// 尝试多种方式来确保面板被创建
console.log("Setting up initialization...");

window.addEventListener('load', () => {
    console.log("Window load triggered");
    initPanel();
});

// 在关键位置添加更多日志
console.log("Document readyState:", document.readyState);
console.log("Document body exists:", !!document.body);
console.log("Document documentElement exists:", !!document.documentElement);
