function injectScript(src, id, message) {
    return new Promise((resolve) => {
        // Inject a script tag into the page to access methods of the window object
        const script = document.createElement('script')

        script.onload = () => {
            const onMessage = ({data}) => {
                console.log(data)
                if (!data.yakitex || !data.yakitex.msg) {
                    return
                }

                window.removeEventListener('message', onMessage)

                resolve(data.yakitex.msg)

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

chrome.runtime.onConnect.addListener(function (port) {
    console.assert(port.name === "ex-to-content");
    port.onMessage.addListener(function (msg) {
        injectScript('content.js', 'sender', {yakitex: "123", id: "yakit", msg: msg}).then((res) => {
            window.addEventListener("message", (event) => {
                // if (event.source !== window) {
                //     return;
                // }
                if (event.data.type && (event.data.type === "FROM_PAGE")) {
                    console.log(event)
                    const port2 = chrome.runtime.connect({name: "content-to-ex"});
                    port2.postMessage(event.data.text);
                    port2.disconnect();
                }
            },);

        })
    });

    port.onDisconnect.addListener(function () {
        console.error("[ex-to-content] Disconnected from port.");
    });
});