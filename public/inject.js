function injectScript(src, id, message) {
    return new Promise((resolve) => {
        // Inject a script tag into the page to access methods of the window object
        const script = document.createElement('script')

        script.onload = () => {
            const onMessage = ({ data }) => {
                console.log(data)
                if (!data.yakitex || !data.yakitex.msg) {
                    return
                }

                window.removeEventListener('message', onMessage)

                // resolve(data.yakitex.msg)

                script.remove()
            }

            window.addEventListener('message', onMessage)

            window.postMessage({
                yakitex: message,
            })
        }

        script.setAttribute('src', chrome.runtime.getURL(src))

        document.body.appendChild(script)
    })
}

if (!window.hasAddedMessageListener2) {
    window.addEventListener("message", (event) => {
        if (event.data.type && (event.data.type === "FROM_PAGE")) {
            const port = chrome.runtime.connect({ name: "content-to-ex" });
            port.postMessage(event.data.text);
            port.disconnect();
            return
        }
    })
    window.hasAddedMessageListener2 = true;
}


function connectAddListenerFun(port) {
    console.assert(port.name === "ex-to-content");
    if (!port.hasListener) {
        port.onMessage.addListener(function (msg) {
            console.log(111111111111111);
            injectScript('content.js', 'sender', { yakitex: "123", id: "yakit", msg: msg })
        });
    
        port.onDisconnect.addListener(function () {
            console.error("[ex-to-content] Disconnected from port.");
        });
        port.hasListener = true
    }
}

if (!chrome.runtime.onConnect.hasListener(connectAddListenerFun)) {
    chrome.runtime.onConnect.addListener(connectAddListenerFun);
}
