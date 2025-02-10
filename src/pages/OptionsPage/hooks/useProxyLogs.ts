import { useState, useEffect } from 'react';
import { ProxyLog } from '@/types/proxy';
import { ProxyActionType } from '@/types/action';

export const useProxyLogs = () => {
    const [proxyLogs, setProxyLogs] = useState<ProxyLog[]>([]);

    useEffect(() => {
        loadLogs();
        
        // 监听日志更新
        const handleLogsUpdate = () => {
            loadLogs();
        };
        
        chrome.runtime.onMessage.addListener((message) => {
            if (message.action === 'PROXY_LOGS_UPDATED') {
                handleLogsUpdate();
            }
        });

        return () => {
            chrome.runtime.onMessage.removeListener(handleLogsUpdate);
        };
    }, []);

    const loadLogs = async () => {
        try {
            console.log('Fetching proxy logs...');
            const response = await chrome.runtime.sendMessage({
                action: 'GET_PROXY_LOGS'
            });
            console.log('Received response:', response);
            if (response.success) {
                setProxyLogs(response.data || []);
            } else {
                console.error('Failed to load logs:', response.error);
            }
        } catch (error) {
            console.error('Error loading logs:', error);
        }
    };

    const handleClearLogs = async () => {
        try {
            await chrome.runtime.sendMessage({
                action: ProxyActionType.CLEAR_PROXY_LOGS
            });
            setProxyLogs([]);
        } catch (error) {
            console.error('Error clearing logs:', error);
        }
    };

    return {
        proxyLogs,
        handleClearLogs
    };
}; 