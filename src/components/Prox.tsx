import React, { useEffect, useState } from "react";
import { Space, Select, Input, Switch } from "antd";
import { PlusSmIcon, TrashIcon } from "@assets/icon/icon";
import { wsc } from "@network/chrome";
import "./Prox.css";

interface ProxyConfig {
  id: string;
  scheme: "http" | "socks5";
  host: string;
  port: string;
  hostStatus: "error" | "";
  portStatus: "error" | "";
  open: boolean;
}

export interface ProxProps {}
export const Prox: React.FC<ProxProps> = () => {
  const [proxyList, setProxyList] = useState<ProxyConfig[]>([]);

  // proxy
  useEffect(() => {
    const update = () => {
      wsc.updateProxyStatus();
    };
    update();

    const id = setInterval(update, 500);
    return () => {
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    wsc.onProxyStatusMessage((msg) => {
      if (msg["proxy"] === undefined || msg["enable"] === undefined) {
        return;
      }
      console.log("当前代理：", msg);
    });
  }, []);

  const hostOnchange = (value: string, id: string) => {
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const domainPattern = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const copyProxyList = structuredClone(proxyList);
    if (value === "" || ipPattern.test(value) || domainPattern.test(value)) {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.hostStatus = "";
          i.host = value;
        }
      });
    } else {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.hostStatus = "error";
          i.host = value;
        }
      });
    }
    setProxyList(copyProxyList);
  };

  const portOnchange = (value: string, id: string) => {
    const portNumber = parseInt(value, 10);
    const copyProxyList = structuredClone(proxyList);
    if (
      value === "" ||
      (/^\d+$/.test(value) && portNumber >= 0 && portNumber <= 65535)
    ) {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.portStatus = "";
          i.port = value === "" ? "" : portNumber + "";
        }
      });
    } else {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.portStatus = "error";
          i.port = value;
        }
      });
    }
    setProxyList(copyProxyList);
  };

  return (
    <div className="Prox">
      <div className="Prox-title-wrap">
        <div className="Prox-title-wrap-left">
          <span className="prox-title">设置代理</span>
          <span className="prox-number">{proxyList.length}</span>
        </div>
        <div
          className="Prox-title-wrap-right"
          onClick={() => {
            setProxyList([
              ...proxyList,
              {
                id: Math.random() + "",
                scheme: "http",
                host: "",
                port: "",
                hostStatus: "",
                portStatus: "",
                open: false,
              },
            ]);
          }}
        >
          <span className="Prox-add-text">添加</span>
          <PlusSmIcon className="Prox-add-icon" />
        </div>
      </div>
      <div className="Prox-list-wrap">
        {proxyList.length ? (
          proxyList.map((item) => (
            <div className="Prox-list-item-wrap" key={item.id}>
              <Space className="Prox-list-item-space">
                <Space.Compact>
                  <Select
                    value={item.scheme}
                    style={{ width: 88 }}
                    disabled={item.open}
                    onChange={(value, option) => {
                      const copyProxyList = structuredClone(proxyList);
                      copyProxyList.forEach((i) => {
                        if (i.id === item.id) {
                          i.scheme = value;
                        }
                      });
                      setProxyList(copyProxyList);
                    }}
                  >
                    <Select.Option value="http">HTTP</Select.Option>
                    <Select.Option value="socks5">Socks5</Select.Option>
                  </Select>
                  <Input
                    value={item.host}
                    style={{ width: 136 }}
                    disabled={item.open}
                    status={item.hostStatus}
                    onChange={(e) => hostOnchange(e.target.value, item.id)}
                  />
                  <Input
                    value={item.port}
                    style={{ width: 64 }}
                    disabled={item.open}
                    status={item.portStatus}
                    onChange={(e) => portOnchange(e.target.value, item.id)}
                  />
                </Space.Compact>
              </Space>
              {!item.open && (
                <TrashIcon
                  className="proxy-list-del-icon"
                  onClick={() => {
                    setProxyList(proxyList.filter((i) => i.id !== item.id));
                  }}
                />
              )}
              <Switch
                checkedChildren="启"
                unCheckedChildren="停"
                value={item.open}
                disabled={
                  item.hostStatus === "error" ||
                  item.portStatus === "error" ||
                  item.host === "" ||
                  item.port === ""
                }
                onChange={(checked: boolean) => {
                  wsc.clearproxy();
                  const copyProxyList = structuredClone(proxyList);
                  copyProxyList.forEach((i) => {
                    if (i.id === item.id) {
                      i.open = checked;
                      if (checked) {
                        wsc.setproxy(item.scheme, item.host, Number(item.port));
                      }
                    } else {
                      i.open = false;
                    }
                  });
                  setProxyList(copyProxyList);
                }}
              />
            </div>
          ))
        ) : (
          <div
            className="add-list"
            onClick={() => {
              setProxyList([
                {
                  id: Math.random() + "",
                  scheme: "http",
                  host: "127.0.0.1",
                  port: "8083",
                  hostStatus: "",
                  portStatus: "",
                  open: false,
                },
              ]);
            }}
          >
            <PlusSmIcon className="add-list-icon" />
            <span className="add-list-text">添加</span>
          </div>
        )}
      </div>
    </div>
  );
};
