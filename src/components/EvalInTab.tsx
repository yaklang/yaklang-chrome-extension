import React, { useEffect, useState } from "react";
import { Button } from "antd";
import TextArea from "antd/lib/input/TextArea";
import { wsc } from "@network/chrome";
import { ActionType } from "../../public/socket";

interface EvalInTabProps {}

export const EvalInTab: React.FC<EvalInTabProps> = () => {
  const [inputData, setInputData] = useState("");

  // useEffect(() => {
  //     // const onConnectListener = (port: chrome.runtime.Port) => {
  //     //     console.assert(port.name === "content-script");
  //     //     port.onMessage.addListener(function (msg) {
  //     //         console.log("on connect", msg)
  //     //     });
  //     //     port.onDisconnect.addListener(function () {
  //     //         console.error("Disconnected from port.");
  //     //     });
  //     //     port.postMessage({type: "TEST", fn_name: "Encrypt", args: inputData});
  //     // };
  //     //
  //     // chrome.runtime.onConnect.addListener(onConnectListener);
  //
  //     // return () => {
  //     //     chrome.runtime.onConnect.removeListener(onConnectListener);
  //     // };
  // }, [inputData]);

  useEffect(() => {
    wsc.onWSCMessage((message) => {
      if (message.action === ActionType.RESTOEVALINTAB) {
        console.log("res:", message.result);
      }
    });
  }, []);

  const handleClick = async () => {
    try {
      const tabId = await wsc.getTabId();
      chrome.runtime.sendMessage({
        action: ActionType.INJECTSCRIPT,
        tabId: tabId,
        value: { fn_name: "Encrypt", args: inputData },
      });
    } catch (error) {}
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputData(event.target.value);
  };

  return (
    <div>
      <TextArea
        value={inputData}
        onChange={handleInputChange}
        placeholder="Enter your expression (e.g., 22 * 33)"
      />
      <Button onClick={handleClick}>eval in tab me</Button>
    </div>
  );
};
