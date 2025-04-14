import React from 'react';
import {ProxySwitch} from '@/components/ProxySwitch';
import '@/styles/global.css'
import './App.css';

export default function App() {
    return (
        <div className="popup-container">
            <main className="popup-content">
                <ProxySwitch/>
            </main>
        </div>
    );
}
