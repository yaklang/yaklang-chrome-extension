import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Card, Input, Space, Button, Select, InputNumber, Form, Table, Tooltip, Popover, Modal, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, EditOutlined, CheckOutlined } from '@ant-design/icons';
import { ProxyConfig } from '@/types/proxy';
import './index.css';
import punycode from 'punycode';

interface ProxySettingsProps {
    proxyConfigs: ProxyConfig[];
    onAdd: (config: ProxyConfig) => void;
    onChange: (configId: string, field: keyof ProxyConfig | 'config', value: any) => void;
    onDelete: (configId: string) => void;
    onApply: (configId: string) => Promise<void>;
    onClear: (configId: string) => Promise<void>;
}

// 修改 EditFormData 接口
interface EditFormData {
    name: string;
    proxyType: "direct" | "system" | "fixed_servers" | "pac_script" | "auto_detect";
    scheme?: "http" | "https" | "socks4" | "socks5";
    host?: string;
    port?: number;
    pacScript?: string;
    bypassList?: string;
    matchList?: string;  // 仅用于 UI 编辑
    proxyServer?: string;  // 添加 proxyServer 字段，用于 PAC 脚本模式选择代理服务器
}

// 或者更好的方式是创建一个专门的类型
type ProxyConfigField = keyof ProxyConfig | 'config';

