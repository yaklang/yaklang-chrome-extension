let socket;
const connectWebsocket = url => {
    disconnectWebsocket()
    socket = new WebSocket(url);
    socket.onopen = () => {
        chrome.runtime.sendMessage({status: "connected"})
    }
    socket.onclose = () => {
        chrome.runtime.sendMessage({status: "disconnected"})
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

let proxyHost = "";

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === "connect") {
        console.info("Start to connect websocket")
        const host = msg['host'] || "127.0.0.1"
        const port = msg['port'] || 11212
        connectWebsocket(`ws://${host}:${port}/?token=${"a"}`)
    } else if (msg.action === 'disconnect') {
        disconnectWebsocket()
    } else if (msg.action === "status") {
        if (socket) {
            chrome.runtime.sendMessage({connected: true})
        } else {
            chrome.runtime.sendMessage({connected: false})
        }
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
        proxyHost = `${msg.scheme}://${msg.host}:${msg.port}`
    } else if (msg.action === 'clearproxy') {
        chrome.proxy.settings.clear({})
        proxyHost = ""
    } else if (msg.action === 'proxystatus') {
        if (proxyHost !== '') {
            chrome.runtime.sendMessage({enable: !!proxyHost, proxy: proxyHost})
        } else {
            chrome.runtime.sendMessage({enable: false, proxy: ""})
        }
    }
})
