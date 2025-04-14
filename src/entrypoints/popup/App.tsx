import React from 'react';
import {ConfigProvider} from 'antd';
import {ProxySwitch} from '@/components/ProxySwitch';
import '@/styles/global.css'
import './App.css';

export default function App() {
    return (
        <ConfigProvider
            theme={{
                token: {
                    colorPrimary: "#F28B44",
                },
            }}
        >
            <div className="popup-container">
                <header className="popup-header">
                    <h1>Yaklang 代理管理</h1>
                </header>
                <main className="popup-content">
                    <ProxySwitch/>
                </main>
            </div>
        </ConfigProvider>
    );
}
