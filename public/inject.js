(() => {
  if (window.injectedMessageListener) {
    return;
  }
  window.injectedMessageListener = true;

  window.addEventListener('message', function onMessage(event) {
    if (event.source !== window || event.data.type !== 'CALL_FUNCTION') {
      return;
    }

    const value = event.data.value;
    const result = window[value.fn_name](value.args);
    window.postMessage({ type: 'FROM_PAGE', result: result }, '*');
  });
})();

