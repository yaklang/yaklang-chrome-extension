export const ActionType = {
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
    STATUS: 'status',
    PROXYSTATUS: 'proxystatus',
    SETPROXY: 'setproxy',
    CLEARPROXY: 'clearproxy'
}

export class WebSocketManager {
    constructor() {
        this.socket = null;
        this.intervalId = null;
    }

    connectWebsocket(url) {
        this.disconnectWebsocket();
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            chrome.runtime.sendMessage({action: ActionType.STATUS, connected: true});
            this.startHeartbeat();
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
}