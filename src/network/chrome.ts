import {chrome} from "./chromeapi";

export namespace wsc {
    export function connect(port: number, host?: string) {
        chrome.runtime.sendMessage({
            action: 'connect',
            host: host || '127.0.0.1',
            port: port,
        });
    }

    export function disconnect() {
        chrome.runtime.sendMessage({
            action: 'disconnect',
        });
    }

    export function getStatus() {
        chrome.runtime.sendMessage({
            action: 'status',
        });
    }

    export function listen(onMessage: (message: any) => void) {
        chrome.runtime.onMessage.addListener(onMessage);
    }
}
