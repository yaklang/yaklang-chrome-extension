// Links Finder Module
class LinksFinder {
    constructor() {
        this.links = [];
        this.lastUpdate = null;
    }

    // 获取页面所有链接
    getAllLinks() {
        const links = [];
        const seen = new Set();

        // 获取所有 a 标签
        document.querySelectorAll('a').forEach(a => {
            const href = a.href;
            if (href && !seen.has(href) && href.startsWith('http')) {
                seen.add(href);
                links.push({
                    type: 'anchor',
                    url: href,
                    text: a.textContent.trim() || href,
                });
            }
        });

        // 获取所有图片链接
        document.querySelectorAll('img').forEach(img => {
            const src = img.src;
            if (src && !seen.has(src) && src.startsWith('http')) {
                seen.add(src);
                links.push({
                    type: 'image',
                    url: src,
                    alt: img.alt || 'Image',
                });
            }
        });

        // 获取所有脚本链接
        document.querySelectorAll('script').forEach(script => {
            const src = script.src;
            if (src && !seen.has(src) && src.startsWith('http')) {
                seen.add(src);
                links.push({
                    type: 'script',
                    url: src,
                });
            }
        });

        // 获取所有样式表链接
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            const href = link.href;
            if (href && !seen.has(href) && href.startsWith('http')) {
                seen.add(href);
                links.push({
                    type: 'stylesheet',
                    url: href,
                });
            }
        });

        this.links = links;
        this.lastUpdate = new Date();
        return links;
    }

    // 按类型过滤链接
    filterLinksByType(type) {
        return this.links.filter(link => link.type === type);
    }

    // 获取链接统计信息
    getLinkStats() {
        const stats = {
            total: this.links.length,
            byType: {}
        };

        this.links.forEach(link => {
            if (!stats.byType[link.type]) {
                stats.byType[link.type] = 0;
            }
            stats.byType[link.type]++;
        });

        return stats;
    }

    // 构建链接面板的 HTML
    buildLinksPanel() {
        const links = this.getAllLinks();
        const stats = this.getLinkStats();

        let html = `
            <div class="links-stats">
                <div class="stats-item">
                    <span>🔗</span>
                    <span>总链接: ${stats.total}</span>
                </div>
            </div>
            <div class="links-filters">
                <button class="filter-btn active" data-type="all">
                    <span>🔍</span>
                    <span>全部 (${stats.total})</span>
                </button>
                ${Object.entries(stats.byType).map(([type, count]) => `
                    <button class="filter-btn" data-type="${type}">
                        <span>${this._getTypeIcon(type)}</span>
                        <span>${this._getTypeName(type)} (${count})</span>
                    </button>
                `).join('')}
            </div>
            <div class="links-list">
                ${links.map(link => this._buildLinkItem(link)).join('')}
            </div>
        `;

        return html;
    }

    // 获取链接类型图标
    _getTypeIcon(type) {
        const icons = {
            anchor: '🔗',
            image: '🖼️',
            script: '📜',
            stylesheet: '🎨'
        };
        return icons[type] || '🔗';
    }

    // 获取链接类型名称
    _getTypeName(type) {
        const names = {
            anchor: '链接',
            image: '图片',
            script: '脚本',
            stylesheet: '样式'
        };
        return names[type] || type;
    }

    // 构建单个链接项的 HTML
    _buildLinkItem(link) {
        return `
            <div class="link-item" data-type="${link.type}">
                <div class="link-icon">${this._getTypeIcon(link.type)}</div>
                <div class="link-content">
                    <div class="link-url" title="${link.url}">${link.url}</div>
                    ${link.text ? `<div class="link-text" title="${link.text}">${link.text}</div>` : ''}
                    ${link.alt ? `<div class="link-alt" title="${link.alt}">${link.alt}</div>` : ''}
                </div>
                <button class="copy-btn" data-url="${link.url}" title="复制链接">📋</button>
            </div>
        `;
    }

    // 绑定事件处理
    bindEvents(container) {
        // 过滤按钮点击事件
        container.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const type = btn.dataset.type;
                console.log('Filter clicked:', type);
                
                // 更新按钮状态
                container.querySelectorAll('.filter-btn').forEach(b => {
                    b.classList.remove('active');
                });
                btn.classList.add('active');

                // 过滤链接显示
                container.querySelectorAll('.link-item').forEach(item => {
                    if (type === 'all' || item.dataset.type === type) {
                        item.removeAttribute('data-hidden');
                    } else {
                        item.setAttribute('data-hidden', 'true');
                    }
                });
            });
        });

        // 复制按钮点击事件
        container.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const url = btn.dataset.url;
                try {
                    await navigator.clipboard.writeText(url);
                    const originalText = btn.textContent;
                    btn.textContent = '✓';
                    btn.style.setProperty('color', '#52c41a', 'important');
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.removeProperty('color');
                    }, 1000);
                } catch (err) {
                    console.error('Failed to copy:', err);
                    btn.textContent = '❌';
                    setTimeout(() => {
                        btn.textContent = '📋';
                    }, 1000);
                }
            });
        });
    }
}

console.log("LinksFinder module loaded");
// 导出模块
window.LinksFinder = LinksFinder; 