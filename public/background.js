import {ActionType, injectScriptAndSendMessage, WebSocketManager} from './socket.js';


console.info("Chrome Extenstion Background is loaded")

const websocketManager = new WebSocketManager();


chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    console.log("msg", msg)
    switch (msg.action) {
        case ActionType.CONNECT:
            console.info("Start to connect websocket")
            const host = msg['host'] || "127.0.0.1"
            const port = msg['port'] || 11212
            websocketManager.connectWebsocket(`ws://${host}:${port}/?token=chrome`, port)
            break;
        case ActionType.SEND_MESSAGE:
            websocketManager.sendMessage(msg.message);
            break;
        case ActionType.DISCONNECT:
            websocketManager.disconnectWebsocket();
            break;
        case ActionType.SET_PROXY:
            chrome.proxy.settings.set({
                value: {
                    mode: "fixed_servers",
                    rules: {
                        singleProxy: {
                            scheme: msg.scheme,
                            host: msg.host,
                            port: parseInt(`${msg.port}`)
                        },
                        // enable 127.0.0.1 && localhost to mitmproxy
                        bypassList: ["<-loopback>"]
                    }
                },
                scope: 'regular',
            });
            break;
        case ActionType.CLEAR_PROXY:
            chrome.proxy.settings.clear({})
            break;
        case ActionType.PROXY_STATUS:
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
            break;
        case ActionType.INJECT_SCRIPT:
            (async () => {
                await injectScriptAndSendMessage(msg.tabId, {
                    type: ActionType.INJECT_SCRIPT,
                    value: msg.value
                });
            })();
            break
    }
})

