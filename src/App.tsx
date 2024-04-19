import React from "react";
import "./App.css";
import { ConfigProvider } from "antd";
// import { Contro } from "@components/Contro";
import { Proxifier } from "@components/Proxifier";
// import { Controller } from "./components/Controller";

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
        {/* <Controller/> */}
        <Proxifier/>
      </div>
    </ConfigProvider>
  );
}

export default App;
