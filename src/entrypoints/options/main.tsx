import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import { watchTheme } from '@/platform/storage/appearance';
import '@/styles/global.css'
import './style.css';

watchTheme();

const root = createRoot(document.getElementById('app')!);
root.render(<App/>);