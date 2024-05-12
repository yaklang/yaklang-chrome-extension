document.addEventListener('DOMContentLoaded', function () {
    const button = document.getElementById('btn');
    button.addEventListener('click', clickHandler);
});

function clickHandler() {
    const iframe = document.getElementById('sandbox');
    iframe.contentWindow.postMessage( "22 * 33", '*');

    function listener(event) {
        // 这里处理从 iframe 发送回来的数据
        console.log('Received message:', event.data);
    }


    window.addEventListener('message', listener, {once: true});

}