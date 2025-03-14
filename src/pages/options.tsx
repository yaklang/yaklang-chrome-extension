import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'antd';
import { OptionsPage } from './OptionsPage';
import '@/styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Failed to find the root element');

const root = createRoot(container);

root.render(
    <App>
        <OptionsPage />
    </App>
); 