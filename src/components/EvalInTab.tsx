import React, {useEffect, useState} from "react";
import {Button} from "antd";
import TextArea from "antd/lib/input/TextArea";
import {wsc} from "@network/chrome";

interface EvalInTabProps {
}

export const EvalInTab: React.FC<EvalInTabProps> = () => {
    const [inputData, setInputData] = useState("");
    const [port, setPort] = useState<chrome.runtime.Port>()

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
        const injectFun = async () => {
            const tabId = await wsc.getTabId();
            chrome.scripting.executeScript({
                target: {tabId: tabId},
                files: ['inject.js'],
            }).then(() => {
                const newPort = chrome.tabs.connect(tabId, {name: "ex-to-content"})
                setPort(newPort)
                newPort.onMessage.addListener(function (msg) {
                    console.log(msg)
                })
            })
        }
        injectFun()
        return () => {
            if (port) {
                port.disconnect()
            }
        }
    }, [])

    const handleClick = async () => {
        port.postMessage({type: "TEST", fn_name: "Encrypt", args: inputData});
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
