import React, { useState } from 'react';
import { Table, Button, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, FilterFilled } from '@ant-design/icons';
import { ProxyLog } from '@/types/proxy';
import { LogDetail } from './LogDetail';

interface ProxyLogsProps {
    logs: ProxyLog[];
    onClearLogs: () => void;
}

export const ProxyLogs: React.FC<ProxyLogsProps> = ({
    logs,
    onClearLogs
}) => {
    const [selectedLog, setSelectedLog] = useState<ProxyLog | null>(null);
    const [resourceFilter, setResourceFilter] = useState<string[]>([]);

    const columns: ColumnsType<ProxyLog> = [
        {
            title: '时间',
            dataIndex: 'timestamp',
            key: 'timestamp',
            render: (timestamp: number) => new Date(timestamp).toLocaleString()
        },
        {
            title: 'URL',
            dataIndex: 'url',
            key: 'url',
            ellipsis: true
        },
        {
            title: (
                <Space>
                    类型
                    {resourceFilter.length > 0 && <FilterFilled style={{ color: '#f50' }} />}
                </Space>
            ),
            dataIndex: 'resourceType',
            key: 'resourceType',
            render: (type: string) => {
                const typeMap: Record<string, string> = {
                    xhr: 'XHR',
                    fetch: 'Fetch',
                    script: 'JS',
                    stylesheet: 'CSS',
                    image: 'Image',
                    other: 'Other'
                };
                return typeMap[type] || 'Other';
            },
            filters: [
                { text: 'XHR', value: 'xhr' },
                { text: 'Fetch', value: 'fetch' },
                { text: 'JS', value: 'script' },
                { text: 'CSS', value: 'stylesheet' },
                { text: 'Image', value: 'image' },
                { text: 'Other', value: 'other' }
            ],
            filterMode: 'menu' as const,
            filtered: resourceFilter.length > 0,
            onFilter: (value: string, record: ProxyLog) => record.resourceType === value
        },
        {
            title: '使用代理',
            dataIndex: 'proxyName',
            key: 'proxyName'
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            render: (status: string) => (
                <span style={{ color: status === 'success' ? '#52c41a' : '#ff4d4f' }}>
                    {status === 'success' ? '成功' : '失败'}
                </span>
            )
        },
        {
            title: '错误信息',
            dataIndex: 'errorMessage',
            key: 'errorMessage',
            ellipsis: true
        }
    ];

    const filteredLogs = logs.filter(log => {
        if (resourceFilter.length === 0) return true;
        return resourceFilter.includes(log.resourceType || 'other');
    });

    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <div style={{ 
                marginBottom: 16, 
                display: 'flex', 
                justifyContent: 'flex-end' 
            }}>
                <Button 
                    danger 
                    onClick={onClearLogs}
                    icon={<DeleteOutlined />}
                >
                    清除日志
                </Button>
            </div>
            
            <Table 
                dataSource={filteredLogs}
                columns={columns}
                onRow={(record) => ({
                    onClick: () => setSelectedLog(record),
                    style: { cursor: 'pointer' }
                })}
                pagination={{ 
                    pageSize: 10,
                    showSizeChanger: true,
                    showQuickJumper: true,
                    showTotal: (total) => `共 ${total} 条`,
                    pageSizeOptions: ['10', '20', '50', '100']
                }}
                rowKey="id"
            />
            <LogDetail 
                log={selectedLog} 
                onClose={() => setSelectedLog(null)} 
            />
        </Space>
    );
}; 