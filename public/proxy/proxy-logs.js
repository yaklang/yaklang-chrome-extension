import { proxyStore } from '../db/proxy-store.js';

// 日志数据库管理
class ProxyLogs {
    async getResourceType(details) {
        try {
            // 首先检查请求类型
            if (details.type) {
                // 直接使用 Chrome 提供的类型
                switch (details.type) {
                    case 'main_frame': return 'page';
                    case 'xmlhttprequest': {
                        // 检查请求头来区分 XHR 和 Fetch
                        const isFetch = details.requestHeaders?.some(
                            header => header.name.toLowerCase() === 'sec-fetch-mode' && 
                                    header.value === 'cors'
                        );
                        return isFetch ? 'fetch' : 'xhr';
                    }
                    case 'script': return 'script';
                    case 'stylesheet': return 'stylesheet';
                    case 'image': return 'image';
                    case 'media': return 'media';
                    case 'font': return 'font';
                    case 'websocket': return 'websocket';
                }
            }

            // 根据文件扩展名和内容类型判断
            const contentType = details.requestHeaders?.find(
                header => header.name.toLowerCase() === 'content-type'
            )?.value || '';

            const url = new URL(details.url);
            const pathname = url.pathname.toLowerCase();

            // 检查文件扩展名
            if (pathname.endsWith('.js')) return 'script';
            if (pathname.endsWith('.css')) return 'stylesheet';
            if (/\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(pathname)) return 'image';
            if (/\.(mp3|mp4|wav|ogg|webm)$/.test(pathname)) return 'media';
            if (/\.(woff|woff2|ttf|eot|otf)$/.test(pathname)) return 'font';

            // 根据内容类型判断
            if (contentType) {
                if (contentType.includes('javascript')) return 'script';
                if (contentType.includes('css')) return 'stylesheet';
                if (contentType.includes('image/')) return 'image';
                if (contentType.includes('audio/') || contentType.includes('video/')) return 'media';
                if (contentType.includes('font/') || contentType.includes('application/font')) return 'font';
                if (contentType.includes('application/json')) return 'xhr';
                if (contentType.includes('application/x-www-form-urlencoded')) return 'xhr';
            }

            // 检查 Accept 头
            const acceptHeader = details.requestHeaders?.find(
                header => header.name.toLowerCase() === 'accept'
            )?.value || '';

            if (acceptHeader) {
                if (acceptHeader.includes('application/json')) return 'xhr';
                if (acceptHeader.includes('text/javascript')) return 'script';
                if (acceptHeader.includes('text/css')) return 'stylesheet';
                if (acceptHeader.includes('image/')) return 'image';
            }

            console.log('Resource type detection:', {
                url: details.url,
                type: details.type,
                contentType,
                acceptHeader,
                headers: details.requestHeaders
            });

            return 'other';
        } catch (error) {
            console.error('Error determining resource type:', error);
            return 'other';
        }
    }

    async logRequest(details, proxyConfig, error = null) {
        try {
            // 检查是否是扩展自身的请求
            if (details.url.startsWith('chrome-extension://')) {
                return;
            }

            // 获取资源类型
            const resourceType = await this.getResourceType(details);
            
            const log = {
                id: Date.now().toString(),
                timestamp: Date.now(),
                url: details.url,
                proxyId: proxyConfig.id,
                proxyName: proxyConfig.name,
                status: error ? 'error' : 'success',
                errorMessage: error?.message,
                method: details.method,
                requestHeaders: details.requestHeaders?.reduce((acc, header) => {
                    acc[header.name] = header.value;
                    return acc;
                }, {}),
                requestBody: details.requestBody?.raw?.[0]?.bytes 
                    ? decodeURIComponent(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes)))
                    : null,
                responseHeaders: details.responseHeaders?.reduce((acc, header) => {
                    acc[header.name] = header.value;
                    return acc;
                }, {}),
                timing: {
                    startTime: details.timeStamp,
                    endTime: Date.now(),
                    duration: Date.now() - details.timeStamp
                },
                protocol: details.protocol || details.type,
                ip: details.ip,
                fromCache: details.fromCache,
                resourceType
            };

            // 使用 proxyStore 存储日志
            await proxyStore.addLog(log);
            this.notifyLogUpdate();
        } catch (error) {
            console.error('Error logging proxy request:', error);
        }
    }

    async getLogs() {
        return await proxyStore.getLogs();
    }

    async clearLogs() {
        await proxyStore.clearLogs();
        this.notifyLogUpdate();
    }

    notifyLogUpdate() {
        // 通知前端日志已更新
        chrome.runtime.sendMessage({
            action: 'PROXY_LOGS_UPDATED'
        }).catch(() => {
            // 忽略接收者不存在的错误
        });
    }
}

export const proxyLogs = new ProxyLogs();