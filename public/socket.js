export const ActionType = {
    CONNECT: 'connect',
    SEND_MESSAGE: 'send_message',
    DISCONNECT: 'disconnect',
    STATUS: 'status',
    PROXY_STATUS: 'proxy_status',
    SET_PROXY: 'set_proxy',
    CLEAR_PROXY: 'clear_proxy',
    INJECT_SCRIPT: 'yakit_inject_script',
    TO_EXTENSION_PAGE: "yakit_to_extension_page",
}

export class WebSocketManager {
    constructor() {
        this.socket = null;
        this.intervalId = null;
    }

    connectWebsocket(url, port) {
        this.disconnectWebsocket();
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            chrome.runtime.sendMessage({action: ActionType.STATUS, connected: true, port: port});
            this.startHeartbeat();
        };

        this.socket.onmessage = (event) => {
            console.log("event", event)
            this.handleMessage(event.data);
        };

        this.socket.onclose = () => {
            chrome.runtime.sendMessage({action: ActionType.STATUS, connected: false});
        };

        this.socket.onerror = (error) => {
            console.error("WebSocket Error:", error);
        };
    }

    sendMessage(message) {
        if (this.isConnected()) {
            try {
                this.socket.send(JSON.stringify(message));
            } catch (e) {
                console.error("Error sending message:", e);
            }
        } else {
            console.error("WebSocket is not connected.");
        }
    }

    disconnectWebsocket() {
        if (this.socket) {
            try {
                this.socket.close();
                chrome.runtime.sendMessage({action: ActionType.STATUS, connected: false});
            } catch (e) {
                console.error("Error closing websocket:", e);
            }
            this.socket = null;
            this.stopHeartbeat();
        }
    }

    startHeartbeat() {
        this.intervalId = setInterval(() => this.heartbeat(), 3000);
    }

    stopHeartbeat() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    heartbeat() {
        if (this.isConnected()) {
            try {
                this.socket.send(JSON.stringify({"type": "heartbeat"}));
            } catch (e) {
                console.error("Error sending heartbeat:", e);
            }
        } else {
            this.disconnectWebsocket();
        }
    }

    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    async handleMessage(message) {
        console.log("message", message)
        message = JSON.parse(message);
        if (message && message.type === "eval") {
            console.log("msg ", message)
            const code = message.code;
            // try {
            //     const [tab] = await getTab();
            //     chrome.runtime.sendMessage({
            //         action: ActionType.INJECT_SCRIPT, tabId: tab.id, value: {
            //             mode: "CONTENT_EVAL_CODE", code: code,
            //         },
            //     });
            // } catch (error) {
            //     console.log(error.toString())
            // }
            try {
                const [tab] = await getTab();
                // 注入 JS 脚本
                await chrome.scripting.executeScript({
                    target: {tabId: tab.id},
                    files: ['content.js']
                });

                // 发送消息
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: ActionType.INJECT_SCRIPT,
                    value: {
                        mode: "CONTENT_EVAL_CODE", code: code,
                    }
                });

                console.log("response", response);
                if (response && response.action === ActionType.TO_EXTENSION_PAGE) {
                    await chrome.runtime.sendMessage(response);
                }
            } catch (err) {
                console.error('Script or CSS injection failed:', err);
            }
        }
    }
}

function getTab() {
    return chrome.tabs.query({active: true, lastFocusedWindow: true})
}