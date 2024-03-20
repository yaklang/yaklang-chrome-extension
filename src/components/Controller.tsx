import React, {useEffect} from "react";
import {Card} from "antd";

export interface ControllerProp {

}

export const Controller: React.FC<ControllerProp> = (props) => {
    const [connected, setConnected] = React.useState<boolean>(false)
    const ref = React.useRef<HTMLAnchorElement>(null)

    useEffect(() => {
        if (!ref) {
            return
        }

        // const update = () => {
        //     ref.current.click()
        // }
        // const id = setInterval(update, 10000)
        // return () => {
        //     clearInterval(id)
        // }
    }, [ref])

    return <Card size={"small"} title={"连接器"}>
        <a href={"yakitctrl://start/"} ref={ref}>Yakit 启动</a>
    </Card>
};