export const ActionType = {
    CONNECT: 'connect',
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
            this.handleMessage(event.data);
        };

        this.socket.onclose = () => {
            chrome.runtime.sendMessage({action: ActionType.STATUS, connected: false});
        };

        this.socket.onerror = (error) => {
            console.error("WebSocket Error:", error);
        };
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

    handleMessage(message) {
        console.log("message", message)
    }
}