import React from 'react';
import './App.css';
import {Layout, Row} from 'antd';

function App() {
    return (
        <div className="App" style={{width: 300, backgroundColor: "#eee", padding: 8}}>
            <Layout>
                <Row>
                    Hello WOrld First
                </Row>
                <Row>
                    PROXY
                </Row>
            </Layout>
        </div>
    );
}

export default App;
