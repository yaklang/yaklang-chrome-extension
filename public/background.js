import {ActionType, WebSocketManager} from './connect.js';


console.info("Chrome Extenstion Background is loaded")

const websocketManager = new WebSocketManager();


chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    console.log("msg", msg)
    if (msg.action === ActionType.CONNECT) {
        console.info("Start to connect websocket")
        const host = msg['host'] || "127.0.0.1"
        const port = msg['port'] || 11212
        websocketManager.connectWebsocket(`ws://${host}:${port}/?token=${"a"}`)
    } else if (msg.action === ActionType.DISCONNECT) {
        websocketManager.disconnectWebsocket()
    } else if (msg.action === ActionType.SETPROXY) {
        chrome.proxy.settings.set({
            value: {
                mode: "fixed_servers",
                rules: {
                    singleProxy: {
                        scheme: msg.scheme,
                        host: msg.host,
                        port: parseInt(`${msg.port}`)
                    }
                }
            },
            scope: 'regular',
        })

    } else if (msg.action === ActionType.CLEARPROXY) {
        chrome.proxy.settings.clear({})
    } else if (msg.action === ActionType.PROXYSTATUS) {
        chrome.proxy.settings.get({}, function (details) {
            if (details.value && details.value.mode === "fixed_servers") {
                let proxyConfig = details.value.rules.singleProxy;
                chrome.runtime.sendMessage({
                    enable: true,
                    proxy: `${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`
                })
            } else {
                chrome.runtime.sendMessage({enable: false, proxy: ""})
            }
        });
    }
})
