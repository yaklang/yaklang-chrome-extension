import React, {useEffect, useState} from "react";
import {Button, Input} from "antd";
import TextArea from "antd/lib/input/TextArea";
import {wsc} from "@network/chrome";

interface EvalInTabProps {
}

export const EvalInTab: React.FC<EvalInTabProps> = () => {
    const [funcName, setFuncName] = useState("");
    const [inputArgsData, setInputArgsData] = useState("");
    const [code, setCode] = useState("");

    useEffect(() => {
        wsc.onWSCMessage((message) => {
            if (message.action === wsc.ActionType.TO_EXTENSION_PAGE) {
                console.log("res:", message.result);
                alert("from content script: " + JSON.stringify(message.result));
            }
        });
    }, []);

    const handleClick = async () => {
        try {
            const [tab] = await wsc.getTab();
            await chrome.runtime.sendMessage({
                action: wsc.ActionType.INJECT_SCRIPT,
                tabId: tab.id,
                value: {mode: "CONTENT_CALL_FUNCTION", fn_name: funcName, args: inputArgsData},
            });
        } catch (error) {
        }
    };

    const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInputArgsData(event.target.value);
    };


    const handleEvalCodeClick = async () => {
        try {
            const [tab] = await wsc.getTab();
            await chrome.runtime.sendMessage({
                action: wsc.ActionType.INJECT_SCRIPT,
                tabId: tab.id,
                value: {mode: "CONTENT_EVAL_CODE", code: code},
            });
        } catch (error) {
        }
    }

    return (
        <div>
            <Input
                value={funcName}
                onChange={(e) => setFuncName(e.target.value)}
                placeholder="Enter function name"
            ></Input>
            <TextArea
                value={inputArgsData}
                onChange={handleInputChange}
                placeholder="Enter your expression (e.g., 22 * 33)"
            />
            <Button onClick={handleClick}>eval func in tab</Button>

            <TextArea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter your expression (e.g., 22 * 33)"
            />
            <Button onClick={handleEvalCodeClick}>eval code in tab</Button>
        </div>
    );
};
