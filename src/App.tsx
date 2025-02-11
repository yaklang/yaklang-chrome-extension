import React from "react";
// import "./App.css";
import {ConfigProvider} from "antd";
import {Contro} from "@components/Contro";
import {Proxifier} from "@components/Proxifier";
import {EvalInTab} from "@components/EvalInTab";
import {ProxySwitch} from "@components/ProxySwitch";
import './styles/global.css';

function App() {
    return (
        <ConfigProvider
            theme={{
                token: {
                    colorPrimary: "#F28B44",
                },
            }}
        >
            <div className="App">
                {/*<Contro/>*/}
                {/* <Proxifier/> */}
                <ProxySwitch/>

                {/* <EvalInTab/> */}
            </div>
        </ConfigProvider>
    );
}

export default App;
