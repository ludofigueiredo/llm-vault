(function () {
  const MESSAGE_SOURCE = 'claude-exporter';
  let armed = false;
  let originalCreateObjectURL = null;

  function installHook() {
    if (originalCreateObjectURL) return;
    originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      const result = originalCreateObjectURL(blob);
      if (armed && blob instanceof Blob) {
        armed = false;
        blob.arrayBuffer().then((buffer) => {
          window.postMessage({ source: MESSAGE_SOURCE, type: 'BLOB_CAPTURED', buffer }, '*');
        }).catch(() => {
          window.postMessage({ source: MESSAGE_SOURCE, type: 'BLOB_CAPTURE_FAILED' }, '*');
        });
      }
      return result;
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE) return;

    if (data.type === 'ARM_CAPTURE') {
      installHook();
      armed = true;
    } else if (data.type === 'DISARM_CAPTURE') {
      armed = false;
    }
  });
})();
