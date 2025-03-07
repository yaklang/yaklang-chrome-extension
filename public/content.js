(() => {
    if (window.contentScriptInjected) {
        return;
    }
    window.contentScriptInjected = true;
    window.badgeCount = 0;
    // 检查并插入 CSS 样式
    const styleId = 'injected-css-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            body {
                border: 3px solid red;
                position: relative; /* Ensure the body is positioned to allow the pseudo-element */
            }
            body::after {
                content: "Injection successful";
                display: block;
                position: fixed;
                top: 10px;
                right: 10px;
                background: green;
                color: white;
                padding: 5px 10px;
                font-size: 16px;
                z-index: 1000;
            }
        `;
        document.head.appendChild(style);
    }
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
            window.addEventListener('message', async function onMessage(event) {
                if (event.source !== window || event.data.type !== 'FROM_INJECT_JS') {
                    return;
                }
                window.removeEventListener('message', onMessage);
                window.badgeCount += 1;
                // 直接向向发送端返回结果
                sendResponse({action: 'yakit_to_extension_page', result: event.data.result});
                // Send updated badge count to background script
                await chrome.runtime.sendMessage({action: 'yakit_badge', data: window.badgeCount.toString()});
            });
            return true;
        }
    });


})()

