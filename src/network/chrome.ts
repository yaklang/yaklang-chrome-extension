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

    export function updateWSCStatus() {
        chrome.runtime.sendMessage({
            action: 'status',
        });
    }

    export function updateProxyStatus() {
        chrome.runtime.sendMessage({
            action: 'proxystatus',
        });
    }

    export function onWSCMessage(onMessage: (message: any) => void) {
        chrome.runtime.onMessage.addListener(onMessage);
    }

    export function onProxyStatusMessage(onMessage: (message: { enable: boolean, proxy: string }) => any) {
        chrome.runtime.onMessage.addListener(onMessage)
    }

    export function setproxy(scheme: string, host: string, port: number) {
        chrome.runtime.sendMessage({action: "setproxy", scheme, host, port})
    }

    export function clearproxy() {
        chrome.runtime.sendMessage({action: 'clearproxy'})
    }


}
