import React, { useEffect, useState } from "react";
import { Space, Select, Input, Switch } from "antd";
import { PlusSmIcon, TrashIcon } from "@assets/icon/icon";
import { wsc } from "@network/chrome";
import "./Proxifier.css";

type Scheme = "http" | "socks5";
interface ProxyConfig {
  id: string;
  scheme: Scheme;
  host: string;
  port: string;
  hostStatus: "error" | "";
  portStatus: "error" | "";
  open: boolean;
  proxy: string;
}

export interface ProxifierProps {}
export const Proxifier: React.FC<ProxifierProps> = () => {
  const [proxyList, setProxyList] = useState<ProxyConfig[]>(() => {
    const storageProxyList = localStorage.getItem("yakit-proxy-list") || "[]";
    return JSON.parse(storageProxyList);
  });

  useEffect(() => {
    localStorage.setItem("yakit-proxy-list", JSON.stringify(proxyList));
  }, [proxyList]);

  const addNewProxyListItem = (
    scheme: Scheme,
    host: string,
    port: string,
    open: boolean,
    proxy: string
  ) => {
    const proxyItem: ProxyConfig = {
      id: Math.random() + "",
      scheme: scheme as Scheme,
      host: host,
      port: port,
      hostStatus: "",
      portStatus: "",
      open: open,
      proxy: proxy,
    };
    return proxyItem;
  };

  const parseUrl = (url: string) => {
    const regex = /^(.*?):\/\/(.*?):(\d+)/;
    const match = url.match(regex);
    if (match) {
      const scheme = match[1];
      const host = match[2];
      const port = match[3];
      return {
        scheme,
        host,
        port,
      };
    } else {
      return null; // 不匹配格式
    }
  };

  useEffect(() => {
    wsc.updateProxyStatus();

    wsc.onProxyStatusMessage((msg) => {
      if (msg.proxy === undefined || msg.enable === undefined) {
        return;
      }
      if (msg.proxy === "" || msg.enable === false) {
        if (proxyList.some((i) => i.open)) {
          const copyProxyList = [...proxyList];
          copyProxyList.forEach((i) => {
            i.open = false;
          });
          setProxyList(copyProxyList);
        }
        return;
      }

      if (msg.proxy && msg.enable) {
        const copyProxyList = [...proxyList];
        let newProxyItem: ProxyConfig = undefined;
        if (!copyProxyList.length) {
          const urlObj = parseUrl(msg.proxy);
          if (urlObj) {
            newProxyItem = addNewProxyListItem(
              urlObj.scheme as Scheme,
              urlObj.host,
              urlObj.port,
              true,
              msg.proxy
            );
          }
        } else {
          const proxyExist = copyProxyList.some((i) => i.proxy === msg.proxy);
          if (proxyExist) {
            const proxyOpen = copyProxyList.some(
              (i) => i.open && i.proxy === msg.proxy
            );
            if (!proxyOpen) {
              copyProxyList.forEach((i) => {
                i.open = false;
              });
              for (let i = 0; i < copyProxyList.length; i++) {
                if (copyProxyList[i].proxy === msg.proxy) {
                  copyProxyList[i].open = true;
                  break;
                }
              }
            }
          } else {
            copyProxyList.forEach((i) => {
              i.open = false;
            });
            const urlObj = parseUrl(msg.proxy);
            if (urlObj) {
              newProxyItem = addNewProxyListItem(
                urlObj.scheme as Scheme,
                urlObj.host,
                urlObj.port,
                true,
                msg.proxy
              );
            }
          }
        }

        if (newProxyItem) {
          copyProxyList.unshift(newProxyItem);
        }
        setProxyList(copyProxyList);
      }
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
          i.proxy = i.scheme + "://" + value + ":" + i.port;
        }
      });
    } else {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.hostStatus = "error";
          i.host = value;
          i.proxy = i.scheme + "://" + value + ":" + i.port;
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
          const port = value === "" ? "" : portNumber + "";
          i.port = port;
          i.proxy = i.scheme + "://" + i.host + ":" + port;
        }
      });
    } else {
      copyProxyList.forEach((i) => {
        if (i.id === id) {
          i.portStatus = "error";
          i.port = value;
          i.proxy = i.scheme + "://" + i.host + ":" + value;
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
              addNewProxyListItem("http", "", "", false, "http://"),
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
                          i.proxy = value + "://" + i.host + ":" + i.port;
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
                  wsc.clearProxy();
                  const copyProxyList = structuredClone(proxyList);
                  copyProxyList.forEach((i) => {
                    if (i.id === item.id) {
                      i.open = checked;
                      if (checked) {
                        wsc.setProxy(item.scheme, item.host, Number(item.port));
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
                addNewProxyListItem(
                  "http",
                  "127.0.0.1",
                  "8083",
                  false,
                  "http://127.0.0.1:8083"
                ),
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
