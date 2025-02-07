import React, {useEffect, useState} from "react";
import {Select, Button, Tooltip, Modal, Form, Input, Radio, Space, message} from "antd";
import {PlusOutlined, SettingOutlined} from "@ant-design/icons";
import {ProxyConfig} from "@/types/proxy";
import {StorageChanges} from "@/types/chrome";
import "./index.css";

export const ProxySwitch: React.FC = () => {
    const [currentMode, setCurrentMode] = useState<string>("direct");
    const [proxyConfigs, setProxyConfigs] = useState<ProxyConfig[]>([]);
    const [isModalVisible, setIsModalVisible] = useState(false);
    const [form] = Form.useForm();
    const [proxyHost, setProxyHost] = useState('');
    const [proxyPort, setProxyPort] = useState('');

    useEffect(() => {
        loadConfigs().catch(error => {
            console.error("Failed to load configs:", error);
            // 可以在这里添加错误提示
        });
    }, []);

    useEffect(() => {
        if (proxyConfigs.length > 0) {
            applyProxySettings(currentMode).catch(error => {
                console.error("Failed to apply proxy settings:", error);
                // 可以在这里添加错误提示
            });
        }
    }, [proxyConfigs, currentMode]);

    useEffect(() => {
        const handleStorageChange = (changes: StorageChanges) => {
            if (changes.proxyConfigs) {
                const newConfigs = changes.proxyConfigs.newValue;
                setProxyConfigs(newConfigs);
                const currentConfig = newConfigs.find((c: ProxyConfig) => c.id === currentMode);
                if (!currentConfig || !currentConfig.enabled) {
                    setCurrentMode("direct");
                }
            }
        };
        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => chrome.storage.onChanged.removeListener(handleStorageChange);
    }, [currentMode]);

    const loadConfigs = async () => {
        try {
            const result = await chrome.storage.local.get('proxyConfigs');
            if (!result.proxyConfigs) {
                const defaultConfigs: ProxyConfig[] = [
                    {
                        id: "direct",
                        name: "直接连接",
                        proxyType: "direct" as const,
                        enabled: true
                    },
                    {
                        id: "default",
                        name: "默认代理",
                        proxyType: "fixed_server" as const,
                        host: "127.0.0.1",
                        port: 8080,
                        scheme: "http",
                        enabled: false
                    }
                ];
                await chrome.storage.local.set({proxyConfigs: defaultConfigs});
                setProxyConfigs(defaultConfigs);
                setCurrentMode("direct");
            } else {
                setProxyConfigs(result.proxyConfigs);
                const currentConfig = result.proxyConfigs.find((c: ProxyConfig) => c.id === currentMode);
                if (!currentConfig || !currentConfig.enabled) {
                    setCurrentMode("direct");
                }
            }
            return true;
        } catch (error) {
            console.error("Error in loadConfigs:", error);
            throw error;
        }
    };

    const applyProxySettings = async (modeId: string) => {
        try {
            const config = proxyConfigs.find((c: ProxyConfig) => c.id === modeId);
            if (!config || !config.enabled) return false;

            if (config.proxyType === "direct") {
                chrome.proxy.settings.clear({scope: 'regular'});
                return true;
            } else if (config.proxyType === "fixed_server") {
                chrome.proxy.settings.set({
                    value: {
                        mode: "fixed_servers",
                        rules: {
                            singleProxy: {
                                scheme: config.scheme,
                                host: config.host,
                                port: Number(config.port)
                            },
                            bypassList: ["<-loopback>"]
                        }
                    },
                    scope: "regular"
                });
                return true;
            } else if (config.proxyType === "pac_script") {
                chrome.proxy.settings.set({
                    value: {
                        mode: "pac_script",
                        pacScript: {
                            data: config.pacScript
                        }
                    },
                    scope: "regular"
                });
                return true;
            }
            return false;
        } catch (error) {
            console.error("Failed to apply proxy settings:", error);
            throw error;
        }
    };

    const handleAddProxy = () => {
        form.resetFields();
        setIsModalVisible(true);
    };

    const handleModalOk = () => {
        form.validateFields().then(async values => {
            try {
                const newConfig: ProxyConfig = {
                    id: Date.now().toString(),
                    name: values.name,
                    proxyType: values.proxyType as "direct" | "fixed_server" | "pac_script" | "auto_detect",
                    host: values.host,
                    port: values.port ? parseInt(values.port) : undefined,
                    scheme: values.scheme,
                    enabled: true,
                };
                const updatedConfigs = [...proxyConfigs, newConfig];
                await chrome.storage.local.set({proxyConfigs: updatedConfigs});
                setProxyConfigs(updatedConfigs);
                setIsModalVisible(false);
            } catch (error) {
                console.error("Failed to save new proxy config:", error);
                // 可以在这里添加错误提示
            }
        });
    };

    const handleSettingClick = () => {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            chrome.tabs.create({
                url: chrome.runtime.getURL('proxy/options.html')
            });
        }
    };

    const handleApplyProxy = async () => {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'SET_PROXY_CONFIG',
                config: {
                    host: proxyHost,
                    port: parseInt(proxyPort),
                    scheme: 'http',
                    proxyType: 'fixed_server',
                    id: 'default',
                    name: '默认代理'
                }
            });

            if (response.success) {
                message.success('代理设置已应用');
            } else {
                message.error(response.error || '代理设置失败');
            }
        } catch (error) {
            console.error('Error applying proxy:', error);
            message.error('应用代理设置时发生错误');
        }
    };

    return (
        <div className="proxy-switch">
            <div className="proxy-switch-header">
                <Select
                    value={currentMode}
                    onChange={setCurrentMode}
                    style={{width: 200}}
                    options={proxyConfigs.filter((config: ProxyConfig) => config.enabled).map((config: ProxyConfig) => ({
                        label: config.name,
                        value: config.id
                    }))}
                />
                <Space>
                    <Tooltip title="添加代理">
                        <Button
                            icon={<PlusOutlined/>}
                            onClick={handleAddProxy}
                        />
                    </Tooltip>
                    <Tooltip title="代理设置">
                        <Button
                            icon={<SettingOutlined/>}
                            onClick={handleSettingClick}
                        />
                    </Tooltip>
                </Space>
            </div>

            <Modal
                title="添加代理配置"
                open={isModalVisible}
                onOk={handleModalOk}
                onCancel={() => setIsModalVisible(false)}
            >
                <Form
                    form={form}
                    layout="vertical"
                >
                    <Form.Item
                        name="name"
                        label="配置名称"
                        rules={[{required: true}]}
                    >
                        <Input/>
                    </Form.Item>
                    <Form.Item
                        name="proxyType"
                        label="代理类型"
                        rules={[{required: true}]}
                    >
                        <Radio.Group>
                            <Radio value="direct">直接连接</Radio>
                            <Radio value="fixed_server">代理服务器</Radio>
                            <Radio value="pac_script">PAC 脚本</Radio>
                        </Radio.Group>
                    </Form.Item>
                    <Form.Item
                        noStyle
                        shouldUpdate={(prev, curr) => prev.proxyType !== curr.proxyType}
                    >
                        {({getFieldValue}) =>
                            getFieldValue('proxyType') === 'fixed_server' && (
                                <>
                                    <Form.Item
                                        name="scheme"
                                        label="代理协议"
                                        rules={[{required: true}]}
                                    >
                                        <Select>
                                            <Select.Option value="http">HTTP</Select.Option>
                                            <Select.Option value="https">HTTPS</Select.Option>
                                            <Select.Option value="socks4">SOCKS4</Select.Option>
                                            <Select.Option value="socks5">SOCKS5</Select.Option>
                                        </Select>
                                    </Form.Item>
                                    <Form.Item
                                        name="host"
                                        label="代理服务器"
                                        rules={[{required: true}]}
                                    >
                                        <Input/>
                                    </Form.Item>
                                    <Form.Item
                                        name="port"
                                        label="端口"
                                        rules={[{required: true}]}
                                    >
                                        <Input type="number"/>
                                    </Form.Item>
                                </>
                            )
                        }
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};