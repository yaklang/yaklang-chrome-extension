(() => {
    if (window.injectedMessageListener) {
        return;
    }
    window.injectedMessageListener = true;

    window.addEventListener('message', function onMessage(event) {
        if (event.source !== window) {
            return;
        }
        let result = "";
        switch (event.data.type) {
            case 'CONTENT_CALL_FUNCTION':
                const fn_name = event.data.value.fn_name;
                const args = event.data.value.args;
                result = window[fn_name](args);
                break;
            case 'CONTENT_EVAL_CODE':
                const code = event.data.value.code;
                result = eval(code);
                // console.log("CONTENT_EVAL_CODE result: ", result);
                break;
            default:
                break;
        }
        if (result && typeof result === 'object' && Object.keys(result).length > 0) {
            window.postMessage({type: 'FROM_PAGE', result: result}, '*');
        }
    });
})();

