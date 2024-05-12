import React from "react";
import "./App.css";
import {ConfigProvider} from "antd";
import {Contro} from "@components/Contro";
import {Proxifier} from "@components/Proxifier";
import {Controller} from "./components/Controller";
import {Eval} from "@components/Eval";
import {EvalInTab} from "@components/EvalInTab";

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
                <Contro/>
                <Proxifier/>

                <Eval/>
                <EvalInTab/>
                {/* <Controller/> */}
            </div>
        </ConfigProvider>
    );
}

export default App;
