import React, { useEffect, useMemo, useState } from "react";
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
import {ActionType} from "../../public/connect";

interface ControProps {}
export const Contro: React.FC<ControProps> = () => {
  const [isEdit, setIsEdit] = useState<boolean>(false);
  const [connected, setConnected] = useState(false);
  const [autoFindFailedReason, setAutoFindFailedReason] = useState<string>("");
  const [enginePort, setEnginePort] = useState<string>("");
  const [enginePortTemp, setEnginePortTemp] = useState<string>(enginePort);

  useEffect(() => {
    findPort(11212, 11222);
  }, []);
  const findPort = (port: number, max: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onclose = (e: CloseEvent) => {
      if (e.reason !== `FoundYakitWebSocketController` && port + 1 <= max) {
        setTimeout(() => findPort(port + 1, max), 200);
      }

      if (port + 1 > max) {
        setConnected(false);
        setEnginePort("");
        setAutoFindFailedReason("Cannot found Yakit");
      }
    };
    ws.onopen = () => {
      setConnected(true);
      setEnginePort(port + "");
      setAutoFindFailedReason("");
      ws.close(1000, "FoundYakitWebSocketController");
      connectPort(port);
    };
  };

  const connectPort = (port: number) => {
    wsc.connect(port);
    wsc.onWSCMessage((message) => {
      if (message.action === ActionType.STATUS) {
        console.log("onWSCMessage", message)
        if (message.connected === undefined) {
          return;
        }
        setConnected(message.connected);
        if (message.connected === false) {
          setAutoFindFailedReason("Yakit WebSocket Controller Port is not right");
        } else {
          setAutoFindFailedReason("");
        }
      }
    });
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
                    <Tooltip title="断开连接">
                      <ExitIcon onClick={() => wsc.disconnect()} />
                    </Tooltip>
                  )}
                  {failConnected && (
                    <Tooltip title="重新连接">
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
                    </Tooltip>
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
