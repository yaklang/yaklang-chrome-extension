import React from "react";
import "./App.css";
import { ConfigProvider } from "antd";
import { Contro } from "@components/Contro";
import { Prox } from "@components/Prox";
// import { Controller } from "./components/Controller";
import {Proxifier} from "./components/Proxifier";

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
        {/* <Contro /> */}
        <Prox />
        {/* <Controller/> */}
        {/* <Proxifier/> */}
      </div>
    </ConfigProvider>
  );
}

export default App;
