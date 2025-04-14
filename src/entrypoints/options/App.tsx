import React, { useState, useEffect } from 'react';
import { ConfigProvider, Layout, Typography, List, Button, Form, Input, Select, Space, Card, Divider } from 'antd';
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

  useEffect(() => {
    loadProxies();

    // 监听添加代理请求
    const handleMessage = (message: any) => {
      if (message.action === ContentActionType.TRIGGER_ADD_PROXY) {
        document.getElementById('add-proxy-form')?.scrollIntoView({ behavior: 'smooth' });
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
      setProxies(configs.filter(config => config.proxyType !== 'direct' && config.proxyType !== 'system'));
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
        proxyType: values.proxyType,
        host: values.host,
        port: Number(values.port),
        enabled: false
      };
      
      // if (values.username) newProxy.username = values.username;
      // if (values.password) newProxy.password = values.password;
      
      await saveProxyConfig(newProxy);
      
      // 重新加载代理列表
      await loadProxies();
      
      // 重置表单
      form.resetFields();
      
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
          <Card className="proxy-list-card" title="已保存的代理">
            <List
              dataSource={proxies}
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
                    description={`${proxy.proxyType}://${proxy.host}:${proxy.port}`}
                  />
                </List.Item>
              )}
            />
          </Card>
          
          <Divider />
          
          <Card id="add-proxy-form" className="add-proxy-card" title="添加新代理">
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
          </Card>
        </Content>
      </Layout>
    </ConfigProvider>
  );
} 