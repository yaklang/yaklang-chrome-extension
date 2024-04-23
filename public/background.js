let socket;
const connectWebsocket = url => {
    disconnectWebsocket()
    socket = new WebSocket(url);
    socket.onopen = () => {
        chrome.runtime.sendMessage({ connected: true })
    }
    socket.onclose = () => {
        chrome.runtime.sendMessage({ connected: false })
    }
}

const disconnectWebsocket = () => {
    if (socket) {
        try {
            socket.close()
            socket = null;
        } catch (e) {

        }
    }
}

heartbeat = () => {
    if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({
                    "type": "heartbeat",
                }))
            } catch (e) {
                console.error("Error sending heartbeat:", e);
            }
        } else {
            disconnectWebsocket()
        }
    }
}
heartbeat()
setInterval(heartbeat, 3000)

console.info("Chrome Extenstion Background is loaded")

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === "connect") {
        console.info("Start to connect websocket")
        const host = msg['host'] || "127.0.0.1"
        const port = msg['port'] || 11212
        connectWebsocket(`ws://${host}:${port}/?token=${"a"}`)
    } else if (msg.action === 'disconnect') {
        disconnectWebsocket()
    } else if (msg.action === 'setproxy') {
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

    } else if (msg.action === 'clearproxy') {
        chrome.proxy.settings.clear({})
    } else if (msg.action === 'proxystatus') {
        chrome.proxy.settings.get({}, function (details) {
            if (details.value && details.value.mode === "fixed_servers") {
                let proxyConfig = details.value.rules.singleProxy;
                chrome.runtime.sendMessage({ enable: true, proxy: `${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}` })
            } else {
                chrome.runtime.sendMessage({ enable: false, proxy: "" })
            }
        });
    }
})
