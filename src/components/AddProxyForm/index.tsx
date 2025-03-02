import React from 'react';
import { Form, Input, Select, InputNumber, Button, message } from 'antd';
import { ProxyActionType } from '@/types/action';
import './index.css';

interface EditFormData {
    name: string;
    proxyType: string;
    scheme?: string;
    host?: string;
    port?: number;
    pacScript?: string;
}

export const AddProxyForm: React.FC = () => {
    const [form] = Form.useForm<EditFormData>();

    // 初始化表单
    React.useEffect(() => {
        form.setFieldsValue({
            name: '',
            proxyType: 'fixed_servers',
            scheme: 'http',
            host: '127.0.0.1',
            port: 8080
        });
    }, []);

    const handleSave = async () => {
        try {
            const values = await form.validateFields();
            const newConfig = {
                id: Date.now().toString(),
                ...values,
                enabled: false
            };

            const response = await chrome.runtime.sendMessage({
                action: ProxyActionType.ADD_PROXY_CONFIG,
                config: newConfig
            });

            if (response.success) {
                message.success('添加成功');
                window.close();  // 关闭窗口
            }
        } catch (error) {
            console.error('Failed to add proxy:', error);
            message.error('添加失败');
        }
    };

    return (
        <div className="add-proxy-form">
            <Form
                form={form}
                layout="vertical"
                onFinish={handleSave}
            >
                {/* 表单项与之前相同 */}
                <Form.Item className="form-buttons">
                    <Button type="primary" htmlType="submit">
                        确定
                    </Button>
                    <Button onClick={() => window.close()}>
                        取消
                    </Button>
                </Form.Item>
            </Form>
        </div>
    );
}; 