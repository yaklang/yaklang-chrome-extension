import React, {useEffect, useState} from "react";
import {Button, Card, Form, Input, InputNumber, Select, Space} from "antd";
import {wsc} from "../network/chrome";

export interface ProxifierProp {

}

const {Compact} = Space;

interface ProxyConfig {
    scheme: "http" | "socks5";
    host: string;
    port: number;
}

export const Proxifier: React.FC<ProxifierProp> = (props) => {
    const [config, setConfig] = useState<ProxyConfig>({
        scheme: "http",
        host: "127.0.0.1",
        port: 8083
    });
    const [init, setInit] = useState(false);
    const [proxyEnable, setProxyEnable] = useState(false);
    const [currentProxy, setCurrentProxy] = useState("");

    useEffect(() => {
        if (init) {
            return
        }

        wsc.onProxyStatusMessage(msg => {
            setInit(true)
            setProxyEnable(msg.enable)
            setCurrentProxy(msg.proxy)
        })
    }, [init])

    // proxy
    useEffect(() => {
        const update = () => {
            wsc.updateProxyStatus()
        }
        update()
        const id = setInterval(update, 1000)
        return () => {
            clearInterval(id)
        }
    }, [])

    return <Card title={`代理设置: ${proxyEnable ? currentProxy : "未启用"}`}>
        <Form size={"small"} onSubmitCapture={e => {
            e.preventDefault()
            setInit(false)
            wsc.setproxy(config.scheme, config.host, config.port)
        }} disabled={!init}>
            <Form.Item label={"设置代理"}>
                <Compact>
                    <Select
                        style={{width: 86}}
                        value={config.scheme}
                        onChange={e => (setConfig({...config, scheme: e}))}
                    >
                        <Select.Option value={"http"}>HTTP</Select.Option>
                        <Select.Option value={"socks5"}>Socks5</Select.Option>
                    </Select>
                    <Input
                        style={{width: 100}}
                        placeholder={"ProxyHost"}
                        value={config.host}
                        onChange={e => (setConfig({...config, host: e.target.value}))}/>
                    <InputNumber
                        style={{width: 65}}
                        placeholder={"Port"}
                        value={config.port}
                        onChange={e => (setConfig({...config, port: e}))}
                    />
                </Compact>
            </Form.Item>
            <Form.Item>
                <Button htmlType={"submit"} loading={!init}>启用链接</Button>
            </Form.Item>
        </Form>
    </Card>
};