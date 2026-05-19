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

  // ─── 放送終了検出（リダイレクト方式）─────────────────────
  // FC2 ライブは終了済み・存在しない放送 ID では error.fc2.com/livechat/... へ
  // リダイレクトされる。サブ iframe のロード完了時点で location が
  // live.fc2.com/<id>/ パターンから離れていれば終了とみなし、content.js へ通知する。
  // ※ frame-content.js の matches は live.fc2.com のみなので、リダイレクト先で
  //    このスクリプトが再実行されることは無い。ロード前にここで一度だけ確認すれば足りる。
  const FC2_LIVE_RE = /^https?:\/\/live\.fc2\.com\/\d+\/?/i;

  try {
    const _notifyEnded = function () {
      if (FC2_LIVE_RE.test(location.href)) return;
      chrome.runtime
        .sendMessage({ type: 'nmv2-sub-ended', url: location.href })
        .catch(() => {});
    };

    // ロード完了時に判定（リダイレクト後の最終 URL が確定するのを待つ）
    window.addEventListener('load', _notifyEnded, { once: true });
  } catch (_) {}
}
