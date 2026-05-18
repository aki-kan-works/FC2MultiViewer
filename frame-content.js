if (window !== window.top) {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('frame-patch.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { s.remove(); };
  } catch (_) {}
}
