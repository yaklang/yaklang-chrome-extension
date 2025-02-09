import React, { useEffect, useState } from "react";
import { Layout, Button, Card, Input, Select, InputNumber, Space, Typography, Modal, Switch, Tabs, Table, Form, App } from "antd";
import { PlusOutlined, DeleteOutlined, ImportOutlined, ExportOutlined } from "@ant-design/icons";
import { ProxyConfig } from "@/types/proxy";
import { StorageChanges } from "@/types/chrome";
import './index.css';
import { ProxyActionType } from '@/types/action';

const { Header, Content } = Layout;
const { Title } = Typography;
const { TextArea } = Input;

const headerStyle = {
    background: '#fff',
    padding: '0 24px',
    borderBottom: '1px solid #f0f0f0'
};

const contentStyle = {
    padding: '24px',
    background: '#f0f2f5',
    minHeight: '100vh'
};

const titleStyle = {
    margin: '16px 0',
    color: '#31343F'
};

interface ProxyLog {
    id: string;
    timestamp: number;
    url: string;
    proxyId: string;
    proxyName: string;
    status: 'success' | 'error';
    errorMessage?: string;
}

export const OptionsPage: React.FC = () => {
    const { message } = App.useApp();
    const [proxyConfigs, setProxyConfigs] = useState<ProxyConfig[]>([]);
    const [proxyLogs, setProxyLogs] = useState<ProxyLog[]>([]);
    const [activeTab, setActiveTab] = useState('settings');
    const [currentConfigId, setCurrentConfigId] = useState<string>('');

    useEffect(() => {
        loadConfigs();
    }, []);

    const loadConfigs = async () => {
        const result = await chrome.storage.local.get('proxyConfigs');
        setProxyConfigs(result.proxyConfigs || []);
    };

    const handleAddProxy = () => {
        const newConfig: ProxyConfig = {
            id: Date.now().toString(),
            name: '新建代理',
            proxyType: 'fixed_server',
            scheme: 'http',
            host: '127.0.0.1',
            port: 8080,
            enabled: false
        };
        const updatedConfigs = [...proxyConfigs, newConfig];
        chrome.storage.local.set({ proxyConfigs: updatedConfigs });
        setProxyConfigs(updatedConfigs);
    };

    const handleConfigChange = (configId: string, field: keyof ProxyConfig, value: any) => {
        const updatedConfigs = proxyConfigs.map(config => {
            if (config.id === configId) {
                return { ...config, [field]: value };
            }
            return config;
        });
        chrome.storage.local.set({ proxyConfigs: updatedConfigs });
        setProxyConfigs(updatedConfigs);
    };

    const handleDeleteProxy = (configId: string) => {
        Modal.confirm({
            title: '确认删除',
            content: '确定要删除这个代理配置吗？',
            onOk: () => {
                const updatedConfigs = proxyConfigs.filter(config => config.id !== configId);
                chrome.storage.local.set({ proxyConfigs: updatedConfigs });
                setProxyConfigs(updatedConfigs);
            }
        });
    };

    useEffect(() => {
        const handleStorageChange = (changes: StorageChanges) => {
            if (changes.proxyConfigs) {
                setProxyConfigs(changes.proxyConfigs.newValue || []);
            }
        };
        
        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }, []);

    useEffect(() => {
        // 加载日志
        const loadLogs = async () => {
            const result = await chrome.storage.local.get('proxyLogs');
            setProxyLogs(result.proxyLogs || []);
        };
        
        loadLogs();

        // 监听存储变化
        const handleStorageChange = (changes: StorageChanges) => {
            if (changes.proxyLogs) {
                setProxyLogs(changes.proxyLogs.newValue || []);
            }
        };
        
        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }, []);

    const columns = [
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
            ellipsis: true,
            render: (url: string) => (
                <a 
                    href={url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    style={{ 
                        color: '#1890ff',
                        textDecoration: 'none',
                        maxWidth: '400px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block'
                    }}
                    onClick={(e) => {
                        e.preventDefault();
                        chrome.tabs.create({ url });
                    }}
                >
                    {url}
                </a>
            )
        },
        {
            title: '使用代理',
            dataIndex: 'proxyName',
            key: 'proxyName',
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
            ellipsis: true,
        }
    ];

    const handleApplyConfig = async (configId: string) => {
        const config = proxyConfigs.find(c => c.id === configId);
        if (config) {
            try {
                const response = await new Promise<any>((resolve) => {
                    chrome.runtime.sendMessage({
                        action: ProxyActionType.SET_PROXY_CONFIG,
                        config: {
                            ...config,
                            scheme: config.scheme || 'http',
                            host: config.host || '127.0.0.1',
                            port: Number(config.port) || 8080,
                        }
                    }, resolve);
                });

                if (response && response.success) {
                    const updatedConfigs = proxyConfigs.map(c => ({
                        ...c,
                        enabled: c.id === configId
                    }));
                    await chrome.storage.local.set({ proxyConfigs: updatedConfigs });
                    setProxyConfigs(updatedConfigs);
                    message.success('代理设置已应用');
                } else {
                    message.error((response && response.error) || '代理设置失败');
                }
            } catch (error) {
                console.error('Failed to apply proxy config:', error);
                message.error('操作失败');
            }
        }
    };

    const handleClearProxy = async (configId: string) => {
        try {
            const response = await new Promise<any>((resolve) => {
                chrome.runtime.sendMessage({
                    action: ProxyActionType.CLEAR_PROXY_CONFIG
                }, resolve);
            });

            if (response && response.success) {
                const updatedConfigs = proxyConfigs.map(c => ({
                    ...c,
                    enabled: false
                }));
                await chrome.storage.local.set({ proxyConfigs: updatedConfigs });
                setProxyConfigs(updatedConfigs);
                message.success('代理已取消');
            } else {
                message.error((response && response.error) || '取消代理失败');
            }
        } catch (error) {
            console.error('Error clearing proxy:', error);
            message.error('操作失败');
        }
    };

    const handleClearLogs = () => {
        chrome.runtime.sendMessage({
            action: ProxyActionType.CLEAR_PROXY_LOGS
        }, (response) => {
            if (chrome.runtime.lastError) {
                message.error(chrome.runtime.lastError.message || '清除日志失败');
                return;
            }
            if (response?.success) {
                message.success('日志已清除');
            } else {
                message.error(response?.error || '清除日志失败');
            }
        });
    };

    return (
        <Layout className="options-page">
            <Content style={contentStyle}>
                <Tabs
                    activeKey={activeTab}
                    onChange={setActiveTab}
                    className="proxy-tabs"
                    tabBarExtraContent={{
                        right: (
                            <Space>
                                <Button 
                                    type="primary" 
                                    icon={<PlusOutlined />} 
                                    onClick={handleAddProxy}
                                >
                                    添加代理
                                </Button>
                                <Button icon={<ImportOutlined />}>导入</Button>
                                <Button icon={<ExportOutlined />}>导出</Button>
                            </Space>
                        )
                    }}
                    items={[
                        {
                            key: 'settings',
                            label: '代理设置',
                            children: (
                                <Space direction="vertical" style={{ width: '100%' }}>
                                    {proxyConfigs.map(config => (
                                        <Card 
                                            key={config.id}
                                            size="small"
                                            title={
                                                <Input
                                                    placeholder="代理名称"
                                                    value={config.name}
                                                    onChange={e => handleConfigChange(config.id, 'name', e.target.value)}
                                                    disabled={config.id === 'direct'}
                                                    variant="borderless"
                                                    style={{ fontSize: '16px', padding: 0 }}
                                                />
                                            }
                                            extra={
                                                <Space>
                                                    <Button
                                                        className="proxy-action-btn"
                                                        type={config.enabled ? "primary" : "default"}
                                                        danger={config.enabled}
                                                        onClick={() => config.enabled ? 
                                                            handleClearProxy(config.id) : 
                                                            handleApplyConfig(config.id)
                                                        }
                                                    >
                                                        {config.enabled ? '取消应用' : '应用选项'}
                                                    </Button>
                                                    {config.id !== 'direct' && (
                                                        <Button 
                                                            danger 
                                                            icon={<DeleteOutlined />}
                                                            onClick={() => handleDeleteProxy(config.id)}
                                                        />
                                                    )}
                                                </Space>
                                            }
                                            style={{ borderRadius: '4px' }}
                                        >
                                            <Space direction="vertical" style={{ width: '100%' }}>
                                                <Select
                                                    style={{ width: '100%' }}
                                                    value={config.proxyType}
                                                    onChange={value => handleConfigChange(config.id, 'proxyType', value)}
                                                    disabled={config.id === 'direct'}
                                                >
                                                    <Select.Option value="direct">直接连接</Select.Option>
                                                    <Select.Option value="fixed_server">代理服务器</Select.Option>
                                                    <Select.Option value="pac_script">PAC 脚本</Select.Option>
                                                    <Select.Option value="bypass_list">代理规则列表</Select.Option>
                                                </Select>

                                                {config.proxyType === 'bypass_list' && (
                                                    <TextArea
                                                        rows={4}
                                                        value={config.bypassList?.join('\n')}
                                                        onChange={e => handleConfigChange(config.id, 'bypassList', e.target.value.split('\n'))}
                                                        placeholder="每行一个规则，例如：
*.example.com
[::1]
127.0.0.1"
                                                    />
                                                )}

                                                {config.proxyType === 'fixed_server' && (
                                                    <Space style={{ width: '100%' }}>
                                                        <Select
                                                            style={{ width: 120 }}
                                                            value={config.scheme}
                                                            onChange={value => handleConfigChange(config.id, 'scheme', value)}
                                                        >
                                                            <Select.Option value="http">HTTP</Select.Option>
                                                            <Select.Option value="https">HTTPS</Select.Option>
                                                            <Select.Option value="socks4">SOCKS4</Select.Option>
                                                            <Select.Option value="socks5">SOCKS5</Select.Option>
                                                        </Select>
                                                        <Input
                                                            placeholder="代理服务器"
                                                            value={config.host}
                                                            onChange={e => handleConfigChange(config.id, 'host', e.target.value)}
                                                        />
                                                        <InputNumber
                                                            placeholder="端口"
                                                            value={config.port}
                                                            onChange={value => handleConfigChange(config.id, 'port', value)}
                                                            style={{ width: 100 }}
                                                        />
                                                    </Space>
                                                )}

                                                {config.proxyType === 'pac_script' && (
                                                    <TextArea
                                                        rows={4}
                                                        value={config.pacScript}
                                                        onChange={e => handleConfigChange(config.id, 'pacScript', e.target.value)}
                                                        placeholder="输入 PAC 脚本"
                                                    />
                                                )}
                                            </Space>
                                        </Card>
                                    ))}
                                </Space>
                            )
                        },
                        {
                            key: 'logs',
                            label: '代理日志',
                            children: (
                                <>
                                    <div style={{ 
                                        marginBottom: 16, 
                                        display: 'flex', 
                                        justifyContent: 'flex-end' 
                                    }}>
                                        <Button 
                                            danger 
                                            onClick={handleClearLogs}
                                            icon={<DeleteOutlined />}
                                        >
                                            清除日志
                                        </Button>
                                    </div>
                                    <Table 
                                        dataSource={proxyLogs}
                                        columns={columns}
                                        pagination={{ 
                                            pageSize: 10,
                                            showSizeChanger: true,
                                            showQuickJumper: true,
                                            showTotal: (total) => `共 ${total} 条`,
                                            pageSizeOptions: ['10', '20', '50', '100']
                                        }}
                                        rowKey="id"
                                    />
                                </>
                            )
                        }
                    ]}
                />
            </Content>
        </Layout>
    );
}; 