import React from 'react';
import './App.css';
import {Layout, Row} from 'antd';
import {Controller} from "./components/Controller";

function App() {
    return (
        <div className="App" style={{width: 300, backgroundColor: "#eee", padding: 8}}>
            <Layout>
                <Row>
                    <Controller/>
                </Row>
                <Row>
                    PROXY
                </Row>
            </Layout>
        </div>
    );
}

export default App;
