import React, { useEffect, useState } from "react";
import { Divider, Tooltip, Input } from "antd";
import classNames from "classnames";
import {
  CheckIcon,
  ExitIcon,
  PencilAltIcon,
  RefreshIcon,
  XIcon,
} from "@assets/icon/icon";
import "./Contro.css";

interface ControProps {}
export const Contro: React.FC<ControProps> = () => {
  const [isEdit, setIsEdit] = useState<boolean>(false);
  const [connected, setConnected] = useState(false);
  const [autoFindFailedReason, setAutoFindFailedReason] = useState<string>("");
  const [enginePort, setEnginePort] = useState<string>("0");
  const [enginePortTemp, setEnginePortTemp] = useState<string>(enginePort);

  // useEffect(() => {
  //   const updateStatus = () => {
  //     wsc.updateWSCStatus();
  //   };
  //   updateStatus();
  //   const id = setInterval(updateStatus, 500);

  //   wsc.onWSCMessage((req: { connected: boolean }) => {
  //     if (req["connected"] === undefined) {
  //       return;
  //     }
  //     console.log("connected", req.connected);
  //     setConnected(req.connected);
  //   });
  //   return () => {
  //     clearInterval(id);
  //   };
  // }, []);

  return (
    <div
      className={classNames("Contro", {
        ["Contro-success-bg"]: !autoFindFailedReason,
        ["Contro-error-bg"]: autoFindFailedReason,
      })}
    >
      <div className="Contro-lable">Yakit 引擎连接状态：</div>
      <div className="Contro-cont">
        {isEdit ? (
          <>
            <Input
              rootClassName="Contro-cont-input"
              value={enginePortTemp}
              onChange={(e) => {
                // TODO 需要校验
                const value = e.target.value;
                setEnginePortTemp(value);
              }}
            />
            <div className="Contro-handle-icon">
              <XIcon
                className="icon-p"
                onClick={() => {
                  setIsEdit(false);
                }}
              />
              <CheckIcon
                className="contro-handle-icon-check icon-p"
                onClick={() => {
                  setIsEdit(false);
                  setEnginePort(enginePortTemp);
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div
              className={classNames("Contro-cont-text", {
                ["Contro-cont-text-success"]: !autoFindFailedReason,
                ["Contro-cont-text-error"]: autoFindFailedReason,
              })}
            >
              {autoFindFailedReason
                ? autoFindFailedReason + "（" + enginePort + "）"
                : "已连接（" + enginePort + "）"}
            </div>
            <div className="Contro-handle-icon">
              <Tooltip title="修改监听端口">
                <PencilAltIcon
                  className="icon-p"
                  onClick={() => {
                    setIsEdit(true);
                    setEnginePortTemp(enginePort);
                  }}
                />
              </Tooltip>
              <Divider type="vertical" style={{ height: 16 }} />
              {autoFindFailedReason ? (
                <Tooltip title="重新连接">
                  <RefreshIcon />
                </Tooltip>
              ) : (
                <Tooltip title="断开连接">
                  <ExitIcon />
                </Tooltip>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
