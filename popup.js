document.getElementById('connectBtn').addEventListener('click', () => {
    let wsUrl = document.getElementById('wsUrl').value;
    if (!wsUrl) {
        wsUrl = 'ws://127.0.0.1:8881/?token=a'
    }
    const msg = {
        action: "connectWebsocket", url: wsUrl,
    };
    chrome.runtime.sendMessage(msg)
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    document.getElementById("wsStatus").innerText = msg.status;
});