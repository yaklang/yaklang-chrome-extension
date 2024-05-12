/**
 * injectScript - Inject internal script to available access to the `window`
 *
 * @param  {type} file_path Local path of the internal script.
 * @param  {type} tag The tag as string, where the script will be append (default: 'body').
 * @see    {@link http://stackoverflow.com/questions/20499994/access-window-variable-from-content-script}
 */
function injectScript(file_path, tag) {
    const node = document.getElementsByTagName(tag)[0];
    if (!node) {
        console.error('The "' + tag + '" tag is not available in the document.');
        return;
    }
    // 移除之前的脚本
    const oldScript = document.getElementById('yakit-injected-script');
    if (oldScript) {
        node.removeChild(oldScript);
    }
    const script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', file_path);
    script.setAttribute('id', 'yakit-injected-script');

    node.appendChild(script);
}

// document.addEventListener('DOMContentLoaded', function () {
injectScript(chrome.runtime.getURL('content.js'), 'body');

const port = chrome.runtime.connect({name: "content-script"});

port.onDisconnect.addListener(function () {
    console.error("Disconnected from port.");
});

port.onMessage.addListener(function (msg) {
    console.log("我听到了成功的回响 :", msg);
    window.postMessage(msg, "*")
});

window.addEventListener("message", (event) => {
    // We only accept messages from ourselves
    if (event.source !== window) {
        return;
    }
    if (event.data.type && (event.data.type === "FROM_PAGE")) {
        console.log(event)
        console.log("Content script received: " + event.data.text);
        if (port && port.postMessage) {
            port.postMessage(event.data.text);
        }
    }
}, );
// });