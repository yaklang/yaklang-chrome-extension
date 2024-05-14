(() => {
    if (window.contentScriptInjected) {
        return;
    }
    window.contentScriptInjected = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'INJECT_CODE') {
            const injectedScriptURL = chrome.runtime.getURL('inject.js');
            const script = document.createElement('script');
            script.src = injectedScriptURL;
            script.onload = () => {
                window.postMessage({ type: 'CALL_FUNCTION', value: request.value }, '*');
                script.remove();
            };
            (document.head || document.documentElement).appendChild(script);
            window.addEventListener('message', function onMessage(event) {
                if (event.source !== window || event.data.type !== 'FROM_PAGE') {
                    return;
                }
                window.removeEventListener('message', onMessage);
                // Send the result to the background script
                chrome.runtime.sendMessage({ action: 'SEND_RES_FROM_PAGE', result: event.data.result });
                sendResponse({ result: event.data.result });
            });
            // Return true to indicate that the response will be sent asynchronously
            return true;
        }
    });
})()