export const ProxySettings: React.FC<ProxySettingsProps> = ({
    proxyConfigs,
    onAdd,
    onChange,
    onDelete,
    onApply,
    onClear
}) => {
    const [editingConfig, setEditingConfig] = useState<ProxyConfig | null>(null);
    const [editModalVisible, setEditModalVisible] = useState(false);
    const [form] = Form.useForm<EditFormData>();

    // 添加 useEffect 来监听表单值变化
    useEffect(() => {
        if (editModalVisible && editingConfig) {
            form.setFieldsValue({
                name: editingConfig.name,
                proxyType: editingConfig.proxyType,
                scheme: editingConfig.scheme,
                host: editingConfig.host,
                port: editingConfig.port,
                bypassList: editingConfig.bypassList?.join('\n') || '',
                matchList: editingConfig.matchList?.join('\n') || '',
                proxyServer: editingConfig.host && editingConfig.port 
                    ? `${editingConfig.host}:${editingConfig.port}`
                    : undefined
            });
        }
    }, [editModalVisible, editingConfig, form]);

    // 处理添加按钮点击
    const handleAdd = useCallback(() => {
        setEditingConfig({
            id: Date.now().toString(),
            name: '',
            proxyType: 'fixed_servers',
            scheme: 'http' as "http" | "https" | "socks4" | "socks5",
            host: '127.0.0.1',
            port: 8080,
            enabled: false
        });
        setEditModalVisible(true);
    }, []);

    // 处理编辑按钮点击
    const handleEdit = (record: ProxyConfig) => {
        setEditingConfig(record);
        setEditModalVisible(true);
    };

    // 添加一个函数来获取可用的代理服务器列表
    const getAvailableProxies = (configs: ProxyConfig[]) => {
        return configs
            .filter(config => config.proxyType === 'fixed_servers')
            .map(config => ({
                label: `${config.name} (${config.scheme}://${config.host}:${config.port})`,
                value: `${config.host}:${config.port}`,
                config
            }));
    };

    // 处理编辑保存
    const handleEditSave = async () => {
        try {
            const values = await form.validateFields();
            if (editingConfig) {
                if (editingConfig.enabled) {
                    await onClear(editingConfig.id);
                }

                let updatedConfig: ProxyConfig;

                if (values.proxyType === 'fixed_servers') {
                    // 处理固定代理服务器模式
                    const bypassList = values.bypassList
                        ? values.bypassList.split('\n').map(line => line.trim()).filter(line => line.length > 0)
                        : [""];

                    updatedConfig = {
                        id: editingConfig.id,
                        name: values.name,
                        enabled: editingConfig.enabled,
                        proxyType: 'fixed_servers',
                        scheme: values.scheme,
                        host: values.host,
                        port: values.port,
                        bypassList,
                    };
                } else if (values.proxyType === 'pac_script') {
                    const domains = values.matchList
                        ? values.matchList.split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0)
                            .map(domain => {
                                try {
                                    // 如果域名包含非 ASCII 字符，转换为 Punycode
                                    if (/[^\x00-\x7F]/.test(domain)) {
                                        if (domain.startsWith('*.')) {
                                            const suffix = domain.substring(2);
                                            return '*.' + suffix.split('.').map(part => {
                                                return /[^\x00-\x7F]/.test(part) ? 'xn--' + punycode.encode(part) : part;
                                            }).join('.');
                                        } else {
                                            return domain.split('.').map(part => {
                                                return /[^\x00-\x7F]/.test(part) ? 'xn--' + punycode.encode(part) : part;
                                            }).join('.');
                                        }
                                    }
                                    return domain;
                                } catch (error) {
                                    console.error('Error encoding domain:', domain, error);
                                    return domain;
                                }
                            })
                        : [];

                    // 从选择的代理服务器中获取配置
                    const [host, port] = values.proxyServer.split(':');

                    // 生成 PAC 脚本
                    const pacScriptContent = `
function FindProxyForURL(url, host) {
    // Convert host to lowercase for case-insensitive matching
    host = host.toLowerCase();
    
    // Define domain patterns
    var domains = ${JSON.stringify(domains)};
    
    // Check each domain pattern
    for (var i = 0; i < domains.length; i++) {
        var pattern = domains[i].toLowerCase();
        
        if (pattern.startsWith('*.')) {
            var suffix = pattern.substring(2);
            if (host === suffix || host.endsWith('.' + suffix)) {
                return 'PROXY ${host}:${port}';
            }
        } else if (host === pattern) {
            return 'PROXY ${host}:${port}';
        }
    }
    
    return 'DIRECT';
}`;

                    updatedConfig = {
                        id: editingConfig.id,
                        name: values.name,
                        enabled: editingConfig.enabled,
                        proxyType: 'pac_script',
                        mode: 'pac_script',
                        // 保存代理服务器信息
                        host,
                        port: parseInt(port),
                        // 保存匹配域名列表
                        matchList: domains,
                        pacScript: {
                            data: pacScriptContent,
                            mandatory: true
                        }
                    };
                } else {
                    // 处理其他模式
                    updatedConfig = {
                        id: editingConfig.id,
                        name: values.name,
                        enabled: editingConfig.enabled,
                        proxyType: values.proxyType,
                        bypassList: [], // 其他模式下设置为空数组
                    };
                }

                if (!proxyConfigs.find(config => config.id === editingConfig.id)) {
                    await onAdd(updatedConfig);
                } else {
                    await onChange(editingConfig.id, 'config', updatedConfig);
                }
                
                setEditModalVisible(false);
                setEditingConfig(null);
                form.resetFields();
            }
        } catch (error) {
            console.error('Validate Failed:', error);
            message.error('保存失败，请检查表单');
        }
    };

    // 处理模态框关闭
    const handleModalClose = () => {
        form.resetFields();
        setEditModalVisible(false);
        setEditingConfig(null);
    };

    const columns: ColumnsType<ProxyConfig> = [
        {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
            render: (text: string) => text
        },
        {
            title: '类型',
            dataIndex: 'proxyType',
            key: 'proxyType',
            render: (text: string) => {
                const typeMap = {
                    direct: '直接连接',
                    fixed_servers: '代理服务器',
                    pac_script: 'PAC 脚本'
                };
                return typeMap[text as keyof typeof typeMap] || text;
            }
        },
        {
            title: '协议',
            dataIndex: 'scheme',
            key: 'scheme'
        },
        {
            title: '主机',
            dataIndex: 'host',
            key: 'host'
        },
        {
            title: '端口',
            dataIndex: 'port',
            key: 'port'
        },
        {
            title: '操作',
            key: 'action',
            width: 120,
            render: (_, record: ProxyConfig) => (
                <Space size="middle">
                    <CheckOutlined
                        className={`action-icon ${record.enabled ? 'enabled' : ''}`}
                        onClick={async () => {
                            if (record.enabled) {
                                await onClear(record.id);
                            } else {
                                await onApply(record.id);
                            }
                        }}
                    />
                    <EditOutlined
                        className="action-icon"
                        onClick={() => handleEdit(record)}
                    />
                    {record.id !== 'direct' && (
                        <DeleteOutlined
                            className="action-icon delete"
                            onClick={() => onDelete(record.id)}
                        />
                    )}
                </Space>
            )
        }
    ];

    const buttonRef = useRef(null);

    // 过滤掉固定模式的代理
    const filteredProxyConfigs = proxyConfigs.filter(
        config => !['direct', 'system'].includes(config.id)
    );

    return (
        <div>
            <Space style={{ marginBottom: 16, justifyContent: 'flex-end', width: '100%' }}>
                <Button 
                    className="add-proxy-btn"
                    onClick={handleAdd}
                    icon={<PlusOutlined />}
                >
                    添加代理
                </Button>
            </Space>
            <Table 
                className="proxy-table"
                dataSource={filteredProxyConfigs}
                columns={columns}
                rowKey="id"
                pagination={false}
                bordered={false}
                size="middle"
            />
            
            <Modal
                title="编辑代理配置"
                open={editModalVisible}
                onOk={handleEditSave}
                onCancel={handleModalClose}
                destroyOnClose
            >
                <Form
                    form={form}
                    layout="vertical"
                    preserve={false}
                >
                    <Form.Item
                        name="name"
                        label="名称"
                        rules={[{ required: true }]}
                    >
                        <Input />
                    </Form.Item>
                    <Form.Item
                        name="proxyType"
                        label="类型"
                        rules={[{ required: true }]}
                    >
                        <Select
                            options={[
                                // { label: '直接连接', value: 'direct' },
                                { label: '代理服务器', value: 'fixed_servers' },
                                { label: 'PAC 脚本', value: 'pac_script' }
                            ]}
                            onChange={(value) => {
                                // 当类型改变时，清除相关字段
                                if (value !== 'fixed_servers') {
                                    form.setFieldsValue({
                                        scheme: undefined,
                                        host: undefined,
                                        port: undefined
                                    });
                                }
                            }}
                        />
                    </Form.Item>
                    <Form.Item
                        noStyle
                        shouldUpdate={(prevValues, currentValues) => prevValues.proxyType !== currentValues.proxyType}
                    >
                        {({ getFieldValue }) => {
                            const proxyType = getFieldValue('proxyType');
                            if (proxyType === 'fixed_servers') {
                                return (
                                    <>
                                        <Form.Item
                                            name="scheme"
                                            label="协议"
                                            rules={[{ required: true, message: '请选择协议' }]}
                                        >
                                            <Select
                                                options={[
                                                    { label: 'HTTP', value: 'http' },
                                                    { label: 'HTTPS', value: 'https' },
                                                    { label: 'SOCKS4', value: 'socks4' },
                                                    { label: 'SOCKS5', value: 'socks5' }
                                                ]}
                                            />
                                        </Form.Item>
                                        <Form.Item
                                            name="host"
                                            label="主机"
                                            rules={[{ required: true, message: '请输入主机地址' }]}
                                        >
                                            <Input placeholder="127.0.0.1" />
                                        </Form.Item>
                                        <Form.Item
                                            name="port"
                                            label="端口"
                                            rules={[{ required: true, message: '请输入端口号' }]}
                                        >
                                            <InputNumber 
                                                min={1} 
                                                max={65535} 
                                                placeholder="8080"
                                                style={{ width: '100%' }}
                                            />
                                        </Form.Item>
                                        <Form.Item
                                            name="bypassList"
                                            label="不经过代理的地址"
                                            help="每行一个地址，支持通配符 *"
                                        >
                                            <Input.TextArea
                                                rows={4}
                                                placeholder={`例如：
localhost
127.0.0.1
*.example.com`}
                                            />
                                        </Form.Item>
                                    </>
                                );
                            } else if (proxyType === 'pac_script') {
                                const availableProxies = getAvailableProxies(proxyConfigs);
                                
                                return (
                                    <>
                                        <Form.Item
                                            name="matchList"
                                            label="匹配域名"
                                            help="每行一个域名，支持通配符 *"
                                            rules={[{ required: true, message: '请输入至少一个匹配域名' }]}
                                        >
                                            <Input.TextArea
                                                rows={4}
                                                placeholder={`例如：
*.example.com
google.com
github.com`}
                                            />
                                        </Form.Item>
                                        <Form.Item
                                            name="proxyServer"
                                            label="选择代理服务器"
                                            rules={[{ required: true, message: '请选择代理服务器' }]}
                                        >
                                            <Select
                                                placeholder="选择一个代理服务器"
                                                options={availableProxies}
                                            />
                                        </Form.Item>
                                    </>
                                );
                            }
                            return null;
                        }}
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    ); 
}; 