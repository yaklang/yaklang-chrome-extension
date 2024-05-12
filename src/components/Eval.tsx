import React, {useEffect, useState} from "react";
import TextArea from "antd/lib/input/TextArea";
import {Button} from "antd";

interface EvalProps {
}

export const Eval: React.FC<EvalProps> = () => {
    const [inputData, setInputData] = useState(""); // 状态用于存储 textarea 输入的数据

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // 检查消息来源是否安全
            // if (event.origin !== "http://example.com") { // 适当替换为你的期望源
            //     return;
            // }
            console.log(event.data)
            alert(`Received message: ${event.data}`);
        }

        // 添加事件监听器
        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []);

    // 处理按钮点击事件
    const handleClick = () => {
        const iframe = document.getElementById('sandbox') as HTMLIFrameElement; // 正确的类型断言
        if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({fn: 'Encrypt', args: '111111'}, '*'); // 发送用户输入的数据到 iframe
        }
    };

    // 更新 textarea 输入
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
            <Button onClick={handleClick}>Click me</Button>
        </div>
    );
}
