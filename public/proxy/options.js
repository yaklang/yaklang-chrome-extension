console.log('Options page script loaded');

import { ProxySettings } from './proxy-settings.js';
import { ProxyManager } from './proxy-manager.js';

let currentConfigs = [];

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initOptionsPage();
        setupEventListeners();
    } catch (error) {
        console.error('Failed to initialize options page:', error);
        showError(error.message);
    }
});

async function initOptionsPage() {
    const result = await ProxySettings.exportSettings();
    currentConfigs = result.settings || [];
    renderProxyConfigs();
}

function renderProxyConfigs() {
    const proxyList = document.getElementById('proxyList');
    const template = document.getElementById('proxyItemTemplate');
    
    // 清除除了直接连接以外的所有配置
    const items = proxyList.querySelectorAll('.proxy-item:not([data-id="direct"])');
    items.forEach(item => item.remove());

    // 渲染其他代理配置
    currentConfigs.forEach(config => {
        if (config.id === 'direct') return; // 跳过直接连接
        
        const clone = template.content.cloneNode(true);
        const proxyItem = clone.querySelector('.proxy-item');
        
        proxyItem.dataset.id = config.id;
        proxyItem.querySelector('.proxy-name').value = config.name;
        proxyItem.querySelector('.proxy-type-select').value = config.proxyType;

        updateProxyTypeSettings(proxyItem, config);
        proxyList.appendChild(proxyItem);
    });
}

function updateProxyTypeSettings(proxyItem, config) {
    const serverSettings = proxyItem.querySelector('.proxy-server-settings');
    const pacSettings = proxyItem.querySelector('.pac-script-settings');

    if (config.proxyType === 'fixed_server') {
        serverSettings.style.display = 'block';
        pacSettings.style.display = 'none';
        
        proxyItem.querySelector('.proxy-scheme').value = config.scheme || 'http';
        proxyItem.querySelector('.proxy-host').value = config.host || '';
        proxyItem.querySelector('.proxy-port').value = config.port || '';
    } 
    else if (config.proxyType === 'pac_script') {
        serverSettings.style.display = 'none';
        pacSettings.style.display = 'block';
        
        proxyItem.querySelector('.pac-script').value = config.pacScript || '';
    }
    else {
        serverSettings.style.display = 'none';
        pacSettings.style.display = 'none';
    }
}

function setupEventListeners() {
    // 添加代理按钮
    document.getElementById('addProxy').addEventListener('click', addNewProxy);

    // 代理列表变更事件
    document.getElementById('proxyList').addEventListener('change', handleProxyChange);
    
    // 删除代理按钮
    document.getElementById('proxyList').addEventListener('click', handleProxyDelete);
}

async function addNewProxy() {
    const newConfig = {
        id: Date.now().toString(),
        name: '新建代理',
        proxyType: 'fixed_server',
        scheme: 'http',
        host: '127.0.0.1',
        port: 8080
    };

    currentConfigs = [...currentConfigs, newConfig];
    await ProxySettings.importSettings(currentConfigs);
    renderProxyConfigs();
}

async function handleProxyChange(e) {
    const proxyItem = e.target.closest('.proxy-item');
    if (!proxyItem) return;

    const configId = proxyItem.dataset.id;
    const configIndex = currentConfigs.findIndex(c => c.id === configId);
    if (configIndex === -1) return;

    const updatedConfig = { ...currentConfigs[configIndex] };

    if (e.target.classList.contains('proxy-name')) {
        updatedConfig.name = e.target.value;
    } else if (e.target.classList.contains('proxy-type-select')) {
        updatedConfig.proxyType = e.target.value;
        // 如果切换到固定服务器模式，设置默认值
        if (updatedConfig.proxyType === 'fixed_server' && !updatedConfig.scheme) {
            updatedConfig.scheme = 'http';
            updatedConfig.host = '127.0.0.1';
            updatedConfig.port = 8080;
        }
    } else if (e.target.classList.contains('proxy-scheme')) {
        updatedConfig.scheme = e.target.value;
    } else if (e.target.classList.contains('proxy-host')) {
        updatedConfig.host = e.target.value;
    } else if (e.target.classList.contains('proxy-port')) {
        updatedConfig.port = parseInt(e.target.value) || '';
    } else if (e.target.classList.contains('pac-script')) {
        updatedConfig.pacScript = e.target.value;
    }

    currentConfigs[configIndex] = updatedConfig;
    await ProxySettings.importSettings(currentConfigs);
    
    // 如果代理类型改变，需要更新UI
    if (e.target.classList.contains('proxy-type-select')) {
        updateProxyTypeSettings(proxyItem, updatedConfig);
    }
}

async function handleProxyDelete(e) {
    const deleteBtn = e.target.closest('.delete-btn');
    if (!deleteBtn) return;

    const proxyItem = deleteBtn.closest('.proxy-item');
    const configId = proxyItem.dataset.id;
    
    currentConfigs = currentConfigs.filter(c => c.id !== configId);
    await ProxySettings.importSettings(currentConfigs);
    renderProxyConfigs();
}

function showError(message) {
    const container = document.querySelector('.container');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.style.cssText = `
        color: #ff4d4f;
        padding: 8px 16px;
        margin-bottom: 16px;
        background-color: #fff2f0;
        border: 1px solid #ffccc7;
        border-radius: 4px;
    `;
    errorDiv.textContent = message;
    container.insertBefore(errorDiv, container.firstChild);

    // 5秒后自动移除错误信息
    setTimeout(() => {
        errorDiv.remove();
    }, 5000);
}

// ... 其他代码保持不变 