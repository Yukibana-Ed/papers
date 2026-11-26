// Keeps the messages that arrive before the frame's code runs (the app's hello); src/lib/frame/bridge.ts reads them.
window.__ykEarly = [];
window.addEventListener('message', function keep(e) {
    if (window.__ykEarly) window.__ykEarly.push(e);
    else window.removeEventListener('message', keep);
});
