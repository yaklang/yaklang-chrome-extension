import React, {useEffect} from "react";
import {Alert, Button, Card, Form, InputNumber} from "antd";
import {wsc} from "../network/chrome";
import {useGetState} from "ahooks";

export interface ControllerProp {

}

export const Controller: React.FC<ControllerProp> = (props) => {
    const [findingPort, setFindingPort] = React.useState<boolean>(false)
    const [autoFindFailedReason, setAutoFindFailedReason] = React.useState<string>("")
    const [port, setPort] = React.useState<number>()

    const [connected, setConnected, getConnected] = useGetState(false);
    const [init, setInit] = React.useState(false)

    useEffect(() => {
        // control status
        const updateStatus = () => {
            wsc.updateWSCStatus()
        }
        updateStatus()
        const id = setInterval(updateStatus, 1000)

        wsc.onWSCMessage((req: { connected: boolean }) => {
            setConnected(req.connected)
            setTimeout(() => {
                setInit(true)
            }, 500)
        })
        return () => {
            clearInterval(id)
        }
    }, [])

    useEffect(() => {
        if (!init) {
            return
        }

        if (connected) {
            return
        }

        const findPort = (port: number, max: number) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`)
            ws.onclose = (e: CloseEvent) => {
                if (e.reason !== `FoundYakitWebSocketController` && (port + 1 <= max)) {
                    setTimeout(() => findPort(port + 1, max), 1000)
                }

                if (port + 1 > max) {
                    setFindingPort(false)
                    setAutoFindFailedReason("Yakit 未启动或无法监测到 WebSocket Controller 端口")
                }
            }
            ws.onopen = () => {
                setFindingPort(false)
                setPort(port)
                ws.close(1000, "FoundYakitWebSocketController")
            }
        }
        findPort(11212, 11222)
    }, [connected, init])

    const freeze = findingPort || (!init);
    const safeConnected = connected && init;

    return <Card size={"small"} extra={safeConnected ? <Button>
        断开链接
    </Button> : <Button></Button>}>
        {connected && init ? <Alert type={"success"} message={"已连接至 Yakit"}/> : <Form onSubmitCapture={e => {
            e.preventDefault()

            wsc.connect(port)
        }}>
            {autoFindFailedReason !== '' ? <Alert type={"error"} message={autoFindFailedReason}/> : undefined}
            <Form.Item label={"端口"}>
                <InputNumber disabled={freeze} value={port} onChange={e => setPort(e)}/>
            </Form.Item>
            <Form.Item>
                <Button loading={freeze} htmlType={"submit"}>连接至 Yakit</Button>
            </Form.Item>
        </Form>}
    </Card>
};