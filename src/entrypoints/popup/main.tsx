import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { watchTheme } from '@/platform/storage/appearance';
import '@/styles/global.css';
import './style.css';

watchTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
