import { ActionType, WebSocketManager } from './socket.js';


console.info("Chrome Extenstion Background is loaded")

const websocketManager = new WebSocketManager();


chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    console.log("msg", msg)
    switch (msg.action) {
        case ActionType.CONNECT:
            console.info("Start to connect websocket")
            const host = msg['host'] || "127.0.0.1"
            const port = msg['port'] || 11212
            websocketManager.connectWebsocket(`ws://${host}:${port}/?token=${"a"}`, port)
            break;
        case ActionType.DISCONNECT:
            websocketManager.disconnectWebsocket();
            break;
        case ActionType.SETPROXY:
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
            });
            break;
        case ActionType.CLEARPROXY:
            chrome.proxy.settings.clear({})
            break;
        case ActionType.PROXYSTATUS:
            chrome.proxy.settings.get({}, function (details) {
                if (details.value && details.value.mode === "fixed_servers") {
                    let proxyConfig = details.value.rules.singleProxy;
                    chrome.runtime.sendMessage({
                        enable: true,
                        proxy: `${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`
                    })
                } else {
                    chrome.runtime.sendMessage({ enable: false, proxy: "" })
                }
            });
            break;
        case ActionType.INJECTSCRIPT:
            chrome.scripting.executeScript({
                target: { tabId: msg.tabId },
                files: ['content.js']
            }).then(() => {
                chrome.tabs.sendMessage(msg.tabId, { type: 'INJECT_CODE', value: msg.value });
            }).catch(err => {
                console.error('Script injection failed:', err);
            });
            break
        case ActionType.SENDRESFROMPAGE:
            chrome.runtime.sendMessage({
                action: ActionType.RESTOEVALINTAB,
                result: msg.result
            })
            break
        case ActionType.ECHO:
            console.log("Echo ", msg.result)
    }

})

const pageFunction = (code) => {
    chrome.runtime.sendMessage({ code }, response => {
        if (response && response.success) {
            console.log('Result:', response.result);
        } else {
            console.error('Error:', response.error);
        }
    });
}
