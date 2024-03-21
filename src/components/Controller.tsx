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
        const id = setInterval(updateStatus, 500)

        wsc.onWSCMessage((req: { connected: boolean }) => {
            if (req['connected'] === undefined) {
                return
            }

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
        if (!init || connected) {
            return
        }

        const findPort = (port: number, max: number) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`)
            ws.onclose = (e: CloseEvent) => {
                if (e.reason !== `FoundYakitWebSocketController` && (port + 1 <= max)) {
                    setTimeout(() => findPort(port + 1, max), 300)
                }

                if (port + 1 > max) {
                    setFindingPort(false)
                    setAutoFindFailedReason("Cannot found Yakit or Yakit WebSocket Controller Port is not right")
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

    return <Card size={"small"} extra={safeConnected ? <Button size={"small"} danger={true} onClick={() => {
        wsc.disconnect()
    }}>
        Disconnect
    </Button> : undefined}>
        {connected && init ?
            <Alert type={"success"} message={"Yakit Connected"}/> :
            <Form
                onSubmitCapture={e => {
                    e.preventDefault()

                    wsc.connect(port)
                }}
                size={"small"}
            >
                {autoFindFailedReason !== '' ? <Alert type={"error"} message={autoFindFailedReason}/> : undefined}
                <Form.Item label={"Controller Port"}>
                    <InputNumber disabled={freeze} value={port} onChange={e => setPort(e)}/>
                </Form.Item>
                <Form.Item>
                    <Button size={"small"} type={"primary"} loading={freeze} htmlType={"submit"}>Connect to
                        Yakit</Button>
                </Form.Item>
            </Form>}
    </Card>
};