export enum ActionType {
    CONNECT = 'connect',
    DISCONNECT = 'disconnect',
    STATUS = 'status',
    PROXY_STATUS = 'proxy_status',
    SET_PROXY = 'set_proxy',
    CLEAR_PROXY = 'clear_proxy',
    INJECT_SCRIPT = 'yakit_inject_script',
    TO_EXTENSION_PAGE = "yakit_to_extension_page",
}

export namespace wsc {
    export function connect(port: number, host?: string) {
        chrome.runtime.sendMessage({
            action: ActionType.CONNECT,
            host: host || '127.0.0.1',
            port: port,
        });
    }

    export function disconnect() {
        chrome.runtime.sendMessage({
            action: ActionType.DISCONNECT,
        });
    }

    export function updateWSCStatus() {
        chrome.runtime.sendMessage({
            action: ActionType.STATUS,
        });
    }

    export function updateProxyStatus() {
        chrome.runtime.sendMessage({
            action: ActionType.PROXY_STATUS,
        });
    }

    export function onWSCMessage(onMessage: (message: any) => void) {
        chrome.runtime.onMessage.addListener(onMessage);
    }

    export function onProxyStatusMessage(onMessage: (message: { enable: boolean, proxy: string }) => any) {
        chrome.runtime.onMessage.addListener(onMessage)
    }

    export function setproxy(scheme: string, host: string, port: number) {
        chrome.runtime.sendMessage({action: ActionType.SET_PROXY, scheme, host, port})
    }

    export function clearproxy() {
        chrome.runtime.sendMessage({action: ActionType.CLEAR_PROXY})
    }

    export function getTabId() {
        return new Promise<number>((resolve, reject) => {
            chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
                if (tabs.length) {
                    resolve(tabs[0].id);
                } else {
                    reject('No active tab found');
                }
            });
        });
    }
}
