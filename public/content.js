(() => {
    if (window.contentScriptInjected) {
        return;
    }
    window.contentScriptInjected = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'yakit_inject_script') {
            const injectedScriptURL = chrome.runtime.getURL('inject.js');
            const script = document.createElement('script');
            script.src = injectedScriptURL;
            script.onload = () => {
                window.postMessage({type: request.value.mode, value: request.value}, '*');
                script.remove();
            };
            (document.head || document.documentElement).appendChild(script);
            window.addEventListener('message', function onMessage(event) {
                if (event.source !== window || event.data.type !== 'FROM_PAGE') {
                    return;
                }
                window.removeEventListener('message', onMessage);
                // Send the result to the background script
                // chrome.runtime.sendMessage({ action: 'yakit_to_extension_page', result: event.data.result });
                // 直接向向发送端返回结果
                sendResponse({action: 'yakit_to_extension_page', result: event.data.result});
            });
            return true;
        }
    });
})()

