import React from 'react';
import { Modal, Button, Space, Descriptions, Tabs, Card, Typography, message } from 'antd';
import { ProxyLog } from '@/types/proxy';

const { Text, Paragraph } = Typography;

interface LogDetailProps {
    log: ProxyLog | null;
    onClose: () => void;
}

export const LogDetail: React.FC<LogDetailProps> = ({ log, onClose }) => {
    const renderHttpRequest = (log: ProxyLog) => {
        if (!log) return '';
        
        // 构建请求头
        const headers = Object.entries(log.requestHeaders || {})
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');

        // 构建完整的 HTTP 请求
        return `${log.method || 'GET'} ${log.url} ${log.protocol || 'HTTP/1.1'}
${headers}

${log.requestBody || ''}`;
    };

    const renderHttpResponse = (log: ProxyLog) => {
        if (!log || !log.responseHeaders) return '';

        // 构建响应头
        const headers = Object.entries(log.responseHeaders)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');

        // 构建完整的 HTTP 响应
        return `HTTP/1.1 ${log.status === 'success' ? '200 OK' : '500 Error'}
${headers}

${log.responseBody || ''}`;
    };

    const handleCopyRaw = () => {
        if (!log) return;
        navigator.clipboard.writeText(renderHttpRequest(log))
            .then(() => message.success('已复制到剪贴板'))
            .catch(() => message.error('复制失败'));
    };

    const formatProxyInfo = (log: ProxyLog) => {
        if (!log) return '';
        return `${log.proxyName}${log.host ? ` - ${log.host}:${log.port}` : ''}`;
    };

    return (
        <Modal
            title="请求详情"
            open={!!log}
            onCancel={onClose}
            width={800}
            footer={[
                <Button key="copy" onClick={handleCopyRaw}>
                    复制原始数据
                </Button>,
                <Button key="close" onClick={onClose}>
                    关闭
                </Button>
            ]}
        >
            {log && (
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Descriptions bordered column={2}>
                        <Descriptions.Item label="请求时间">
                            {new Date(log.timestamp).toLocaleString()}
                        </Descriptions.Item>
                        <Descriptions.Item label="代理服务器">
                            {formatProxyInfo(log)}
                        </Descriptions.Item>
                        <Descriptions.Item label="状态">
                            <Text type={log.status === 'success' ? 'success' : 'danger'}>
                                {log.status === 'success' ? '成功' : '失败'}
                            </Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="响应时间">
                            {log.timing?.duration}ms
                        </Descriptions.Item>
                        {log.errorMessage && (
                            <Descriptions.Item label="错误信息" span={2}>
                                <Text type="danger">{log.errorMessage}</Text>
                            </Descriptions.Item>
                        )}
                    </Descriptions>

                    <Tabs
                        items={[
                            {
                                key: 'request',
                                label: '请求数据',
                                children: (
                                    <Card size="small">
                                        <pre style={{ 
                                            background: '#f5f5f5', 
                                            padding: 16,
                                            borderRadius: 4,
                                            maxHeight: 400,
                                            overflow: 'auto',
                                            margin: 0
                                        }}>
                                            {renderHttpRequest(log)}
                                        </pre>
                                    </Card>
                                )
                            },
                            {
                                key: 'response',
                                label: '响应数据',
                                children: (
                                    <Card size="small">
                                        <pre style={{ 
                                            background: '#f5f5f5', 
                                            padding: 16,
                                            borderRadius: 4,
                                            maxHeight: 400,
                                            overflow: 'auto',
                                            margin: 0
                                        }}>
                                            {renderHttpResponse(log)}
                                        </pre>
                                    </Card>
                                )
                            },
                            {
                                key: 'timing',
                                label: '性能数据',
                                children: (
                                    <Card size="small">
                                        <Descriptions bordered>
                                            <Descriptions.Item label="开始时间">
                                                {new Date(log.timing?.startTime || 0).toLocaleString()}
                                            </Descriptions.Item>
                                            <Descriptions.Item label="结束时间">
                                                {new Date(log.timing?.endTime || 0).toLocaleString()}
                                            </Descriptions.Item>
                                            <Descriptions.Item label="总耗时">
                                                {log.timing?.duration}ms
                                            </Descriptions.Item>
                                            <Descriptions.Item label="IP地址">
                                                {log.ip || '-'}
                                            </Descriptions.Item>
                                            <Descriptions.Item label="协议">
                                                {log.protocol || '-'}
                                            </Descriptions.Item>
                                            <Descriptions.Item label="缓存">
                                                {log.fromCache ? '是' : '否'}
                                            </Descriptions.Item>
                                        </Descriptions>
                                    </Card>
                                )
                            }
                        ]}
                    />
                </Space>
            )}
        </Modal>
    );
}; 