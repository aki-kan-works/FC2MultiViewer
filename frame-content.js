if (window !== window.top) {
  try {
    // DOM属性でサブフレームであることをページスクリプト(frame-patch.js)に伝える。
    // コンテンツスクリプトは隔離ワールドのため window 変数では伝達できない。
    document.documentElement.setAttribute('data-nmv2-sub', '1');
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('frame-patch.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { s.remove(); };
  } catch (_) {}

  // content.js からの postMessage をページワールドへ CustomEvent で中継する。
  // (コンテンツスクリプトから直接ページ関数は呼べないため)
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'nmv2-mute' && typeof e.data.muted === 'boolean') {
      try {
        document.dispatchEvent(
          new CustomEvent('nmv2-set-mute', { detail: { muted: e.data.muted } })
        );
      } catch (_) {}
    }
  });
}
