(() => {
    if (window.injectedMessageListener) {
        return;
    }
    window.injectedMessageListener = true;

    window.addEventListener('message', function onMessage(event) {
        if (event.source !== window) {
            return;
        }
        let result
        switch (event.data.type) {
            case 'CONTENT_CALL_FUNCTION':
                const fn_name = event.data.value.fn_name;
                const args = event.data.value.args;
                result = window[fn_name](args);
                window.postMessage({type: 'FROM_INJECT_JS', result: result}, '*');
                break;
            case 'CONTENT_EVAL_CODE':
                const code = event.data.value.code;
                result = (() => {
                    try {
                        return eval(code);
                    } catch (e) {
                        // console.error("Error evaluating code:", e);
                        return e.toString();
                    }
                })();
                // console.log("CONTENT_EVAL_CODE result: ", result);
                window.postMessage({type: 'FROM_INJECT_JS', result: result}, '*');
                break;
            default:
                break;
        }
    });
})();

