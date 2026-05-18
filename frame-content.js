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

  // ─── 放送終了ガイド要素の監視 ───────────────────────────────
  // iframe 内の DOM を直接監視し、終了要素が出現したら background 経由で
  // content.js に通知する。クラス名の部分一致で検索（CSS Modules ハッシュに対応）。
  try {
    let _endNotified = false;

    const _notifyEnded = function () {
      if (_endNotified) return;
      if (
        document.querySelector('[class*="program-end-guide"]') ||
        document.querySelector('[class*="watch-rejected-information"]')
      ) {
        _endNotified = true;
        chrome.runtime.sendMessage({ type: 'nmv2-sub-ended', url: location.href }).catch(() => {});
      }
    };

    // document_start 時点で documentElement は存在するので MO を即時設定。
    // React による動的レンダリングで追加される要素を捕捉する。
    const _endGuideMO = new MutationObserver(_notifyEnded);
    _endGuideMO.observe(document.documentElement, { childList: true, subtree: true });

    // ページロード完了時にも念のため確認（既に終了済みの放送を追加した場合）
    window.addEventListener('load', _notifyEnded, { once: true });
  } catch (_) {}
}
