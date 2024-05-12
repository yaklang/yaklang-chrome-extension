export const ActionType = {
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
    STATUS: 'status',
    PROXYSTATUS: 'proxystatus',
    SETPROXY: 'setproxy',
    CLEARPROXY: 'clearproxy',
    EVAL: 'eval',
    ECHO: 'echo',
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
        // 解析消息
        // try {
        //     // 解析从WebSocket接收到的JSON数据
        //     let code = message;
        //     getTabId().then((tabId) => {
        //         // 确保tabId和code有效
        //         if (typeof tabId === 'number' && typeof code === 'string') {
        //             chrome.webNavigation.getAllFrames({tabId: tabId}, function(frames) {
        //                 for (let frame of frames) {
        //                     console.log(`Frame ID: ${frame.frameId} with URL: ${frame.url}`);
        //                 }
        //             });
        //             // 在指定的tabId上执行脚本
        //             chrome.scripting.executeScript({
        //                 target: {tabId: tabId},
        //                 // function: getTitle,
        //                 function: log,
        //                 args: [code]
        //             }, (injectionResults) => {
        //                 // 处理脚本执行的结果，如日志记录等
        //                 console.log('Script executed:', injectionResults);
        //             });
        //         } else {
        //             console.error('Received malformed message:', message);
        //         }
        //     });
        // } catch (err) {
        //     console.error('Error parsing message from WebSocket:', err);
        // }
    }
}

function getTitle() {
    return document.title;
}

function log(message) {
    return console.log(message);
}

export const getTabId = () => {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({active: true, lastFocusedWindow: true}, (tabs) => {
            if (tabs.length) {
                resolve(tabs[0].id);
            } else {
                reject('No active tab found');
            }
        });
    });
}

// chrome.tabs.query({}, (tabs) => {
//     tabs.forEach(function (tab) {
//         console.log(tab.id); // 输出每个标签页的ID
//     });
// })