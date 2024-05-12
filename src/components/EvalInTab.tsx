import React, {useEffect, useState} from "react";
import {Button} from "antd";
import TextArea from "antd/lib/input/TextArea";
import {wsc} from "@network/chrome";

interface EvalInTabProps {
}

export const EvalInTab: React.FC<EvalInTabProps> = () => {
    const [inputData, setInputData] = useState("");
    const [isScriptInjected, setIsScriptInjected] = useState(false);

    useEffect(() => {
        const onConnectListener = (port: chrome.runtime.Port) => {
            console.assert(port.name === "content-script");
            port.onMessage.addListener(function (msg) {
                console.log("on connect", msg)
            });
            port.onDisconnect.addListener(function () {
                console.error("Disconnected from port.");
            });
            port.postMessage({type: "TEST", fn_name: "Encrypt", args: inputData});
        };

        chrome.runtime.onConnect.addListener(onConnectListener);

        // return () => {
        //     chrome.runtime.onConnect.removeListener(onConnectListener);
        // };
    }, [inputData]);

    const handleClick = async () => {
        if (!isScriptInjected) {
            chrome.scripting.executeScript({
                target: {tabId: await wsc.getTabId()},
                files: ['inject.js'],
            }).then(injectResults => {
                console.log(injectResults)
                setIsScriptInjected(true);
            });
        }
        console.log("injected script")

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
}
