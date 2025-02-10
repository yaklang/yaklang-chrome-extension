import React, { useRef } from 'react';
import { Card, Input, Space, Button, Select, InputNumber, Form, Table, Tooltip, Popover } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { ProxyConfig } from '@/types/proxy';

interface ProxySettingsProps {
    proxyConfigs: ProxyConfig[];
    onAdd: () => void;
    onChange: (configId: string, field: keyof ProxyConfig, value: any) => void;
    onDelete: (configId: string) => void;
    onApply: (configId: string) => Promise<void>;
    onClear: (configId: string) => Promise<void>;
}

export const ProxySettings: React.FC<ProxySettingsProps> = ({
    proxyConfigs,
    onAdd,
    onChange,
    onDelete,
    onApply,
    onClear
}) => {
    const columns: ColumnsType<ProxyConfig> = [
        {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
            render: (text: string, record: ProxyConfig) => (
                <Input
                    value={text}
                    onChange={e => onChange(record.id, 'name', e.target.value)}
                    disabled={record.id === 'direct'}
                />
            )
        },
        {
            title: '类型',
            dataIndex: 'proxyType',
            key: 'proxyType',
            render: (text: string, record: ProxyConfig) => (
                <Select
                    value={text}
                    onChange={value => onChange(record.id, 'proxyType', value)}
                    style={{ width: 120 }}
                    disabled={record.id === 'direct'}
                    options={[
                        { label: '直接连接', value: 'direct' },
                        { label: '代理服务器', value: 'fixed_server' },
                        { label: 'PAC 脚本', value: 'pac_script' }
                    ]}
                />
            )
        },
        {
            title: '协议',
            dataIndex: 'scheme',
            key: 'scheme',
            render: (text: string, record: ProxyConfig) => (
                record.proxyType === 'fixed_server' && (
                    <Select
                        value={text}
                        onChange={value => onChange(record.id, 'scheme', value)}
                        style={{ width: 100 }}
                        options={[
                            { label: 'HTTP', value: 'http' },
                            { label: 'HTTPS', value: 'https' },
                            { label: 'SOCKS4', value: 'socks4' },
                            { label: 'SOCKS5', value: 'socks5' }
                        ]}
                    />
                )
            )
        },
        {
            title: '主机',
            dataIndex: 'host',
            key: 'host',
            render: (text: string, record: ProxyConfig) => (
                record.proxyType === 'fixed_server' && (
                    <Input
                        value={text}
                        onChange={e => onChange(record.id, 'host', e.target.value)}
                        placeholder="127.0.0.1"
                    />
                )
            )
        },
        {
            title: '端口',
            dataIndex: 'port',
            key: 'port',
            render: (text: number, record: ProxyConfig) => (
                record.proxyType === 'fixed_server' && (
                    <InputNumber
                        value={text}
                        onChange={value => onChange(record.id, 'port', value)}
                        min={1}
                        max={65535}
                    />
                )
            )
        },
        {
            title: 'PAC 脚本',
            dataIndex: 'pacScript',
            key: 'pacScript',
            render: (text: string, record: ProxyConfig) => (
                record.proxyType === 'pac_script' && (
                    <Input.TextArea
                        value={text}
                        onChange={e => onChange(record.id, 'pacScript', e.target.value)}
                        rows={4}
                        placeholder="输入 PAC 脚本"
                    />
                )
            )
        },
        {
            title: '操作',
            key: 'action',
            render: (_, record: ProxyConfig) => (
                <Space>
                    <Button
                        type={record.enabled ? "primary" : "default"}
                        danger={record.enabled}
                        onClick={() => record.enabled ? 
                            onClear(record.id) : 
                            onApply(record.id)
                        }
                    >
                        {record.enabled ? '取消应用' : '应用选项'}
                    </Button>
                    {record.id !== 'direct' && (
                        <Button 
                            danger 
                            icon={<DeleteOutlined />}
                            onClick={() => onDelete(record.id)}
                        />
                    )}
                </Space>
            )
        }
    ];

    const buttonRef = useRef(null);

    return (
        <div>
            <Space style={{ marginBottom: 16, justifyContent: 'flex-end', width: '100%' }}>
                <Popover content="添加代理" trigger="hover">
                    <Button ref={buttonRef} onClick={onAdd}>
                        添加代理
                    </Button>
                </Popover>
            </Space>
            <Table 
                dataSource={proxyConfigs}
                columns={columns}
                rowKey="id"
                pagination={false}
            />
        </div>
    );
}; 