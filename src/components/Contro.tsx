import React, { useEffect, useMemo, useRef, useState } from "react";
import { Divider, Tooltip, Input } from "antd";
import classNames from "classnames";
import {
  CheckIcon,
  ExitIcon,
  PencilAltIcon,
  RefreshIcon,
  XIcon,
} from "@assets/icon/icon";
import { wsc } from "@network/chrome";
import "./Contro.css";
import { ActionType } from "../../public/socket";

interface ControProps {}
export const Contro: React.FC<ControProps> = () => {
  const [isEdit, setIsEdit] = useState<boolean>(false);
  const [connected, setConnected] = useState(false);
  const [autoFindFailedReason, setAutoFindFailedReason] = useState<string>("");
  const [enginePort, setEnginePort] = useState<string>("");
  const [enginePortTemp, setEnginePortTemp] = useState<string>(enginePort);
  const enginePortRef = useRef<string>(enginePort);

  useEffect(() => {
    enginePortRef.current = enginePort;
  }, [enginePort]);

  useEffect(() => {
    const yakitConnectInfo = localStorage.getItem("yakit-connect");
    if (!yakitConnectInfo) {
      findPort(11212, 11222);
    } else {
      const { port, connected } = JSON.parse(yakitConnectInfo);
      setConnected(connected);
      setEnginePort(port + "");
      setAutoFindFailedReason("");
    }

    wsc.onWSCMessage((message) => {
      if (message.action === ActionType.STATUS) {
        if (message.connected === false) {
          handleConnectFail();
        } else {
          localStorage.setItem(
            "yakit-connect",
            JSON.stringify({ connected: true, port: message.port })
          );
          setEnginePort(message.port + "");
          setConnected(true);
          setAutoFindFailedReason("");
        }
      }
    });
  }, []);

  const findPort = (port: number, max: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onclose = (e: CloseEvent) => {
      if (enginePortRef.current) {
        handleConnectFail();
        return;
      }
      if (e.reason !== `FoundYakitWebSocketController` && port + 1 <= max) {
        setTimeout(() => findPort(port + 1, max), 200);
      }

      if (port + 1 > max) {
        setConnected(false);
        setEnginePort("");
        setAutoFindFailedReason("Cannot found Yakit");
        localStorage.setItem("yakit-connect", "");
      }
    };
    ws.onopen = () => {
      setConnected(true);
      setEnginePort(port + "");
      ws.close(1000, "FoundYakitWebSocketController");
      connectPort(port);
    };
  };

  const handleConnectFail = () => {
    setConnected(false);
    setAutoFindFailedReason("Yakit WebSocket Controller Connect Fail");
    localStorage.setItem("yakit-connect", "");
  };

  const connectPort = (port: number) => {
    setAutoFindFailedReason("");
    wsc.connect(port);
  };

  const safeConnected = useMemo(() => {
    return connected && enginePort;
  }, [connected, enginePort]);

  const failConnected = useMemo(() => {
    return !connected && autoFindFailedReason;
  }, [connected, autoFindFailedReason]);

  return (
    <>
      {safeConnected || failConnected ? (
        <div
          className={classNames("Contro", {
            ["Contro-success-bg"]: safeConnected,
            ["Contro-error-bg"]: failConnected,
          })}
        >
          <div className="Contro-lable">Yakit 引擎连接状态：</div>
          <div className="Contro-cont">
            {isEdit ? (
              <>
                <Input
                  rootClassName="Contro-cont-input"
                  value={enginePortTemp}
                  placeholder="输入范围 11212 - 11222"
                  onChange={(e) => {
                    const value = e.target.value;
                    setEnginePortTemp(value);
                  }}
                />
                <div className="Contro-handle-icon">
                  <XIcon
                    className="grey-icon icon-p icon-active"
                    onClick={() => {
                      setIsEdit(false);
                    }}
                  />
                  <CheckIcon
                    className="contro-handle-icon-check icon-p"
                    onClick={() => {
                      if (enginePortTemp) {
                        setIsEdit(false);
                        setEnginePort(enginePortTemp);
                        connectPort(Number(enginePortTemp));
                      }
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <div
                  className={classNames("Contro-cont-text", {
                    ["Contro-cont-text-success"]: safeConnected,
                    ["Contro-cont-text-error"]: failConnected,
                  })}
                >
                  {safeConnected && "已连接（" + enginePort + "）"}
                  {failConnected &&
                    (enginePort
                      ? autoFindFailedReason + "（" + enginePort + "）"
                      : autoFindFailedReason)}
                </div>
                <div className="Contro-handle-icon">
                  <Tooltip title="修改监听端口">
                    <PencilAltIcon
                      className="grey-icon icon-p icon-active"
                      onClick={() => {
                        setIsEdit(true);
                        setEnginePortTemp(enginePort);
                      }}
                    />
                  </Tooltip>
                  <Divider type="vertical" style={{ height: 16 }} />
                  {safeConnected && (
                    <ExitIcon onClick={() => wsc.disconnect()} />
                  )}
                  {failConnected && (
                    <RefreshIcon
                      className="grey-icon icon-active"
                      onClick={() => {
                        if (enginePort) {
                          connectPort(Number(enginePort));
                        } else {
                          findPort(11212, 11222);
                        }
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
};
