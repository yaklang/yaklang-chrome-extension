import React, { useState, useEffect } from 'react';
import { ConfigProvider, Layout, Typography, List, Button, Form, Input, Select, Space, Card, Divider, Modal } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import { browser } from 'wxt/browser';
import type { ProxyConfig } from '../../types/proxy';
import { getAllProxyConfigs, saveProxyConfig, deleteProxyConfig, enableProxyConfig } from '../../utils/storage';
import {ContentActionType, ProxyActionType} from '../../types/action';
import './App.css';

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

    // 监听添加代理请求
    const handleMessage = (message: any) => {
      if (message.action === ContentActionType.TRIGGER_ADD_PROXY) {
        setIsModalOpen(true);
      }
    };
    
    browser.runtime.onMessage.addListener(handleMessage);
    return () => {
      browser.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const loadProxies = async () => {
    try {
      const configs = await getAllProxyConfigs();
      setProxies(configs.filter(config => config.proxyType === "fixed_servers"));
    } catch (error) {
      console.error('Error loading proxies:', error);
    }
  };

  const handleSave = async (values: any) => {
    try {
      setLoading(true);
      
      const newProxy: ProxyConfig = {
        id: uuidv4(),
        name: values.name,
        proxyType: "fixed_servers",
        scheme: values.proxyType,
        host: values.host,
        port: Number(values.port),
        enabled: false
      };
      
      if (values.username) newProxy.username = values.username;
      if (values.password) newProxy.password = values.password;
      
      await saveProxyConfig(newProxy);
      
      // 重新加载代理列表
      await loadProxies();
      
      // 重置表单
      form.resetFields();
      
      // 关闭模态框
      setIsModalOpen(false);
      
      // 通知后台脚本
      browser.runtime.sendMessage({
        action: ContentActionType.PROXY_CONFIGS_UPDATED,
        source: 'options'
      });
    } catch (error) {
      console.error('Error saving proxy:', error);
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
        source: 'options'
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
        mode: id
      });
      
      // 重新加载代理列表
      await loadProxies();
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
          <Title level={3} style={{ color: 'white', margin: 0 }}>Yaklang 代理管理设置</Title>
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
                  fontSize: "13px"
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
                  <div style={{ padding: '32px 0', textAlign: 'center' }}>
                    <div style={{ marginBottom: 16 }}>
                      <img 
                        src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTUzLjMzMzMgMzJWNDhDNTMuMzMzMyA0OS40MTc0IDUyLjc3MTQgNTAuNzY1MiA1MS43NzEyIDUxLjc2NTJDNTAuNzcxIDUyLjc2NTIgNDkuNDIzMyA1My4zMzMzIDQ4IDUzLjMzMzNIMTZDMTQuNTc2NyA1My4zMzMzIDEzLjIyODkgNTIuNzcxNCAxMi4yMjg4IDUxLjc3MTJDMTEuMjI4OCA1MC43NzEgMTAuNjY2NyA0OS40MjMzIDEwLjY2NjcgNDhWMTZDMTAuNjY2NyAxNC41NzY3IDExLjIyODggMTMuMjI4OSAxMi4yMjg4IDEyLjIyODhDMTMuMjI4OSAxMS4yMjg4IDE0LjU3NjcgMTAuNjY2NyAxNiAxMC42NjY3SDMyIiBzdHJva2U9IiM1QTVBNUEiIHN0cm9rZS13aWR0aD0iNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxwYXRoIGQ9Ik0zMiAzMkg1My4zMzMzVjQyLjY2NjciIHN0cm9rZT0iI0YyOEI0NCIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc+Cg==" 
                        alt="No data" 
                        style={{ width: 64, height: 64, opacity: 0.5 }}
                      />
                    </div>
                    <p style={{ color: '#5A5A5A' }}>还没有添加任何代理</p>
                  </div>
                )
              }}
              renderItem={(proxy) => (
                <List.Item
                  key={proxy.id}
                  actions={[
                    <Button 
                      type="primary"
                      onClick={() => handleActivate(proxy.id)}
                      disabled={proxy.enabled}
                    >
                      {proxy.enabled ? '已启用' : '启用'}
                    </Button>,
                    <Button 
                      danger 
                      icon={<DeleteOutlined />}
                      onClick={() => handleDelete(proxy.id)}
                    />
                  ]}
                >
                  <List.Item.Meta
                    title={proxy.name}
                    description={`${proxy.scheme}://${proxy.host}:${proxy.port}`}
                  />
                </List.Item>
              )}
            />
          </Card>
          {/* <Card id="add-proxy-form" className="add-proxy-card" title="添加新代理"> */}

          <Modal
            title="添加新代理"
            open={isModalOpen}
            className='add-proxy-card'
            onCancel={handleCancel}
            footer={null}
            destroyOnClose
          >
            <Form
              form={form}
              layout="vertical"
              onFinish={handleSave}
            >
              <Form.Item
                name="name"
                label="代理名称"
                rules={[{ required: true, message: '请输入代理名称' }]}
              >
                <Input placeholder="例如: 公司内网代理" />
              </Form.Item>
              
              <Form.Item
                name="proxyType"
                label="代理类型"
                initialValue="http"
                rules={[{ required: true, message: '请选择代理类型' }]}
              >
                <Select>
                  <Option value="http">HTTP</Option>
                  <Option value="https">HTTPS</Option>
                  <Option value="socks4">SOCKS4</Option>
                  <Option value="socks5">SOCKS5</Option>
                </Select>
              </Form.Item>
              
              <Space style={{ display: 'flex' }}>
                <Form.Item
                  name="host"
                  label="主机地址"
                  rules={[{ required: true, message: '请输入主机地址' }]}
                  style={{ flex: 3 }}
                >
                  <Input placeholder="例如: proxy.example.com 或 192.168.1.100" />
                </Form.Item>
                
                <Form.Item
                  name="port"
                  label="端口"
                  rules={[{ required: true, message: '请输入端口' }]}
                  style={{ flex: 1 }}
                >
                  <Input placeholder="例如: 8080" />
                </Form.Item>
              </Space>
              
              <Space style={{ display: 'flex' }}>
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
              
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<PlusOutlined />}
                  loading={loading}
                  block
                >
                  添加代理
                </Button>
              </Form.Item>
            </Form>
          </Modal>
        </Content>
      </Layout>
    </ConfigProvider>
  );
} 