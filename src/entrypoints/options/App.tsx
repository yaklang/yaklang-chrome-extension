import React, { useState, useEffect } from "react";
import {
  ConfigProvider,
  Layout,
  Typography,
  List,
  Button,
  Form,
  Input,
  Select,
  Space,
  Card,
  Divider,
  Modal,
} from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { v4 as uuidv4 } from "uuid";
import { browser } from "wxt/browser";
import type { ProxyConfig } from "../../types/proxy";
import {
  getAllProxyConfigs,
  saveProxyConfig,
  deleteProxyConfig,
  enableProxyConfig,
  getCurrentProxy,
} from "../../utils/storage";
import { ContentActionType, ProxyActionType } from "../../types/action";
import "./App.css";

const { Header, Content } = Layout;
const { Title } = Typography;
const { Option } = Select;

export default function App() {
  const [proxies, setProxies] = useState<ProxyConfig[]>([]);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    loadProxies();

    // 监听添加代理请求和代理配置更新
    const handleMessage = (message: any) => {
      if (message.action === ContentActionType.TRIGGER_ADD_PROXY) {
        setIsModalOpen(true);
      } else if (message.action === ContentActionType.PROXY_CONFIGS_UPDATED) {
        // 当代理配置发生变化时重新加载代理列表
        loadProxies();
      }
    };

    browser.runtime.onMessage.addListener(handleMessage);
    return () => {
      browser.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const loadProxies = async () => {
    try {
      // 获取所有代理配置
      const allConfigs = await getAllProxyConfigs();

      // 获取当前启用的代理
      const currentProxy = await getCurrentProxy();
      const currentProxyId = currentProxy?.id || "";

      // 检查当前是否为系统代理或直接连接
      const isSystemOrDirect =
        currentProxyId === "system" || currentProxyId === "direct";

      // 显示自定义代理服务器配置和PAC脚本配置
      const customProxies = allConfigs.filter(
        (config) =>
          config.proxyType === "fixed_servers" ||
          config.proxyType === "pac_script"
      );

      // 如果当前是系统代理或直接连接，则所有自定义代理显示为未启用
      if (isSystemOrDirect) {
        console.log("系统代理或直接连接已启用，确保自定义代理状态正确");
        // 确保UI状态与实际状态一致
        setProxies(
          customProxies.map((proxy) => ({
            ...proxy,
            enabled: false,
          }))
        );
      } else {
        setProxies(customProxies);
      }
    } catch (error) {
      console.error("Error loading proxies:", error);
    }
  };

  const handleSave = async (values: any) => {
    try {
      setLoading(true);

      const newProxy: Partial<ProxyConfig> = {
        id: uuidv4(),
        name: values.name,
        enabled: false,
      };

      if (values.proxyType === "fixed_servers") {
        newProxy.proxyType = "fixed_servers";
        newProxy.scheme = values.scheme;
        newProxy.host = values.host;
        newProxy.port = Number(values.port);

        // 处理不经过代理的地址
        if (values.bypassList) {
          newProxy.bypassList = values.bypassList
            .split("\n")
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);
        } else {
          newProxy.bypassList = [];
        }
      } else if (values.proxyType === "pac_script") {
        newProxy.proxyType = "pac_script";
        newProxy.mode = "pac_script";

        // 处理PAC脚本匹配域名
        if (values.matchList) {
          newProxy.matchList = values.matchList
            .split("\n")
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 0);
        }

        // 解析选择的代理服务器
        const [host, port] = values.proxyServer.split(":");

        // 创建PAC脚本
        newProxy.pacScript = {
          data: `function FindProxyForURL(url, host) {
  // Convert host to lowercase for case-insensitive matching
  host = host.toLowerCase();
  
  // Define domain patterns
  var domains = ${JSON.stringify(newProxy.matchList || [])};
  
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
}`,
          mandatory: true,
        };

        // 保存代理服务器信息
        newProxy.host = host;
        newProxy.port = Number(port);
      }

      // 添加认证信息
      if (values.username) newProxy.username = values.username;
      if (values.password) newProxy.password = values.password;

      await saveProxyConfig(newProxy as ProxyConfig);

      // 重新加载代理列表
      await loadProxies();

      // 重置表单
      form.resetFields();

      // 关闭模态框
      setIsModalOpen(false);

      // 通知后台脚本
      browser.runtime.sendMessage({
        action: ContentActionType.PROXY_CONFIGS_UPDATED,
        source: "options",
      });
    } catch (error) {
      console.error("Error saving proxy:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProxyConfig(id);
      await loadProxies();

      // 通知后台脚本
      browser.runtime.sendMessage({
        action: ContentActionType.PROXY_CONFIGS_UPDATED,
        source: "options",
      });
    } catch (error) {
      console.error(`Error deleting proxy ${id}:`, error);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      // 启用代理
      await enableProxyConfig(id);

      // 发送切换代理请求
      await browser.runtime.sendMessage({
        action: ProxyActionType.SWITCH_PROXY,
        mode: id,
      });

      // 重新加载代理列表
      await loadProxies();

      // 通知后台脚本
      browser.runtime.sendMessage({
        action: ContentActionType.PROXY_CONFIGS_UPDATED,
        source: "options",
      });
    } catch (error) {
      console.error(`Error activating proxy ${id}:`, error);
    }
  };

  const showModal = () => {
    form.resetFields();
    setIsModalOpen(true);
  };

  const handleCancel = () => {
    setIsModalOpen(false);
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#F28B44",
        },
      }}
    >
      <Layout className="options-layout">
        <Header className="options-header">
          <Title level={3} style={{ color: "white", margin: 0 }}>
            Yaklang 代理管理设置
          </Title>
        </Header>
        <Content className="options-content">
          <Card
            className="proxy-list-card"
            title="代理列表"
            extra={
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={showModal}
                size="small"
                style={{
                  backgroundColor: "#F28B44",
                  borderColor: "#F28B44",
                  borderRadius: "4px",
                  fontSize: "13px",
                }}
              >
                添加代理
              </Button>
            }
          >
            <List
              dataSource={proxies}
              locale={{
                emptyText: (
                  <div style={{ padding: "32px 0", textAlign: "center" }}>
                    <div style={{ marginBottom: 16 }}>
                      <img
                        src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTUzLjMzMzMgMzJWNDhDNTMuMzMzMyA0OS40MTc0IDUyLjc3MTQgNTAuNzY1MiA1MS43NzEyIDUxLjc2NTJDNTAuNzcxIDUyLjc2NTIgNDkuNDIzMyA1My4zMzMzIDQ4IDUzLjMzMzNIMTZDMTQuNTc2NyA1My4zMzMzIDEzLjIyODkgNTIuNzcxNCAxMi4yMjg4IDUxLjc3MTJDMTEuMjI4OCA1MC43NzEgMTAuNjY2NyA0OS40MjMzIDEwLjY2NjcgNDhWMTZDMTAuNjY2NyAxNC41NzY3IDExLjIyODggMTMuMjI4OSAxMi4yMjg4IDEyLjIyODhDMTMuMjI4OSAxMS4yMjg4IDE0LjU3NjcgMTAuNjY2NyAxNiAxMC42NjY3SDMyIiBzdHJva2U9IiM1QTVBNUEiIHN0cm9rZS13aWR0aD0iNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxwYXRoIGQ9Ik0zMiAzMkg1My4zMzMzVjQyLjY2NjciIHN0cm9rZT0iI0YyOEI0NCIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc+Cg=="
                        alt="No data"
                        style={{ width: 64, height: 64, opacity: 0.5 }}
                      />
                    </div>
                    <p style={{ color: "#5A5A5A" }}>还没有添加任何代理</p>
                  </div>
                ),
              }}
              renderItem={(proxy) => (
                <List.Item
                  key={proxy.id}
                  actions={[
                    <Button
                      type={proxy.enabled ? "default" : "primary"}
                      onClick={() => handleActivate(proxy.id)}
                      disabled={proxy.enabled}
                      style={
                        proxy.enabled
                          ? {
                              backgroundColor: "#F28B44",
                              color: "white",
                              borderColor: "#F28B44",
                            }
                          : undefined
                      }
                    >
                      {proxy.enabled ? "已启用" : "启用"}
                    </Button>,
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => handleDelete(proxy.id)}
                    />,
                  ]}
                >
                  <List.Item.Meta
                    title={proxy.name}
                    description={
                      proxy.proxyType === "pac_script"
                        ? `PAC 脚本 (使用 ${proxy.host}:${proxy.port} 作为代理)`
                        : `${proxy.scheme}://${proxy.host}:${proxy.port}`
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
          {/* <Card id="add-proxy-form" className="add-proxy-card" title="添加新代理"> */}

          <Modal
            title="添加新代理"
            open={isModalOpen}
            className="add-proxy-card"
            onCancel={handleCancel}
            footer={[
              <Button key="cancel" onClick={handleCancel}>
                Cancel
              </Button>,
              <Button
                key="submit"
                type="primary"
                onClick={() => form.submit()}
                loading={loading}
              >
                OK
              </Button>,
            ]}
            destroyOnClose
          >
            <Form form={form} layout="vertical" onFinish={handleSave}>
              <Form.Item
                name="name"
                label={<span className="required-label">名称</span>}
                rules={[{ required: true, message: "请输入代理名称" }]}
              >
                <Input placeholder="为此代理添加一个名称" />
              </Form.Item>

              <Form.Item
                name="proxyType"
                label={<span className="required-label">类型</span>}
                initialValue="fixed_servers"
                rules={[{ required: true, message: "请选择代理类型" }]}
              >
                <Select>
                  <Option value="fixed_servers">代理服务器</Option>
                  <Option value="pac_script">PAC 脚本</Option>
                </Select>
              </Form.Item>

              <Form.Item
                noStyle
                shouldUpdate={(prevValues, currentValues) =>
                  prevValues.proxyType !== currentValues.proxyType
                }
              >
                {({ getFieldValue }) => {
                  const proxyType = getFieldValue("proxyType");
                  if (proxyType === "fixed_servers") {
                    return (
                      <>
                        <Form.Item
                          name="scheme"
                          label={<span className="required-label">协议</span>}
                          initialValue="http"
                          rules={[
                            { required: true, message: "请选择代理协议" },
                          ]}
                        >
                          <Select>
                            <Option value="http">HTTP</Option>
                            <Option value="https">HTTPS</Option>
                            <Option value="socks4">SOCKS4</Option>
                            <Option value="socks5">SOCKS5</Option>
                          </Select>
                        </Form.Item>

                        <Form.Item
                          name="host"
                          label={<span className="required-label">主机</span>}
                          rules={[
                            { required: true, message: "请输入主机地址" },
                          ]}
                        >
                          <Input placeholder="127.0.0.1" />
                        </Form.Item>

                        <Form.Item
                          name="port"
                          label={<span className="required-label">端口</span>}
                          rules={[{ required: true, message: "请输入端口" }]}
                        >
                          <Input placeholder="8080" />
                        </Form.Item>

                        <Form.Item name="bypassList" label="不经过代理的地址">
                          <Input.TextArea
                            rows={4}
                            placeholder={`例如：
localhost
127.0.0.1
*.example.com`}
                          />
                          <div
                            style={{
                              marginTop: 8,
                              fontSize: 12,
                              color: "#999",
                            }}
                          >
                            每行一个地址，支持通配符 *
                          </div>
                        </Form.Item>

                        <Space style={{ display: "flex" }}>
                          <Form.Item
                            name="username"
                            label="用户名 (可选)"
                            style={{ flex: 1 }}
                          >
                            <Input placeholder="认证用户名" />
                          </Form.Item>

                          <Form.Item
                            name="password"
                            label="密码 (可选)"
                            style={{ flex: 1 }}
                          >
                            <Input.Password placeholder="认证密码" />
                          </Form.Item>
                        </Space>
                      </>
                    );
                  } else if (proxyType === "pac_script") {
                    return (
                      <>
                        <Form.Item
                          name="matchList"
                          label="匹配域名"
                          help="每行一个域名，支持通配符 *"
                          rules={[
                            {
                              required: true,
                              message: "请输入至少一个匹配域名",
                            },
                          ]}
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
                          label={
                            <span className="required-label">
                              选择代理服务器
                            </span>
                          }
                          rules={[
                            { required: true, message: "请选择代理服务器" },
                          ]}
                        >
                          <Select placeholder="选择一个代理服务器">
                            {/* 获取已配置的固定代理服务器列表 */}
                            {proxies
                              .filter(
                                (proxy) => proxy.proxyType === "fixed_servers"
                              )
                              .map((proxy) => (
                                <Option
                                  key={proxy.id}
                                  value={`${proxy.host}:${proxy.port}`}
                                >
                                  {proxy.name} ({proxy.scheme}://{proxy.host}:
                                  {proxy.port})
                                </Option>
                              ))}
                          </Select>
                        </Form.Item>
                      </>
                    );
                  }
                  return null;
                }}
              </Form.Item>
            </Form>
          </Modal>
        </Content>
      </Layout>
    </ConfigProvider>
  );
}
