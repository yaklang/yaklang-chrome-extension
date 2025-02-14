import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Card, Input, Space, Button, Select, InputNumber, Form, Table, Tooltip, Popover, Modal, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, EditOutlined, CheckOutlined } from '@ant-design/icons';
import { ProxyConfig } from '@/types/proxy';
import './index.css';

interface ProxySettingsProps {
    proxyConfigs: ProxyConfig[];
    onAdd: (config: ProxyConfig) => void;
    onChange: (configId: string, field: keyof ProxyConfig | 'config', value: any) => void;
    onDelete: (configId: string) => void;
    onApply: (configId: string) => Promise<void>;
    onClear: (configId: string) => Promise<void>;
}

// 添加编辑表单的接口
interface EditFormData {
    name: string;
    proxyType: "direct" | "system" | "fixed_servers" | "pac_script" | "auto_detect";
    scheme?: "http" | "https" | "socks4" | "socks5";
    host?: string;
    port?: number;
    pacScript?: string;
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
                pacScript: editingConfig.pacScript
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

    // 处理编辑保存
    const handleEditSave = async () => {
        try {
            const values = await form.validateFields();
            if (editingConfig) {
                if (editingConfig.enabled) {
                    await onClear(editingConfig.id);
                }
                
                const updatedConfig: ProxyConfig = {
                    ...editingConfig,
                    ...values,
                    proxyType: values.proxyType as "direct" | "system" | "fixed_servers" | "pac_script" | "auto_detect",
                    scheme: values.scheme as "http" | "https" | "socks4" | "socks5"
                };

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
                                { label: '直接连接', value: 'direct' },
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
                            return proxyType === 'fixed_servers' ? (
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
                                </>
                            ) : proxyType === 'pac_script' ? (
                                <Form.Item
                                    name="pacScript"
                                    label="PAC 脚本"
                                    rules={[{ required: true, message: '请输入 PAC 脚本' }]}
                                >
                                    <Input.TextArea rows={4} />
                                </Form.Item>
                            ) : null;
                        }}
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    ); 
}; 