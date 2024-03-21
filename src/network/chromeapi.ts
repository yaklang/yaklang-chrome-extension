export interface MockMessageSender {
    id?: string;
}

export interface MockChromeRuntime {
    sendMessage: (message: any, responseCallback?: (response: any) => void) => void;
    onMessage: {
        addListener: (callback: (message: any, sender: MockMessageSender, sendResponse: (response?: any) => void) => void) => void;
    };
}

export interface MockChromeProxy {
    settings: {
        set: (value: { value: any, scope: string }) => void;
        get: (details: { incognito?: boolean }, callback: (config: any) => void) => void;
    };
}

export interface MockChromeTabs {
    query: (queryInfo: any, callback: (result: any) => void) => void;
    create: (createProperties: any, callback?: (tab: any) => void) => void;
}

export interface MockChrome {
    runtime: MockChromeRuntime;
    proxy: MockChromeProxy;
    tabs: MockChromeTabs;
}

declare global {
    interface Window {
        chrome?: any;
    }
}

export const chrome: MockChrome = typeof window.chrome !== 'undefined' && window.chrome.runtime ? window.chrome : {
    runtime: {
        sendMessage: (message, responseCallback) => {
            console.log('Mock sendMessage called with:', message);
            if (responseCallback) responseCallback('response from mock');
        },
        onMessage: {
            addListener: (callback) => {
                console.log('Mock onMessage.addListener called');
                callback({connected: true}, undefined, undefined)
                // You can simulate incoming messages here if needed
            }
        }
    },
    proxy: {
        settings: {
            set: (value) => {
                console.log('Mock proxy settings set with:', value);
            },
            get: (details, callback) => {
                console.log('Mock proxy settings get called');
                // Simulate proxy settings response
                callback({mode: 'direct'});
            }
        }
    },
    tabs: {
        query: (queryInfo, callback) => {
            console.log('Mock tabs.query called with:', queryInfo);
            // Simulate a tab query response
            callback([{id: 1, url: 'http://example.com', title: 'Example'}]);
        },
        create: (createProperties, callback) => {
            console.log('Mock tabs.create called with:', createProperties);
            // Simulate creating a tab
            if (callback) callback({id: 2, url: createProperties.url});
        }
    }
};