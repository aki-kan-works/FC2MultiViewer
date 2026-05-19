(function () {
  'use strict';

  const MAX_SUBS = 4;
  const FC2_LIVE_RE = /^https?:\/\/live\.fc2\.com\/\d+\/?/i;

  function _extractFc2Id(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^https?:\/\/live\.fc2\.com\/(\d+)/i);
    return m ? m[1] : null;
  }

  // ウィンドウ幅に連動するスロット寸法（リサイズ時に更新）
  let SLOT_W = 320;
  let SLOT_H = 180;
  let BAR_H  = 192;

  function updateSlotDims() {
    // バー padding(8px×2=16) + gap(6px×3=18) を引いて 4 等分
    SLOT_W = Math.floor((window.innerWidth - 34) / 4);
    SLOT_H = Math.round(SLOT_W * 9 / 16);
    BAR_H  = SLOT_H + 12;
    // --nmv2-bar-h の更新は applyBarVisibility() に集約（バー非表示時は 0 にしたいため）
  }

  // ─── 状態 ───────────────────────────────────────────────
  const liveUrl = location.href;
  let mainSrc   = 'live';
  let subUrls   = [];
  let tabId     = null;
  let stateKey  = null;

  // url -> { iframe, canvas, rafId, meta, audioObserver }
  const subData = new Map();

  // メインエリア canvas およびホバーで表示されるコントロールバー（サブ昇格時のみ存在）
  let mainCanvas       = null;
  let edgeBlurEl       = null;   // mainCanvas のふち暗化オーバーレイ（浮き感を緩和）
  let _mainEndedBadge  = null;   // 昇格中サブが放送終了したときに mainCanvas 左上に表示するバッジ

  // ─── 統合 RAF ループ（メイン60fps + 全サブ24fps を 1 本に統合）──
  let _globalRafId       = 0;     // 0 のとき停止中
  let _drawMainPending   = false; // メイン canvas が描画対象か
  let _mainCanvasSrc     = null;  // メイン canvas が現在描画しているサブ URL
  let _mainCanvasCtx     = null;  // メイン canvas の 2d context（getContext を毎フレーム呼ばない）
  let _mainOffscreen     = null;  // ダブルバッファ用オフスクリーン canvas
  let _mainOffscreenCtx  = null;  // 同 context
  const SUB_FRAME_INTERVAL = 1000 / 24; // サブは 24fps 上限
  let controlsBar      = null;   // ホバー時に下端に表示されるコントロール領域
  let muteBtn          = null;   // ミュート切替アイコン
  let volumeSlider     = null;   // 音量スライダー
  let commentToggleBtn = null;   // 右側エリア（コメント等）表示切替アイコン
  let navBtn           = null;   // 「この放送に移動する」アイコン
  let _hideControlsTimer = null; // コントロールバー自動非表示タイマー
  let _sideHidden      = false;  // 右側エリアの非表示状態
  let _liveUrlSideHidden = false; // 本放送（liveUrl）が降格する前の最大化状態を保存し、再昇格時に復元
  let _commentLayerHidden = false; // スワップ映像のコメントレイヤー非表示状態

  // すりガラスオーバーレイ（サブ昇格時のみ存在）
  let frostEl = null;

  // ネイティブ全画面（document.fullscreenElement とは別系統の独自全画面フラグ）。
  // FC2 では常に false（ニコ生固有の data-player-layout-mode 監視は廃止）。
  let _nmv2Fullscreen = false;

  // 強制全画面モード（pseudo-fullscreen）関連
  // body にクラスを付与し、CSS で #js-livePlayerContainer をビューポート最大化する。
  let barVisibility   = 'hidden';   // 'hidden' | 'preview' | 'pinned'
  let _pseudoFullscreen = false;
  let _dragLeaveTimer = null;

  // オーバーレイ要素（canvas/frost等）の正しい親要素を返す
  // ネイティブ全画面中はフルスクリーン要素へ、それ以外は document.body へ
  // (documentElement に置くと body が独自 stacking context を持つ場合に body 背面に隠れるため)
  function getOverlayParent() {
    const fs = document.fullscreenElement;
    if (fs && fs !== document.documentElement && fs !== document.body) return fs;
    return document.body || document.documentElement;
  }

  // カスタム全画面・ネイティブ全画面・疑似全画面のいずれかで true（position:fixed 判定用）
  function isOverlayFixed() {
    return _nmv2Fullscreen || !!document.fullscreenElement || _pseudoFullscreen;
  }

  // ─── ユーティリティ ─────────────────────────────────────
  function isFc2LiveUrl(s) {
    return typeof s === 'string' && FC2_LIVE_RE.test(s.trim());
  }

  function extractUrlFromDataTransfer(dt) {
    if (!dt) return '';
    for (const type of ['text/uri-list', 'text/plain', 'URL']) {
      const raw = dt.getData(type);
      if (!raw) continue;
      for (const line of raw.split(/\r?\n/).map(s => s.trim())) {
        if (line && !line.startsWith('#') && isFc2LiveUrl(line)) return line;
      }
    }
    return '';
  }

  // ─── セッション保存 ──────────────────────────────────────
  async function persistState() {
    if (!stateKey) return;
    const subs = subUrls.filter(u => u !== liveUrl);
    try {
      await chrome.storage.session.set({ [stateKey]: { subs } });
    } catch (_) {}
  }

  // ─── video / プレイヤー要素キャッシュ ───────────────────
  // RAF 内・リサイズ時など高頻度パスでの querySelector を排除する。
  // 値が disconnect されたら次回呼び出し時に再取得する。
  let _mainVideoEl    = null;
  let _cachedFc2Player = null;

  // FC2 ライブの再生 video は .js-webrtcVideo 配下の blob: ソース付き要素。
  // 同クラスのコンテナが複数（プレロード等で）あるため、src と videoWidth で
  // 実再生中のものを優先選択する。
  function _pickFc2Video(doc) {
    if (!doc) return null;
    let candidates;
    try { candidates = doc.querySelectorAll('.js-webrtcVideo video'); } catch (_) { return null; }
    if (!candidates || candidates.length === 0) {
      // フォールバック: ドキュメント内の任意の video
      try { return doc.querySelector('video') ?? null; } catch (_) { return null; }
    }
    for (const v of candidates) {
      if (v.src && v.videoWidth > 0) return v;
    }
    for (const v of candidates) {
      if (v.src) return v;
    }
    return candidates[0] ?? null;
  }

  function getVideoEl(url) {
    if (url === liveUrl) {
      if (_mainVideoEl && _mainVideoEl.isConnected && _mainVideoEl.src) return _mainVideoEl;
      _mainVideoEl = _pickFc2Video(document);
      return _mainVideoEl;
    }
    const d = subData.get(url);
    if (!d) return null;
    if (d.videoEl && d.videoEl.isConnected && d.videoEl.src) return d.videoEl;
    try {
      d.videoEl = _pickFc2Video(d.iframe?.contentDocument);
      return d.videoEl;
    } catch (_) { return null; }
  }

  // FC2 のプレイヤーコンテナ。最大化制御等のレイアウト基準として使う。
  function _getFc2Player() {
    if (_cachedFc2Player && _cachedFc2Player.isConnected) return _cachedFc2Player;
    _cachedFc2Player = document.querySelector('#js-livePlayerContainer')
                    || document.querySelector('.livePlayer.js-liveContainer')
                    || document.querySelector('#js-player');
    return _cachedFc2Player;
  }

  // ─── 音量管理 ─────────────────────────────────────────────
  let _volListenerTarget = null;
  let _extMuting = false; // extension によるミュート変更中フラグ（再入防止）
  let _userMuted = false; // プロモートサブのミュート意図（キャンバス上のボタンで制御）

  // サブiframeのAudioContextゲインをpostMessage経由で制御する。
  // frame-content.js がメッセージを受け取り、CustomEventでframe-patch.jsへ中継する。
  function sendSubFrameMute(url, muted) {
    const d = subData.get(url);
    if (!d?.iframe?.contentWindow) return;
    try {
      d.iframe.contentWindow.postMessage({ type: 'nmv2-mute', muted: !!muted }, '*');
    } catch (_) {}
  }

  // 各放送（URL）ごとの独立音量。スワップ後の初期値はメイン video に揃え、
  // 以後はスライダーで個別に変更可。「移動」遷移時に transfer 経由で引き継ぐ。
  const urlVolumes = new Map();           // URL → 音量(0..1)
  let _pendingInitialMainVolume = null;   // 遷移直後に mainVideo へ適用する初期音量

  function syncVolumeToSubs() {
    if (_extMuting) return;
    const mainVideo = getVideoEl(liveUrl);  // S17: querySelector → キャッシュ
    if (!mainVideo) return;

    if (mainSrc === 'live') {
      // ライブモード: FC2 プレイヤー UI 経由の音量変更を liveUrl の独立音量として追跡
      urlVolumes.set(liveUrl, mainVideo.volume);
      return;
    }

    // キャンバスモードでは native player を常にミュート保持（音声はサブiframeから出す）
    if (!mainVideo.muted) {
      _extMuting = true;
      mainVideo.muted = true;
      _extMuting = false;
    }

    // メイン video の音量はサブへ伝播させない（各放送で独立保持）。
    // 代わりに urlVolumes[mainSrc]（スライダーで設定された値）を都度サブへ適用する。
    const vol = urlVolumes.get(mainSrc);
    if (vol == null) return;
    const d = subData.get(mainSrc);
    // S17: d.videoEl キャッシュを利用、audio のみ querySelectorAll
    if (d?.videoEl && d.videoEl.isConnected) {
      try { d.videoEl.volume = vol; } catch (_) {}
    }
    if (d?.iframe) {
      try {
        d.iframe.contentDocument?.querySelectorAll('audio').forEach(el => {
          el.volume = vol;
        });
      } catch (_) {}
    }
  }

  // ネストされた iframe も含めて doc 内の全 audio/video に muted を適用する。
  // syncAudio / applyUserMuted の両方から呼ばれる共通ヘルパー。
  function _applyMuteToDoc(doc, wantMuted) {
    try {
      doc.querySelectorAll('video, audio').forEach(el => {
        if (el.muted !== wantMuted) el.muted = wantMuted;
      });
      doc.querySelectorAll('iframe').forEach(f => {
        try {
          if (f.contentDocument) _applyMuteToDoc(f.contentDocument, wantMuted);
        } catch (_) {}
      });
    } catch (_) {}
  }

  function applyUserMuted() {
    const d = subData.get(mainSrc);
    if (!d) return;
    // S17: d.videoEl キャッシュを利用
    if (d.videoEl && d.videoEl.isConnected) {
      try { d.videoEl.muted = _userMuted; } catch (_) {}
    }
    if (!d.iframe) return;
    try {
      const doc = d.iframe.contentDocument;
      if (doc) _applyMuteToDoc(doc, _userMuted);
    } catch (_) {}
    // AudioContext (Web Audio API) ゲインも制御
    sendSubFrameMute(mainSrc, _userMuted);
  }

  function ensureVolumeListener() {
    const v = getVideoEl(liveUrl);  // S17: querySelector → キャッシュ
    if (!v || v === _volListenerTarget) return;
    if (_volListenerTarget) {
      _volListenerTarget.removeEventListener('volumechange', syncVolumeToSubs);
    }
    v.addEventListener('volumechange', syncVolumeToSubs);
    _volListenerTarget = v;

    // 前ページから引き継いだ初期音量を一度だけ適用
    if (_pendingInitialMainVolume != null) {
      _extMuting = true;
      try { v.volume = _pendingInitialMainVolume; } catch (_) {}
      _extMuting = false;
      urlVolumes.set(liveUrl, _pendingInitialMainVolume);
      _pendingInitialMainVolume = null;
    }
  }

  // ─── ミュート同期 ────────────────────────────────────────
  function syncAudio() {
    ensureVolumeListener();
    _extMuting = true;
    try {
      // S17: メイン video はキャッシュを利用、audio のみ querySelectorAll
      const mainMuted = mainSrc !== 'live';
      if (_mainVideoEl && _mainVideoEl.isConnected) {
        if (_mainVideoEl.muted !== mainMuted) _mainVideoEl.muted = mainMuted;
      }
      document.querySelectorAll('audio').forEach(el => {
        if (el.muted !== mainMuted) el.muted = mainMuted;
      });
      for (const [url, d] of subData) {
        if (!d.iframe) continue;
        const wantMuted = (url !== mainSrc) || _userMuted;
        if (d.videoEl && d.videoEl.isConnected) {
          if (d.videoEl.muted !== wantMuted) d.videoEl.muted = wantMuted;
        }
        try {
          const doc = d.iframe.contentDocument;
          // ネストされた iframe（ギフト・ゲーム音）も含めて再帰的に適用
          if (doc) _applyMuteToDoc(doc, wantMuted);
        } catch (_) {}
        // AudioContext (Web Audio API) ゲインを postMessage 経由で制御
        sendSubFrameMute(url, wantMuted);
      }
    } finally {
      _extMuting = false;
    }
  }

  // ─── サブ音声制御（旧 1500ms ポーリングをイベント駆動化）──
  // FC2 プレイヤーが video 要素を再作成・音量リセットしても、以下で追従する:
  //   - MutationObserver(subtree childList): 新規 <video>/<audio> 出現を捕捉
  //   - 各要素の volumechange リスナー: ページ側の mute/volume 改変を即時是正
  function _applySubAudioPolicy(url, el) {
    if (_extMuting) return;
    try {
      const wantMuted = (url !== mainSrc) || _userMuted;
      if (el.muted !== wantMuted) {
        _extMuting = true;
        el.muted = wantMuted;
        _extMuting = false;
      }
      if (url === mainSrc) {
        const vol = urlVolumes.get(url);
        if (vol != null && Math.abs((el.volume || 0) - vol) > 0.001) {
          _extMuting = true;
          el.volume = vol;
          _extMuting = false;
        }
      }
    } catch (_) {}
  }

  function _trackSubAudioEl(url, el) {
    if (el._nmv2Tracked) return;
    el._nmv2Tracked = true;
    // VIDEO ならキャッシュも更新（getVideoEl から参照される）
    if (el.tagName === 'VIDEO') {
      const d = subData.get(url);
      if (d) {
        d.videoEl = el;
        // video が差し替わった場合も描画ループは既に動いているので、キャッシュ更新のみ
      }
      // 放送終了検出: ended / error を購読
      try {
        el.addEventListener('ended', () => markSubEnded(url));
        el.addEventListener('error', () => markSubEnded(url));
      } catch (_) {}
    }
    _applySubAudioPolicy(url, el);
    try {
      el.addEventListener('volumechange', () => _applySubAudioPolicy(url, el));
    } catch (_) {}
  }

  // ギフト・ゲーム音はサブiframe内のネストされたiframeで再生される場合がある。
  // そのdocumentも再帰的に監視してミュートポリシーを適用する。
  function _trackSubIframe(url, iframeEl) {
    if (iframeEl._nmv2IframeTracked) return;
    iframeEl._nmv2IframeTracked = true;

    const scan = () => {
      try {
        const doc = iframeEl.contentDocument;
        if (!doc || !doc.documentElement) return;
        doc.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
        doc.querySelectorAll('iframe').forEach(f => _trackSubIframe(url, f));
        const mo = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (!n || n.nodeType !== 1) continue;
              const tag = n.tagName;
              if (tag === 'VIDEO' || tag === 'AUDIO') {
                _trackSubAudioEl(url, n);
              } else if (tag === 'IFRAME') {
                _trackSubIframe(url, n);
              } else if (n.querySelectorAll) {
                n.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
                n.querySelectorAll('iframe').forEach(f => _trackSubIframe(url, f));
              }
            }
          }
        });
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        const d = subData.get(url);
        if (d) {
          if (!d.innerFrameObservers) d.innerFrameObservers = [];
          d.innerFrameObservers.push(mo);
        }
      } catch (_) {}
    };

    iframeEl.addEventListener('load', scan);
    scan(); // 既にロード済みの場合も即時スキャン
  }

  // ─── 放送終了マーキング ─────────────────────────────────
  // 検出ソース:
  //   1. video.ended / video.error イベント（_trackSubAudioEl で購読）
  //   2. iframe.contentWindow.location が live.fc2.com/<id>/ から離脱
  //      （存在しない／終了済みは error.fc2.com/livechat/... へリダイレクトされる）
  //      → frame-content.js が検出し chrome.runtime 経由で通知 + ここで補助確認
  // 一度 ended=true になったら撤回しない。

  function _checkEndGuide(url, iframeOrDoc) {
    try {
      // 直接 iframe を受け取った場合は contentWindow.location を確認
      let href = '';
      if (iframeOrDoc && iframeOrDoc.contentWindow) {
        href = iframeOrDoc.contentWindow.location.href || '';
      } else if (iframeOrDoc && iframeOrDoc.URL) {
        href = iframeOrDoc.URL;
      }
      if (!href || href === 'about:blank') return;
      if (!FC2_LIVE_RE.test(href)) {
        markSubEnded(url);
      }
    } catch (_) {
      // クロスオリジン例外（error.fc2.com に飛んだ場合等）= 終了とみなす
      markSubEnded(url);
    }
  }

  function markSubEnded(url) {
    const d = subData.get(url);
    if (!d || d.ended) return;
    d.ended = true;
    // バー上スロットのバッジを表示
    const slot = _slotCache.get(url);
    if (slot) {
      const b = slot.querySelector('.nmv2-ended-badge');
      if (b) b.style.display = 'block';
    }
    // メイン昇格中ならメイン側にもバッジを出す
    if (mainSrc === url) ensureMainEndedBadge();
  }

  function installAudioObserver(url) {
    const d = subData.get(url);
    if (!d || !d.iframe) return;
    if (d.audioObserver) return;

    const setup = () => {
      // 既存 observer があれば破棄（about:blank 上の誤設定を上書きする）
      if (d.audioObserver) { d.audioObserver.disconnect(); d.audioObserver = null; }
      try {
        const doc = d.iframe?.contentDocument;
        if (!doc || !doc.documentElement) return false;
        // 既存の audio/video を 1 回スキャン
        doc.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
        // 既存のネスト iframe もスキャン（ギフト・ゲーム音対応）
        doc.querySelectorAll('iframe').forEach(f => _trackSubIframe(url, f));
        // 既に終了済み・存在しない放送（error.fc2.com 等へのリダイレクト）を初期スキャンで検出
        _checkEndGuide(url, doc);
        // 動的追加を監視
        const mo = new MutationObserver((records) => {
          let mayHaveEndGuide = false;
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (!n || n.nodeType !== 1) continue;
              const tag = n.tagName;
              if (tag === 'VIDEO' || tag === 'AUDIO') {
                _trackSubAudioEl(url, n);
              } else if (tag === 'IFRAME') {
                _trackSubIframe(url, n);
              } else if (n.querySelectorAll) {
                n.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
                n.querySelectorAll('iframe').forEach(f => _trackSubIframe(url, f));
              }
              mayHaveEndGuide = true;
            }
          }
          if (mayHaveEndGuide && !subData.get(url)?.ended) {
            _checkEndGuide(url, doc);
          }
        });
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        d.audioObserver = mo;
        return true;
      } catch (_) { return false; }
    };

    // サブ iframe: 必ず load 後に設定する。
    // 初期 about:blank ドキュメントを誤スキャンし、その documentElement を
    // 観測し続けるバグを防ぐ（installCanvasObserver と同じ問題）。
    d.iframe.addEventListener('load', setup, { once: true });
  }

  function uninstallAudioObserver(url) {
    const d = subData.get(url);
    if (!d) return;
    if (d.audioObserver) { d.audioObserver.disconnect(); d.audioObserver = null; }
    if (d.innerFrameObservers) {
      d.innerFrameObservers.forEach(mo => mo.disconnect());
      d.innerFrameObservers = null;
    }
    if (d.endGuideObserver) { d.endGuideObserver.disconnect(); d.endGuideObserver = null; }
  }

  // ─── 放送終了監視（リダイレクト対応）────────────────────
  // installAudioObserver は { once: true } で初回ロード時のみ setup を実行する。
  // FC2 ライブは放送終了時に error.fc2.com 系へリダイレクトする場合があり、
  // この関数は load イベントを持続的に監視し、遷移先 URL を検査して終了を検出する。
  function installEndGuideObserver(url) {
    const d = subData.get(url);
    if (!d || !d.iframe || d._endGuideObserverInstalled) return;
    d._endGuideObserverInstalled = true;

    const onLoad = () => {
      if (subData.get(url)?.ended) return;
      if (d.endGuideObserver) { d.endGuideObserver.disconnect(); d.endGuideObserver = null; }
      // まず iframe レベルでリダイレクト先 URL を確認する。
      // クロスオリジン遷移（error.fc2.com 等）では contentDocument が null になるため、
      // 直接 contentWindow.location を参照する _checkEndGuide にハンドリングを任せる。
      _checkEndGuide(url, d.iframe);
      if (subData.get(url)?.ended) return;
      try {
        const doc = d.iframe?.contentDocument;
        if (!doc || !doc.documentElement || doc.URL === 'about:blank') return;
        // 同一オリジン（live.fc2.com）ロード時は DOM 変化も監視（プレイヤー側で
        // 終了 UI が動的に差し込まれるケースの保険）
        const mo = new MutationObserver(() => {
          if (!subData.get(url)?.ended) _checkEndGuide(url, d.iframe);
        });
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        d.endGuideObserver = mo;
      } catch (_) {}
    };

    d.iframe.addEventListener('load', onLoad);
    onLoad();
  }

  // ─── コメント / ギフト canvas キャッシュ ────────────────
  // FC2 ライブはコメント描画 (#js-comment_canvas) とギフト描画 (#js-gift_canvas) を
  // それぞれ固定 ID の canvas に行う。RAF 内ではこの 2 枚だけを合成すれば足りる。
  // 他に setting panel 等で canvas が出現することがあるが、ここでは ID 指定で除外する。
  function _refreshCanvasCache(url, doc) {
    const d = subData.get(url);
    if (!d) return;
    const cs = [];
    try {
      const comment = doc.getElementById('js-comment_canvas');
      const gift    = doc.getElementById('js-gift_canvas');
      if (comment) cs.push(comment);
      if (gift)    cs.push(gift);
    } catch (_) {}
    d.commentCanvases = cs;
  }

  function installCanvasObserver(url) {
    const d = subData.get(url);
    if (!d) return;

    const setup = () => {
      // 既存 observer があれば破棄（about:blank 上の誤設定を上書きする）
      if (d.canvasObserver) { d.canvasObserver.disconnect(); d.canvasObserver = null; }
      try {
        const doc = (url === liveUrl) ? document : (d.iframe?.contentDocument);
        if (!doc || !doc.documentElement) return false;
        _refreshCanvasCache(url, doc);
        const mo = new MutationObserver((records) => {
          // canvas の add/remove が含まれる場合のみ再構築
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'CANVAS' ||
                  (n.querySelector && n.querySelector('canvas'))) {
                _refreshCanvasCache(url, doc);
                return;
              }
            }
            for (const n of r.removedNodes) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'CANVAS' ||
                  (n.querySelector && n.querySelector('canvas'))) {
                _refreshCanvasCache(url, doc);
                return;
              }
            }
          }
        });
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        d.canvasObserver = mo;
        return true;
      } catch (_) { return false; }
    };

    if (url === liveUrl) {
      // メインページは既にロード済みなので即時設定
      setup();
    } else if (d.iframe) {
      // サブ iframe: 必ず load 後に設定する。
      // 初期 about:blank ドキュメントを誤ってスキャンし、そのまま古い
      // documentElement を観測し続けるバグを防ぐ。
      d.iframe.addEventListener('load', setup, { once: true });
    }
  }

  function uninstallCanvasObserver(url) {
    const d = subData.get(url);
    if (!d) return;
    if (d.canvasObserver) { d.canvasObserver.disconnect(); d.canvasObserver = null; }
    d.commentCanvases = null;
  }

  // メイン <video> が React で再作成されても volumechange リスナーを付け直すための監視
  let _mainVidObserver = null;
  let _mainVidScanTimer = 0;
  function setupMainVideoObserver() {
    if (_mainVidObserver) return;
    _mainVidObserver = new MutationObserver((records) => {
      let hit = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO' ||
              (n.querySelector && n.querySelector('video'))) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (!hit) return;
      if (_mainVidScanTimer) return;
      _mainVidScanTimer = setTimeout(() => {
        _mainVidScanTimer = 0;
        ensureVolumeListener();
        // メイン video キャッシュを更新
        _mainVideoEl = _pickFc2Video(document);
        // mainSrc != 'live' のときはネイティブ video を必ずミュート保持
        if (mainSrc !== 'live' && _mainVideoEl && !_mainVideoEl.muted) {
          _extMuting = true;
          _mainVideoEl.muted = true;
          _extMuting = false;
        }
      }, 150);
    });
    _mainVidObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── canvas 描画（統合 RAF）─────────────────────────────
  // 旧: メイン用 mainRafId + 各サブ用 d.rafId = N+1 本の独立 RAF
  // 新: _globalRafId = 1 本の RAF。内部でメイン(60fps) と バー各スロット(24fps) を順次描画。
  function _ensureGlobalRaf() {
    if (_globalRafId) return;
    _globalRafId = requestAnimationFrame(_globalDrawLoop);
  }

  // 映像スナップショットを 24fps で更新する（重い drawImage(video) を抑制）
  function _updateVideoSnapshot(d, url) {
    const v = getVideoEl(url);
    if (!v || v.readyState < 2) return;
    const dw = d.canvas.width, dh = d.canvas.height;
    // スロットサイズが変わった場合は再生成
    if (!d._videoSnap || d._videoSnap.width !== dw || d._videoSnap.height !== dh) {
      d._videoSnap    = document.createElement('canvas');
      d._videoSnap.width  = dw;
      d._videoSnap.height = dh;
      d._videoSnapCtx = d._videoSnap.getContext('2d', { alpha: false });
    }
    d._videoSnapCtx.drawImage(v, 0, 0, dw, dh);
  }

  // スロット描画：映像は snapshot（24fps）、コメントは毎 RAF（60fps）
  function _drawBarSlot(d) {
    if (!d.canvas || !d.canvas.isConnected) { d.draw = false; return; }
    const ctx = d._ctx;
    try {
      // 映像背景：スナップショットが存在するフレームから黒画面を脱する
      if (d._videoSnap) {
        ctx.drawImage(d._videoSnap, 0, 0);
      }
      // コメント：毎 RAF + スムージングで滑らかに縮小描画
      const cs = d.commentCanvases;
      if (cs && cs.length > 0) {
        const dw = d.canvas.width, dh = d.canvas.height;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          if (c.width > 0 && c.height > 0) {
            try { ctx.drawImage(c, 0, 0, dw, dh); } catch (_) {}
          }
        }
        ctx.imageSmoothingEnabled = false;
      }
    } catch (_) {}
  }

  function _drawMainCanvasFrame() {
    const url = _mainCanvasSrc;
    const ctx = _mainCanvasCtx;
    if (!url || !ctx || !mainCanvas?.isConnected) return;

    const cw = mainCanvas.width, ch = mainCanvas.height;

    // ダブルバッファ: オフスクリーン canvas にすべて描いてから main canvas へ 1 回転送。
    // desynchronized:true の main canvas に clearRect→drawImage×2 を直接書くと
    // GPU がステップ途中の状態（黒/コメントなし）を読み取りちらつく。
    if (!_mainOffscreen || _mainOffscreen.width !== cw || _mainOffscreen.height !== ch) {
      _mainOffscreen    = document.createElement('canvas');
      _mainOffscreen.width  = cw;
      _mainOffscreen.height = ch;
      _mainOffscreenCtx = _mainOffscreen.getContext('2d', { alpha: false });
    }
    const offCtx = _mainOffscreenCtx;

    try {
      const dForLoop = subData.get(url);
      const v = getVideoEl(url);
      let dx = 0, dy = 0, dw = cw, dh = ch;

      offCtx.clearRect(0, 0, cw, ch); // レターボックス黒背景

      if (v && v.readyState >= 2) {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (vw > 0 && vh > 0) {
          const scale = Math.min(cw / vw, ch / vh);
          dw = Math.round(vw * scale); dh = Math.round(vh * scale);
          dx = Math.round((cw - dw) / 2); dy = Math.round((ch - dh) / 2);
          offCtx.drawImage(v, dx, dy, dw, dh);
        } else {
          offCtx.drawImage(v, 0, 0, cw, ch);
        }
      }

      let cs = dForLoop?.commentCanvases;
      // キャッシュが空の場合（スワップ直後など）は1回だけ再スキャン
      if ((!cs || cs.length === 0) && dForLoop?.iframe) {
        try {
          const iDoc = dForLoop.iframe.contentDocument;
          if (iDoc) { _refreshCanvasCache(url, iDoc); cs = dForLoop.commentCanvases; }
        } catch (_) {}
      }
      if (cs && cs.length > 0 && !_commentLayerHidden) {
        // コメント canvas（iframe の player サイズ）を video 表示領域に合わせて拡縮描画。
        // スムージング有効でアップスケール時のエッジを滑らかにする。
        offCtx.imageSmoothingEnabled = true;
        offCtx.imageSmoothingQuality = 'medium';
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          if (c.width > 0 && c.height > 0) {
            try { offCtx.drawImage(c, dx, dy, dw, dh); } catch (_) {}
          }
        }
        offCtx.imageSmoothingEnabled = false;
      }
    } catch (_) {}

    // 完成したフレームを 1 回の blit で転送（GPU がフレーム途中を参照しない）
    ctx.drawImage(_mainOffscreen, 0, 0);
  }

  function _globalDrawLoop(now) {
    _globalRafId = 0;
    // メインキャンバス描画（60fps）
    if (_drawMainPending) _drawMainCanvasFrame();
    // バースロット描画（バー可視時のみ）
    // 映像スナップショット更新: 24fps 上限（重い drawImage(video) を抑制）
    // スロット合成（映像 snap + コメント）: 毎 RAF（コメント 60fps 描画）
    let anySubActive = false;
    if (barVisibility !== 'hidden') {
      for (const [url, d] of subData) {
        if (!d.draw) continue;
        if (!d.canvas?.isConnected) { d.draw = false; continue; }
        anySubActive = true;
        if (now - (d.lastDrawTs || 0) >= SUB_FRAME_INTERVAL) {
          d.lastDrawTs = now;
          _updateVideoSnapshot(d, url);
        }
        _drawBarSlot(d);
      }
    } else {
      // hidden: バー描画は完全スキップ。継続判定のため active 判定だけ走らせる。
      for (const d of subData.values()) {
        if (d.draw && d.canvas?.isConnected) { anySubActive = true; break; }
      }
    }
    // 継続: メインが active or バーが可視で active sub がある場合のみ次フレームを要求
    const needNext = _drawMainPending ||
      (barVisibility !== 'hidden' && anySubActive);
    if (needNext) _ensureGlobalRaf();
  }

  function startBarDraw(url) {
    const d = subData.get(url);
    if (!d || !d.canvas) return;
    if (!d._ctx) d._ctx = d.canvas.getContext('2d');
    // 即時起動。_drawBarSlot が readyState < 2 を graceful にスキップするため、
    // video 準備完了を待つ必要はない（待機中は黒画面のまま、準備でき次第描画開始）
    d.draw = true;
    d.lastDrawTs = 0;
    _ensureGlobalRaf();
  }

  function stopBarDraw(url) {
    const d = subData.get(url);
    if (!d) return;
    d.draw = false;
  }

  // ─── メインcanvas（サブ昇格時）──────────────────────────
  function findMainVideoRect() {
    // pseudo-fs モードでは FC2 プレイヤーコンテナを基準にする。
    // 内部 video の親要素は height:auto 連鎖でコンテナ全高に届かないことが多いため、
    // コンテナの rect から「高さ＝コンテナ全高」「横位置・幅＝パネル状態に応じて切替」
    // を組み立てる。
    if (_pseudoFullscreen) {
      const lp = _getFc2Player();
      if (lp) {
        const lpRect = lp.getBoundingClientRect();
        if (lpRect.width > 0 && lpRect.height > 0) {
          // サイド非表示時: プレイヤーコンテナ全域を使う
          if (_sideHidden) return lpRect;
          // サイド表示時: 横は video 要素に追従、縦はコンテナ全高に固定
          const v = getVideoEl(liveUrl);
          if (v) {
            const r = v.getBoundingClientRect();
            if (r.width > 0) {
              return new DOMRect(r.left, lpRect.top, r.width, lpRect.height);
            }
          }
          return lpRect;
        }
      }
    }
    // 通常モード: メイン video のキャッシュを基準とする
    const v = getVideoEl(liveUrl);
    return v ? v.getBoundingClientRect() : null;
  }

  function updateMuteOverlay() {
    if (!muteBtn) return;
    muteBtn.textContent = _userMuted ? '🔇' : '🔊';
    muteBtn.title = _userMuted ? 'ミュート解除' : 'ミュート';
  }

  // コントロールバーのホバー表示制御
  function _nmv2ShowControls() {
    if (!controlsBar) return;
    if (_hideControlsTimer) { clearTimeout(_hideControlsTimer); _hideControlsTimer = null; }
    controlsBar.style.setProperty('opacity', '1', 'important');
    controlsBar.style.setProperty('pointer-events', 'auto', 'important');
  }

  function _nmv2ScheduleHideControls() {
    if (!controlsBar) return;
    if (_hideControlsTimer) clearTimeout(_hideControlsTimer);
    _hideControlsTimer = setTimeout(() => {
      _hideControlsTimer = null;
      if (!controlsBar) return;
      controlsBar.style.setProperty('opacity', '0', 'important');
      controlsBar.style.setProperty('pointer-events', 'none', 'important');
    }, 600);
  }

  // ─── コントロールバーの組み立て ──────────────────────────
  function _nmv2BuildControlsBar() {
    const bar = document.createElement('div');
    bar.id = 'nmv2-controls';
    bar.style.cssText = [
      'position:absolute',
      'z-index:2147483647',
      'background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,0.75) 100%)',
      'display:flex',
      'align-items:center',
      'padding:0 12px',
      'gap:10px',
      'opacity:0',
      'transition:opacity 200ms ease-out',
      'pointer-events:none',
      'cursor:default',
      'user-select:none',
      'box-sizing:border-box',
    ].map(p => p + '!important').join(';') + ';';
    bar.addEventListener('mouseenter', _nmv2ShowControls);
    bar.addEventListener('mouseleave', _nmv2ScheduleHideControls);

    const iconStyle = [
      'width:32px','height:32px','background:none','border:none',
      'color:#fff','font-size:18px','line-height:1','cursor:pointer','padding:0',
      'display:flex','align-items:center','justify-content:center',
      'flex-shrink:0','border-radius:4px','transition:background 120ms',
    ].map(p => p + '!important').join(';') + ';';

    // ミュート切替
    muteBtn = document.createElement('button');
    muteBtn.id = 'nmv2-mute-btn';
    muteBtn.style.cssText = iconStyle;
    muteBtn.textContent = '🔊';
    muteBtn.addEventListener('mouseenter', () => muteBtn.style.setProperty('background', 'rgba(255,255,255,0.15)', 'important'));
    muteBtn.addEventListener('mouseleave', () => muteBtn.style.setProperty('background', 'none', 'important'));
    muteBtn.addEventListener('click', () => {
      _userMuted = !_userMuted;
      updateMuteOverlay();
      applyUserMuted();
    });

    // 音量スライダー（メイン video と双方向同期）
    volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.step = '1';
    volumeSlider.value = '100';
    volumeSlider.style.cssText = [
      'width:100px','height:4px','cursor:pointer',
      'accent-color:#fff','flex-shrink:0',
    ].map(p => p + '!important').join(';') + ';';
    volumeSlider.addEventListener('input', () => {
      const vol = Math.max(0, Math.min(1, parseInt(volumeSlider.value, 10) / 100));
      // メイン放送ごとに音量を独立保持。mainVideo には書き込まない
      // （書き込むとページ側 UI 表示が乱れたり、本放送に副作用が出るため）
      urlVolumes.set(mainSrc, vol);
      if (mainSrc !== 'live') {
        const d = subData.get(mainSrc);
        if (d?.videoEl && d.videoEl.isConnected) {
          try { d.videoEl.volume = vol; } catch (_) {}
        }
        if (d?.iframe) {
          try {
            d.iframe.contentDocument?.querySelectorAll('audio').forEach(el => {
              el.volume = vol;
            });
          } catch (_) {}
        }
      }
    });

    // 中央スペーサー
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1!important;pointer-events:none!important;';

    // 右側エリア（コメント等）表示切替
    commentToggleBtn = document.createElement('button');
    commentToggleBtn.id = 'nmv2-comment-toggle';
    commentToggleBtn.style.cssText = iconStyle;
    commentToggleBtn.textContent = '💬';
    commentToggleBtn.title = 'コメントを非表示';
    commentToggleBtn.addEventListener('mouseenter', () => commentToggleBtn.style.setProperty('background', 'rgba(255,255,255,0.15)', 'important'));
    commentToggleBtn.addEventListener('mouseleave', () => commentToggleBtn.style.setProperty('background', 'none', 'important'));
    commentToggleBtn.addEventListener('click', () => {
      _commentLayerHidden = !_commentLayerHidden;
      commentToggleBtn.style.setProperty('opacity', _commentLayerHidden ? '0.5' : '1', 'important');
      commentToggleBtn.title = _commentLayerHidden ? 'コメントを表示' : 'コメントを非表示';
    });

    // 「この放送に移動する」アイコン
    navBtn = document.createElement('button');
    navBtn.id = 'nmv2-nav-btn';
    navBtn.style.cssText = iconStyle;
    navBtn.textContent = '⤴';
    navBtn.addEventListener('mouseenter', () => navBtn.style.setProperty('background', 'rgba(255,255,255,0.15)', 'important'));
    navBtn.addEventListener('mouseleave', () => navBtn.style.setProperty('background', 'none', 'important'));
    navBtn.addEventListener('click', navigateToMain);

    bar.appendChild(muteBtn);
    bar.appendChild(volumeSlider);
    bar.appendChild(spacer);
    bar.appendChild(commentToggleBtn);
    bar.appendChild(navBtn);

    return bar;
  }

  // すりガラス越しに後ろの映像が透けて見えるのを防ぐため、canvas を 5px 外側へ広げる
  const MAIN_CANVAS_PAD = 5;
  const CONTROLS_HEIGHT = 48;

  // ─── メイン側「放送終了」バッジ ──────────────────────────
  function ensureMainEndedBadge() {
    if (!mainCanvas) return;
    if (!_mainEndedBadge) {
      _mainEndedBadge = document.createElement('div');
      _mainEndedBadge.id = 'nmv2-main-ended-badge';
      _mainEndedBadge.textContent = '終了';
      _mainEndedBadge.style.cssText = [
        'background:rgba(160,20,20,0.92)',
        'color:#fff',
        'border:1px solid rgba(255,120,120,0.6)',
        'padding:4px 12px',
        'border-radius:5px',
        'font-size:13px',
        'font-weight:bold',
        'letter-spacing:1.5px',
        'pointer-events:none',
        'user-select:none',
      ].map(p => p + '!important').join(';') + ';';
    }
    _placeMainEndedBadge();
  }

  function removeMainEndedBadge() {
    if (_mainEndedBadge) {
      _mainEndedBadge.remove();
      _mainEndedBadge = null;
    }
  }

  function _placeMainEndedBadge() {
    if (!_mainEndedBadge || !mainCanvas) return;
    const pos    = isOverlayFixed() ? 'fixed' : 'absolute';
    const target = getOverlayParent();
    _mainEndedBadge.style.setProperty('position', pos,          'important');
    _mainEndedBadge.style.setProperty('z-index',  '2147483647', 'important');
    if (_mainEndedBadge.parentElement !== target) {
      target.appendChild(_mainEndedBadge);
    }
    // mainCanvas の現在位置に追従させて左上へ
    const ct = parseInt(mainCanvas.style.top,  10) || 0;
    const cl = parseInt(mainCanvas.style.left, 10) || 0;
    _mainEndedBadge.style.setProperty('top',       `${ct + 12}px`, 'important');
    _mainEndedBadge.style.setProperty('left',      `${cl + 12}px`, 'important');
    _mainEndedBadge.style.setProperty('transform', 'none',         'important');
  }

  function repositionMainCanvas() {
    if (!mainCanvas) return;
    const r = findMainVideoRect();
    let ct = 0, cl = 0, cw, ch;

    cw = window.innerWidth;
    ch = Math.max(1, window.innerHeight - (barVisibility !== 'hidden' ? BAR_H : 0));
    if (r && r.width > 0 && r.height > 0) {
      // 全画面（カスタム or ネイティブ）は position:fixed（ビューポート座標）、それ以外は position:absolute（文書座標）
      ct = (isOverlayFixed() ? r.top  : r.top  + window.scrollY) - MAIN_CANVAS_PAD;
      cl = (isOverlayFixed() ? r.left : r.left + window.scrollX) - MAIN_CANVAS_PAD;
      cw = r.width  + MAIN_CANVAS_PAD * 2;
      ch = r.height + MAIN_CANVAS_PAD * 2;
    } else if (!isOverlayFixed()) {
      ct = window.scrollY;
    }

    mainCanvas.style.setProperty('top',    `${ct}px`, 'important');
    mainCanvas.style.setProperty('left',   `${cl}px`, 'important');
    mainCanvas.style.setProperty('width',  `${cw}px`, 'important');
    mainCanvas.style.setProperty('height', `${ch}px`, 'important');
    mainCanvas.width  = Math.round(cw);
    mainCanvas.height = Math.round(ch);

    if (edgeBlurEl) {
      edgeBlurEl.style.setProperty('top',    `${ct}px`, 'important');
      edgeBlurEl.style.setProperty('left',   `${cl}px`, 'important');
      edgeBlurEl.style.setProperty('width',  `${cw}px`, 'important');
      edgeBlurEl.style.setProperty('height', `${ch}px`, 'important');
    }

    // controlsBar はメイン映像の下端に重ねて配置（ホバーで表示）
    if (controlsBar) {
      controlsBar.style.setProperty('top',    `${ct + ch - CONTROLS_HEIGHT}px`, 'important');
      controlsBar.style.setProperty('left',   `${cl}px`,                         'important');
      controlsBar.style.setProperty('width',  `${cw}px`,                         'important');
      controlsBar.style.setProperty('height', `${CONTROLS_HEIGHT}px`,            'important');
    }

    if (_mainEndedBadge) _placeMainEndedBadge();
  }

  function _placeCanvasEls() {
    if (!mainCanvas) return;
    // 全画面（カスタム or ネイティブ）は position:fixed、それ以外は position:absolute（スクロールに追従）
    const pos    = isOverlayFixed() ? 'fixed' : 'absolute';
    const target = getOverlayParent();
    mainCanvas.style.setProperty('position', pos,          'important');
    mainCanvas.style.setProperty('z-index',  '2147483646', 'important');
    if (mainCanvas.parentElement !== target) {
      target.appendChild(mainCanvas);
    }
    if (edgeBlurEl) {
      edgeBlurEl.style.setProperty('position', pos,          'important');
      edgeBlurEl.style.setProperty('z-index',  '2147483646', 'important');
      if (edgeBlurEl.parentElement !== target) {
        target.appendChild(edgeBlurEl);
      }
    }
    if (controlsBar) {
      controlsBar.style.setProperty('position', pos,          'important');
      controlsBar.style.setProperty('z-index',  '2147483647', 'important');
      if (controlsBar.parentElement !== target) {
        target.appendChild(controlsBar);
      }
    }
    if (_mainEndedBadge) _placeMainEndedBadge();
  }

  function showMainCanvas(url) {
    if (!mainCanvas) {
      mainCanvas = document.createElement('canvas');
      mainCanvas.id = 'nmv2-main-canvas';
      mainCanvas.style.cssText = [
        'position:absolute',  // _placeCanvasEls で最大化状態に応じて上書き
        'display:block',
        'z-index:2147483646',
        'pointer-events:auto',  // none にすると裏のプレイヤーにイベントが貫通するため auto
        'cursor:default',
        'background:#000',
        'will-change:transform',  // S14: GPU レイヤー昇格を明示
      ].map(p => p + '!important').join(';') + ';';
      // ホバーでコントロールバーをフェードイン
      mainCanvas.addEventListener('mouseenter', _nmv2ShowControls);
      mainCanvas.addEventListener('mousemove',  _nmv2ShowControls);
      mainCanvas.addEventListener('mouseleave', _nmv2ScheduleHideControls);
    }
    if (!controlsBar) {
      controlsBar = _nmv2BuildControlsBar();
    }
    if (!edgeBlurEl) {
      edgeBlurEl = document.createElement('div');
      edgeBlurEl.id = 'nmv2-edge-blur';
      // S16: box-shadow:inset（CPU ラスタライズ重い）→ radial-gradient（GPU 合成）
      // ほぼ同等のふち暗化を GPU パスで表現する。
      edgeBlurEl.style.cssText = [
        'position:absolute',
        'pointer-events:none',
        'z-index:2147483646',
        'background:radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.45) 100%)',
      ].map(p => p + '!important').join(';') + ';';
    }
    // 「移動する」アイコンのタイトルを現在のメインに合わせて更新
    if (navBtn) {
      const fc2Id = _extractFc2Id(mainSrc) ?? '';
      navBtn.title = `この放送をメインにする${fc2Id ? '（' + fc2Id + '）' : ''}`;
    }
    _placeCanvasEls();

    repositionMainCanvas();
    updateMuteOverlay();

    // この放送（url）の初期音量を決定して slider とサブ iframe に適用
    // 既に独立音量が設定済みならそれを、未設定ならスワップ元のメイン video の現在値を使う
    let initVol = urlVolumes.get(url);
    if (initVol == null) {
      const mv = getVideoEl(liveUrl);  // S17: キャッシュ利用
      initVol = mv ? mv.volume : 1.0;
      urlVolumes.set(url, initVol);
    }
    if (volumeSlider) {
      volumeSlider.value = String(Math.round(initVol * 100));
    }
    const dForVol = subData.get(url);
    if (dForVol?.videoEl && dForVol.videoEl.isConnected) {
      try { dForVol.videoEl.volume = initVol; } catch (_) {}
    }
    if (dForVol?.iframe) {
      try {
        dForVol.iframe.contentDocument?.querySelectorAll('audio').forEach(el => {
          el.volume = initVol;
        });
      } catch (_) {}
    }

    // 統合 RAF への登録（個別 RAF を回さず、_globalDrawLoop で描画される）
    _mainCanvasSrc = url;
    // S13: alpha:false（背景透過不要・mainCanvas はビューを完全に覆う）+ desynchronized:true（GPU フェンス削減）
    _mainCanvasCtx = mainCanvas.getContext('2d', { alpha: false, desynchronized: true });
    _drawMainPending = true;
    _ensureGlobalRaf();
    showFrost();

    if (subData.get(url)?.ended) ensureMainEndedBadge();
  }

  function hideMainCanvas() {
    removeMainEndedBadge();
    hideFrost();
    _drawMainPending = false;
    _mainCanvasSrc = null;
    _mainCanvasCtx = null;
    _mainOffscreen = null;
    _mainOffscreenCtx = null;
    if (_hideControlsTimer) { clearTimeout(_hideControlsTimer); _hideControlsTimer = null; }
    if (mainCanvas)  { mainCanvas.remove();  mainCanvas  = null; }
    if (edgeBlurEl)  { edgeBlurEl.remove();  edgeBlurEl  = null; }
    if (controlsBar) { controlsBar.remove(); controlsBar = null; }
    muteBtn = null;
    volumeSlider = null;
    commentToggleBtn = null;
    navBtn = null;
    _commentLayerHidden = false; // 次のスワップでコメントは表示状態に戻す
    // _sideHidden はここでリセットしない。ユーザーが最大化を選択していた場合、
    // スワップをまたいでも状態を維持する（最大化の永続化）。
    // リセットは exitPseudoFullscreen()（サブ全削除時）で行う。
  }

  // ─── 強制全画面モード（pseudo-fullscreen）─────────────────
  // FC2 ライブのプレイヤーコンテナ (#js-livePlayerContainer) を、バー高さ分を
  // 残してビューポート全面に固定する。サブ放送ありの状態で常に適用する。
  // 注: FC2 の右側エリア・コメント入力欄等の周辺UI非表示セレクタは推測。
  //     構造変化時は実機で再採取が必要。
  (function () {
    const styleEl = document.createElement('style');
    styleEl.id = 'nmv2-pseudo-fs-style';
    styleEl.textContent = [
      // ページ全体のスクロール抑止
      'body.nmv2-pseudo-fs{overflow:hidden!important;}',
      // プレイヤーコンテナをビューポート全面に固定（バー高さ分だけ下端を空ける）
      'body.nmv2-pseudo-fs #js-livePlayerContainer{' +
        'position:fixed!important;' +
        'top:0!important;left:0!important;right:0!important;' +
        'bottom:var(--nmv2-bar-h,0px)!important;' +
        'width:100vw!important;' +
        'height:calc(100vh - var(--nmv2-bar-h,0px))!important;' +
        'max-width:none!important;max-height:none!important;' +
        'z-index:2147483640!important;' +
        'background:#000!important;' +
      '}',
      // 元放送のアスペクト比を維持（黒レターボックス）
      'body.nmv2-pseudo-fs #js-livePlayerContainer .js-webrtcVideo,' +
      'body.nmv2-pseudo-fs #js-livePlayerContainer #js-video_area{' +
        'width:100%!important;height:100%!important;' +
      '}',
      'body.nmv2-pseudo-fs #js-livePlayerContainer video{' +
        'width:100%!important;height:100%!important;' +
        'object-fit:contain!important;' +
        'background:#000!important;' +
      '}',
      // コメント/ギフト canvas をプレイヤーコンテナ全域に広げる。
      // pseudo-fs でプレイヤー高さが変わると FC2 側の canvas 位置が上端からずれ、
      // コメントが上部でクリップされるため、top:0 / height:100% に固定する。
      'body.nmv2-pseudo-fs #js-comment_canvas,' +
      'body.nmv2-pseudo-fs #js-gift_canvas{' +
        'position:absolute!important;' +
        'top:0!important;' +
        'left:50%!important;' +
        'transform:translateX(-50%)!important;' +
        'width:auto!important;' +
        'height:100%!important;' +
        'max-width:none!important;max-height:none!important;' +
      '}',
      // サイド非表示モード（最大化）: 右側パネル等を畳んで映像領域を広げる
      // 注: FC2 のサイドパネル / コメント欄 / 設定パネルの具体的セレクタは TBD。
      //     ここでは画面のうちプレイヤー外の主要 wrapper を全て畳む方針で
      //     #header, #footer, .l-twoColumn 等を非表示にする（実機で要調整）。
      'body.nmv2-side-hidden #header,' +
      'body.nmv2-side-hidden #footer,' +
      'body.nmv2-side-hidden #js-side_area,' +
      'body.nmv2-side-hidden .js-side_area,' +
      'body.nmv2-side-hidden #js-right_area,' +
      'body.nmv2-side-hidden .js-right_area{' +
        'display:none!important;' +
      '}',
    ].join('');
    document.head.appendChild(styleEl);
  })();

  // ─── バー表示制御 ────────────────────────────────────────
  function applyBarVisibility() {
    const bar = document.getElementById('nmv2-bar');
    if (!bar) return;
    if (barVisibility === 'hidden') {
      bar.style.setProperty('transform', 'translateY(100%)', 'important');
      bar.style.setProperty('pointer-events', 'none', 'important');
      document.documentElement.style.setProperty('--nmv2-bar-h', '0px');
    } else {
      bar.style.setProperty('transform', 'translateY(0)', 'important');
      bar.style.setProperty('pointer-events', 'auto', 'important');
      document.documentElement.style.setProperty('--nmv2-bar-h', BAR_H + 'px');
      // hidden → 可視 遷移時に統合 RAF を確実に再起動（描画停止状態から復帰）
      _ensureGlobalRaf();
    }
    if (mainCanvas) repositionMainCanvas();
    _updateFloatingAddBtn();
  }

  function showBarPreview() {
    if (barVisibility === 'pinned') return;
    barVisibility = 'preview';
    applyBarVisibility();
  }

  function pinBar() {
    barVisibility = 'pinned';
    applyBarVisibility();
  }

  function hideBar() {
    if (barVisibility === 'pinned') return;
    barVisibility = 'hidden';
    applyBarVisibility();
  }

  // ─── グローバル ドラッグ受付 ──────────────────────────────
  // バーが画面外に退避していても URL ドラッグを拾ってプレビュー表示するため、
  // window レベルで dragenter/over/leave/drop をリッスンする。
  function setupGlobalDragReceiver() {
    const looksLikeUrlDrag = (e) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // DataTransfer 仕様上 dragover 中は中身を読めない。types で URL ドラッグらしさだけ判定する。
      for (let i = 0; i < types.length; i++) {
        const t = types[i];
        if (t === 'text/uri-list' || t === 'text/plain' || t === 'URL') return true;
      }
      return false;
    };

    window.addEventListener('dragenter', (e) => {
      if (!looksLikeUrlDrag(e)) return;
      if (_dragLeaveTimer) { clearTimeout(_dragLeaveTimer); _dragLeaveTimer = null; }
      if (barVisibility === 'hidden') showBarPreview();
    }, true);

    window.addEventListener('dragover', (e) => {
      if (!looksLikeUrlDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, true);

    // dragleave は子要素間移動でも頻発する。relatedTarget=null（ドキュメント外退出）に限定し、
    // さらに 80ms デバウンスして直後の dragenter を待つ（ちらつき防止）。
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget !== null) return;
      if (barVisibility !== 'preview') return;
      if (_dragLeaveTimer) clearTimeout(_dragLeaveTimer);
      _dragLeaveTimer = setTimeout(() => {
        _dragLeaveTimer = null;
        if (barVisibility === 'preview') hideBar();
      }, 80);
    }, true);

    window.addEventListener('drop', (e) => {
      // 「+」スロット上にドロップされた場合は既存ハンドラに任せる（二重処理防止）
      if (e.target?.closest?.('.nmv2-plus')) return;
      if (!looksLikeUrlDrag(e)) {
        if (barVisibility === 'preview') hideBar();
        return;
      }
      const url = extractUrlFromDataTransfer(e.dataTransfer);
      if (!url) {
        if (barVisibility === 'preview') hideBar();
        return;
      }
      e.preventDefault();
      if (subUrls.length >= MAX_SUBS) return;
      if (url === liveUrl || subUrls.includes(url)) {
        if (barVisibility === 'preview' && subUrls.length === 0) hideBar();
        return;
      }
      addSub(url);
    }, true);
  }

  // FC2 ライブには「シアターモード」相当の機能が無いため no-op。
  // ニコ生からの移植時に同名関数の呼び出し箇所を残しているが、何もしない。
  function enterTheaterModeIfNeeded() { /* no-op (FC2) */ }
  function exitTheaterModeIfNeeded()  { /* no-op (FC2) */ }

  // ─── 強制全画面モードの開始／終了 ────────────────────────
  function enterPseudoFullscreen() {
    if (_pseudoFullscreen) return;
    _pseudoFullscreen = true;
    document.body.classList.add('nmv2-pseudo-fs');
    disableNicoMaximizeButton();
    showCustomMaxBtn();
    _placeCanvasEls();
    repositionMainCanvas();
    // 視聴体験向上のためシアターモードに自動移行
    // （ボタンが DOM に存在するまで少し待ってから実行）
    setTimeout(enterTheaterModeIfNeeded, 300);
  }

  function exitPseudoFullscreen() {
    if (!_pseudoFullscreen) return;
    _pseudoFullscreen = false;
    document.body.classList.remove('nmv2-pseudo-fs');
    enableNicoMaximizeButton();
    hideCustomMaxBtn();
    // サブ全削除でここに来る。最大化状態もここで解除して元の UI に戻す。
    if (_sideHidden) {
      _sideHidden = false;
      document.body.classList.remove('nmv2-side-hidden');
    }
    cleanLeoPlayerInnerHeight();   // インラインスタイルの残留を除去
    exitTheaterModeIfNeeded();     // シアターモードを元に戻す
    _placeCanvasEls();
    repositionMainCanvas();
  }

  // ─── カスタム最大化ボタン（FC2 では未実装）──────────────
  // ニコ生版ではネイティブの最大化ボタン位置に独自ボタンを重ねていたが、
  // FC2 ライブには等価なボタンが無いため初期実装では UI 用意なし。
  // _sideHidden の切り替えは swapWithMain() の自動制御のみ。
  function showCustomMaxBtn() { /* no-op (FC2) */ }
  function hideCustomMaxBtn() { /* no-op (FC2) */ }
  function insertCustomMaxBtn() { /* no-op (FC2) */ }
  function updateCustomMaxBtnLabel() { /* no-op (FC2) */ }
  function cleanLeoPlayerInnerHeight() { /* no-op (FC2) — CSS のみで完結する */ }

  // FC2 にはニコ生のような「最大化ボタンを抑え込むネイティブ機能」が無いため no-op。
  function disableNicoMaximizeButton() { /* no-op (FC2) */ }
  function enableNicoMaximizeButton()  { /* no-op (FC2) */ }

  function setupMaximizeConstraint() {
    // FC2 にはニコ生の data-player-layout-mode のような最大化属性は無いため監視不要。
    // ブラウザ Fullscreen API: バーを fullscreen 要素内に移動するロジックだけ残す。
    document.addEventListener('fullscreenchange', () => {
      // pseudo-fs 中は、ネイティブ Fullscreen と重畳しないようキャンセルする。
      if (_pseudoFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
        return;
      }
      const target = getOverlayParent();
      const bar = document.getElementById('nmv2-bar');
      if (bar)         target.appendChild(bar);
      if (mainCanvas)  target.appendChild(mainCanvas);
      if (controlsBar) target.appendChild(controlsBar);
      if (frostEl)     target.appendChild(frostEl);
      _placeCanvasEls();
      repositionMainCanvas();
    });
  }

  // ─── リサイズ対応 ────────────────────────────────────────
  let _resizeTimer = null;
  function onResize() {
    if (_resizeTimer != null) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _resizeTimer = null;
      updateSlotDims();

      // バーの高さを更新
      const bar = document.getElementById('nmv2-bar');
      if (bar) bar.style.setProperty('height', `${BAR_H}px`, 'important');

      // すりガラスの bottom を更新
      if (frostEl) frostEl.style.setProperty('bottom', `${BAR_H}px`, 'important');

      // navBtn は controlsBar 内の flex 配置のため個別の座標更新は不要
      // （controlsBar 全体は repositionMainCanvas で再配置される）

      // 既存スロットの寸法を更新（差分 renderBar では DOM 再生成しないため必須）
      _resizeAllSlots();
      // renderBar は新規追加/削除があった場合の差分整合用（リサイズ単体ではほぼ no-op）
      renderBar();

      // メインキャンバスの位置とサイズを更新
      repositionMainCanvas();
      // --nmv2-bar-h を現在のバー表示状態（hidden/preview/pinned）と新 BAR_H に合わせて再適用
      applyBarVisibility();
    }, 150);
  }

  // ─── すりガラスオーバーレイ＋移動ボタン ─────────────────
  function showFrost() {
    const target = getOverlayParent();
    if (!frostEl) {
      frostEl = document.createElement('div');
      frostEl.id = 'nmv2-frost';
      frostEl.style.cssText = [
        'position:fixed',
        'inset:0',
        `bottom:${BAR_H}px`,
        'z-index:2147483645',
        // S15: 攻めた最適化 — blur を半減（8→4）+ 半透明度を上げ（0.38→0.55）て視認を維持
        'background:rgba(0,0,0,0.55)',
        'backdrop-filter:blur(4px)',
        '-webkit-backdrop-filter:blur(4px)',
        'pointer-events:auto',
        'cursor:default',
        'will-change:opacity',  // S14: GPU 合成
      ].map(p => p + '!important').join(';') + ';';
      target.appendChild(frostEl);
    } else if (frostEl.parentElement !== target) {
      target.appendChild(frostEl);
    }
    // navBtn の生成・配置は controlsBar 側で行うため、ここでは何もしない
  }

  function hideFrost() {
    if (frostEl) { frostEl.remove(); frostEl = null; }
  }

  async function navigateToMain() {
    const targetUrl = mainSrc;
    if (!targetUrl || targetUrl === 'live') return;

    // 新ページの subs: 元の liveUrl（現ページ）+ その他サブ（ターゲット除く）
    const newSubs = [liveUrl, ...subUrls.filter(u => u !== liveUrl && u !== targetUrl)];

    // liveUrl の現在音量が urlVolumes に無ければ mainVideo から取り込む
    if (!urlVolumes.has(liveUrl)) {
      const mv = getVideoEl(liveUrl);  // S17: キャッシュ利用
      if (mv) urlVolumes.set(liveUrl, mv.volume);
    }

    // 引き継ぐ音量は、新ページで関係しうる URL（targetUrl と newSubs）のみに絞る
    const carryUrls = new Set([targetUrl, ...newSubs]);
    const volumes = {};
    for (const [u, v] of urlVolumes) {
      if (carryUrls.has(u) && typeof v === 'number') volumes[u] = v;
    }

    // stateKey 依存ではなく local storage に書き込み、新ページで確実に読み取れるようにする
    try {
      await chrome.storage.local.set({
        nmv2_transfer: { subs: newSubs, to: targetUrl, volumes, ts: Date.now() },
      });
    } catch (_) {}
    location.href = targetUrl;
  }

  // ─── スロットメタ情報（放送者名・タイトル）─────────────────
  // FC2 ライブには #embedded-data のような構造化メタデータが無いため、
  // document.title ("<タイトル> [<FC2USER...>] - FC2ライブ") と h2.c-pgTit から抽出する。
  // アイコン (thumb) は初期実装では非対応。
  function extractSlotMeta(doc) {
    if (!doc) return null;
    try {
      const rawTitle = (doc.title || '').trim();
      if (!rawTitle) return null;

      // "タイトル [FC2USER...] - FC2ライブ" 形式
      const m = rawTitle.match(/^(.+?)\s+\[(FC2USER[A-Z0-9]+)\]\s+-\s+FC2ライブ\s*$/);
      let title  = '';
      let userId = '';
      if (m) {
        title  = m[1].trim();
        userId = m[2];
      } else {
        // フォールバック: " - FC2ライブ" を除去するだけ
        title = rawTitle.replace(/\s+-\s+FC2ライブ\s*$/, '').trim();
      }

      // 補助: h2.c-pgTit が "未記入" 以外ならそれを優先
      const pgTit = doc.querySelector?.('h2.c-pgTit')?.textContent?.trim();
      if (pgTit && pgTit !== '未記入') title = pgTit;

      const name = userId || title || '配信者';

      if (!title && !userId) return null;
      return { title: title || '無題', name, thumb: '', userId };
    } catch (_) { return null; }
  }

  function updateSlotLabel(url) {
    const bar = document.getElementById('nmv2-bar');
    if (!bar) return;
    const slot = bar.querySelector(`.nmv2-slot[data-url="${CSS.escape(url)}"]`);
    if (!slot) return;
    const d = subData.get(url);
    if (!d?.meta) return;
    const { title, name } = d.meta;
    if (title) slot.title = title;
    const label = slot.querySelector('.nmv2-label');
    if (!label) return;
    label.innerHTML = '';
    const nameEl = document.createElement('span');
    nameEl.textContent = name || _extractFc2Id(url) || url;
    nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
    label.appendChild(nameEl);
  }

  function loadMetaAndUpdateSlot(url) {
    const d = subData.get(url);
    if (!d) return;
    const tryExtract = () => {
      const doc = (url === liveUrl) ? document : (d.iframe?.contentDocument ?? null);
      const meta = extractSlotMeta(doc);
      if (meta) { d.meta = meta; updateSlotLabel(url); return true; }
      return false;
    };
    if (tryExtract()) return;
    if (!d.iframe) return;

    // MutationObserver で document.title の確定を待つ（FC2 は load 時点でほぼセット済み）
    const setupMetaObserver = () => {
      try {
        const doc = d.iframe?.contentDocument;
        if (!doc || !doc.documentElement) return false;
        if (tryExtract()) return true;
        const mo = new MutationObserver(() => {
          if (tryExtract()) {
            mo.disconnect();
            if (d.metaObserver === mo) d.metaObserver = null;
            if (d.metaSafetyTimer) { clearTimeout(d.metaSafetyTimer); d.metaSafetyTimer = 0; }
          }
        });
        // head/body どちらに挿入されるか不定なので documentElement 全体を監視
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        d.metaObserver = mo;
        return true;
      } catch (_) { return false; }
    };

    setupMetaObserver();
    d.iframe.addEventListener('load', () => { setupMetaObserver(); }, { once: true });

    // セーフティ: 最後にもう一度 3 秒後に試す（observer が動かないエッジケースに備える）
    d.metaSafetyTimer = setTimeout(() => {
      d.metaSafetyTimer = 0;
      if (!tryExtract()) {
        if (d.metaObserver) { d.metaObserver.disconnect(); d.metaObserver = null; }
        setupMetaObserver();
      }
    }, 3000);
  }

  // ─── 隠しiframe ─────────────────────────────────────────
  function createHiddenIframe(url) {
    const iframe = document.createElement('iframe');
    // S3: ロード優先度を下げ、メイン放送と既存サブの再生を優先させる。
    //  - fetchPriority='low': ネットワーク取得の優先度を下げる（Chrome 102+）
    //  - loading='lazy': ビューポート外の iframe としてブラウザに低優先度ヒントを与える
    // src は属性設定後に最後にセットすることで上記ヒントを反映させる。
    try { iframe.fetchPriority = 'low'; } catch (_) {}
    iframe.loading = 'lazy';
    iframe.setAttribute('allow', 'autoplay; encrypted-media');
    iframe.style.cssText = [
      'position:fixed',
      `left:-${SLOT_W + 50}px`,
      'top:0',
      `width:${SLOT_W}px`,
      `height:${SLOT_H}px`,
      'border:0',
      'pointer-events:none',
      'z-index:-1',
    ].map(p => p + '!important').join(';') + ';';
    iframe.src = url;
    document.documentElement.appendChild(iframe);
    return iframe;
  }

  // ─── バーのスロット ──────────────────────────────────────
  function createSubSlot(url, idx) {
    const slot = document.createElement('div');
    slot.className = 'nmv2-slot';
    slot.dataset.idx = String(idx);
    slot.dataset.url = url;
    const _meta = subData.get(url)?.meta;
    slot.title = _meta?.title || _extractFc2Id(url) || url;
    slot.style.cssText = `
      position:relative;width:${SLOT_W}px;height:${SLOT_H}px;
      flex:0 0 auto;background:#000;cursor:pointer;
      border:1px solid #444;box-sizing:border-box;overflow:hidden;
    `;

    const canvas = document.createElement('canvas');
    canvas.width  = SLOT_W;
    canvas.height = SLOT_H;
    // S14: 各スロットを GPU レイヤーに昇格
    canvas.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;will-change:transform;';
    slot.appendChild(canvas);

    // S13: サブは alpha:false / desynchronized:true / smoothing off で軽量化
    // 注意: 同じ canvas への getContext は最初のオプションのみが有効。後段の startBarDraw
    //       でも同一オプションになるよう、必ずここで生成しておく。
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, SLOT_W, SLOT_H);
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(_extractFc2Id(url) ?? '...', SLOT_W / 2, SLOT_H / 2);

    const d = subData.get(url);
    if (d) {
      d._ctx  = ctx;    // 新 canvas のコンテキストを明示セット（古い canvas の ctx が残るバグを防ぐ）
      d.canvas = canvas;
      startBarDraw(url);
    }

    const label = document.createElement('div');
    label.className = 'nmv2-label';
    label.style.cssText = `
      position:absolute;bottom:0;left:0;right:0;
      padding:4px 6px;background:rgba(0,0,0,0.65);
      color:#fff;font-size:11px;line-height:1.3;
      pointer-events:none;user-select:none;
      display:flex;align-items:center;gap:5px;overflow:hidden;
    `;
    {
      const nameEl = document.createElement('span');
      nameEl.textContent = _meta?.name || _extractFc2Id(url) || url;
      nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
      label.appendChild(nameEl);
    }
    slot.appendChild(label);

    // 放送終了バッジ（左上）。初期は非表示、markSubEnded() で display:block に切り替え。
    const endedBadge = document.createElement('div');
    endedBadge.className = 'nmv2-ended-badge';
    endedBadge.textContent = '終了';
    endedBadge.style.cssText = `
      position:absolute;top:3px;left:3px;z-index:2;
      background:rgba(160,20,20,0.92);color:#fff;
      border:1px solid rgba(255,120,120,0.6);
      padding:2px 8px;border-radius:4px;
      font-size:11px;font-weight:bold;letter-spacing:1px;
      pointer-events:none;user-select:none;
      display:${subData.get(url)?.ended ? 'block' : 'none'};
    `;
    slot.appendChild(endedBadge);

    // liveUrl（元のメイン放送）は削除すると疑似全画面が壊れるため × ボタンを非表示にする
    if (url !== liveUrl) {
      const closeBtn = document.createElement('div');
      closeBtn.className = 'nmv2-close';
      closeBtn.textContent = '×';
      closeBtn.title = '閉じる';
      closeBtn.style.cssText = `
        position:absolute;top:3px;right:3px;z-index:2;
        width:22px;height:22px;background:rgba(0,0,0,0.7);
        color:#fff;border:1px solid rgba(255,255,255,0.7);
        border-radius:50%;font-size:13px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        user-select:none;
      `;
      closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#c33'; });
      closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'rgba(0,0,0,0.7)'; });
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        const i = parseInt(slot.dataset.idx, 10);
        if (Number.isFinite(i)) removeSub(i);
      });
      slot.appendChild(closeBtn);
    }

    slot.addEventListener('mouseenter', () => { slot.style.borderColor = '#5af'; });
    slot.addEventListener('mouseleave', () => { slot.style.borderColor = '#444'; });

    slot.addEventListener('click', e => {
      if (e.target.closest('.nmv2-close')) return;
      const i = parseInt(slot.dataset.idx, 10);
      if (Number.isFinite(i)) swapWithMain(i);
    });

    return slot;
  }

  // ─── ザッピングピッカー ──────────────────────────────────
  // 「＋」クリック時に allchannellist.php から番組一覧を取得してポップアップを表示する。
  function _openZappingPicker(anchorEl) {
    // 既に開いていたらトグルで閉じる
    const existing = document.getElementById('nmv2-zapping-picker');
    if (existing) { existing.remove(); return; }

    const rect = anchorEl.getBoundingClientRect();
    const leftPos = Math.min(Math.max(0, rect.left), window.innerWidth - 328);
    const picker = document.createElement('div');
    picker.id = 'nmv2-zapping-picker';
    picker.style.cssText = [
      'position:fixed',
      `left:${leftPos}px`,
      `bottom:${window.innerHeight - rect.top + 8}px`,
      'width:320px',
      'max-height:70vh',
      'overflow-y:auto',
      'overflow-x:hidden',
      'background:#1a1a1a',
      'border:1px solid #444',
      'border-radius:8px',
      'z-index:2147483646',
      'box-shadow:0 4px 24px rgba(0,0,0,0.8)',
      'font-family:sans-serif',
      'color:#eee',
    ].join(';');

    // ヘッダー
    const header = document.createElement('div');
    header.style.cssText = [
      'padding:8px 10px',
      'font-size:12px',
      'color:#bbb',
      'border-bottom:1px solid #333',
      'display:flex',
      'justify-content:space-between',
      'align-items:center',
      'position:sticky',
      'top:0',
      'background:#1a1a1a',
      'z-index:1',
    ].join(';');
    const titleEl = document.createElement('span');
    titleEl.textContent = '放送一覧から追加';
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer;color:#888;font-size:16px;padding:0 2px;';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); picker.remove(); });
    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    picker.appendChild(header);

    // ローディング表示
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'padding:20px;color:#888;font-size:13px;text-align:center;';
    loadingEl.textContent = '読み込み中…';
    picker.appendChild(loadingEl);

    document.body.appendChild(picker);

    // ピッカー外クリックで閉じる（setTimeout でトグルクリックと干渉しないようにする）
    const onOutsideClick = (e) => {
      if (!picker.isConnected) { document.removeEventListener('click', onOutsideClick, true); return; }
      if (!picker.contains(e.target) && !anchorEl.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', onOutsideClick, true);
      }
    };
    setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);

    // allchannellist.php から番組一覧を取得して描画
    fetch('https://live.fc2.com/contents/allchannellist.php')
      .then(r => r.json())
      .then(data => {
        if (!picker.isConnected) return;
        loadingEl.remove();
        const channels = Array.isArray(data?.channel) ? data.channel : [];
        channels.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
        if (channels.length === 0) {
          const msg = document.createElement('div');
          msg.style.cssText = 'padding:20px;color:#888;font-size:13px;text-align:center;';
          msg.textContent = '放送中の番組はありません';
          picker.appendChild(msg);
          return;
        }
        const list = document.createElement('div');
        channels.forEach(ch => {
          const url = `https://live.fc2.com/${ch.id}/`;
          const item = document.createElement('div');
          item.style.cssText = [
            'display:flex',
            'align-items:center',
            'gap:8px',
            'padding:6px 10px',
            'cursor:pointer',
            'border-bottom:1px solid #252525',
          ].join(';');
          item.addEventListener('mouseenter', () => { item.style.background = '#272727'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });

          const thumb = document.createElement('img');
          thumb.style.cssText = 'width:80px;height:45px;object-fit:cover;flex:0 0 auto;border-radius:3px;background:#333;';
          if (ch.image) thumb.src = ch.image;
          thumb.onerror = () => { thumb.style.visibility = 'hidden'; };

          const info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0;';

          const titleDiv = document.createElement('div');
          titleDiv.textContent = ch.title || ch.name || '（タイトルなし）';
          titleDiv.style.cssText = 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eee;';

          const metaDiv = document.createElement('div');
          metaDiv.textContent = `${ch.name || ''}  👁 ${ch.count ?? 0}`;
          metaDiv.style.cssText = 'font-size:11px;color:#777;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

          info.appendChild(titleDiv);
          info.appendChild(metaDiv);
          item.appendChild(thumb);
          item.appendChild(info);

          item.addEventListener('click', () => {
            picker.remove();
            if (subUrls.length >= MAX_SUBS) return;
            if (url === liveUrl || subUrls.includes(url)) return;
            addSub(url);
          });

          list.appendChild(item);
        });
        picker.appendChild(list);
      })
      .catch(() => {
        if (!picker.isConnected) return;
        loadingEl.textContent = '番組一覧を取得できませんでした';
      });
  }

  // ─── 左下フローティング「＋」ボタン ──────────────────────
  // バーが非表示（サブ未追加）のときに常時表示するエントリポイント。
  let _floatingAddBtn = null;

  function _ensureFloatingAddBtn() {
    if (_floatingAddBtn && _floatingAddBtn.isConnected) return _floatingAddBtn;
    const btn = document.createElement('div');
    btn.id = 'nmv2-floating-add';
    btn.textContent = '＋';
    btn.title = '放送を追加';
    btn.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'left:12px',
      'width:36px',
      'height:36px',
      'border-radius:50%',
      'background:rgba(20,20,20,0.85)',
      'border:2px solid #555',
      'color:#aaa',
      'font-size:20px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'z-index:2147483645',
      'user-select:none',
      'box-shadow:0 2px 8px rgba(0,0,0,0.6)',
    ].join(';');
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#fff'; btn.style.color = '#fff'; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#555'; btn.style.color = '#aaa'; });
    btn.addEventListener('click', () => _openZappingPicker(btn));
    _floatingAddBtn = btn;
    return btn;
  }

  function _updateFloatingAddBtn() {
    if (barVisibility === 'hidden') {
      const btn = _ensureFloatingAddBtn();
      if (!btn.isConnected) (document.body || document.documentElement).appendChild(btn);
      btn.style.display = 'flex';
    } else if (_floatingAddBtn) {
      _floatingAddBtn.style.display = 'none';
    }
  }

  function createPlusSlot() {
    const plus = document.createElement('div');
    plus.className = 'nmv2-plus';
    plus.style.cssText = `
      width:${SLOT_W}px;height:${SLOT_H}px;flex:0 0 auto;
      display:flex;align-items:center;justify-content:center;
      border:2px dashed #666;background:#1a1a1a;
      color:#aaa;font-size:64px;cursor:pointer;
      user-select:none;box-sizing:border-box;
    `;
    const label = document.createElement('div');
    label.textContent = '＋';
    label.style.pointerEvents = 'none';
    plus.appendChild(label);

    let dragActive = false;

    plus.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!dragActive) {
        dragActive = true;
        plus.style.borderColor = '#fff';
        plus.style.background = '#2a2a2a';
        plus.style.color = '#fff';
      }
    });
    plus.addEventListener('dragleave', e => {
      e.stopPropagation();
      if (plus.contains(e.relatedTarget)) return;
      dragActive = false;
      plus.style.borderColor = '#666';
      plus.style.background = '#1a1a1a';
      plus.style.color = '#aaa';
    });
    plus.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      dragActive = false;
      plus.style.borderColor = '#666';
      plus.style.background = '#1a1a1a';
      plus.style.color = '#aaa';
      const url = extractUrlFromDataTransfer(e.dataTransfer);
      if (!url) {
        plus.style.borderColor = '#f44';
        plus.style.color = '#f44';
        setTimeout(() => { plus.style.borderColor = '#666'; plus.style.color = '#aaa'; }, 800);
        return;
      }
      if (subUrls.length >= MAX_SUBS) return;
      if (url === liveUrl || subUrls.includes(url)) return;
      addSub(url);
    });

    // クリックでザッピングピッカーを開く（ドラッグ中は発火しない）
    plus.addEventListener('click', () => {
      if (subUrls.length >= MAX_SUBS) return;
      _openZappingPicker(plus);
    });

    return plus;
  }

  // ─── バー描画（差分更新）──────────────────────────────
  // 旧: bar.innerHTML='' で全スロット破棄 → 既存サブの canvas/RAF も停止
  // 新: 既存スロット DOM を url-keyed Map で再利用、変化分のみ作成/削除する
  //     → サブ追加・スワップ時に既存サブの描画が一切途切れない
  const _slotCache = new Map(); // url -> slot DOM
  let _plusSlotEl = null;

  function renderBar() {
    const bar = document.getElementById('nmv2-bar');
    if (!bar) return;
    const wanted = new Set(subUrls);

    // 1. 不要になったスロットを除去
    for (const [url, slot] of _slotCache) {
      if (!wanted.has(url)) {
        stopBarDraw(url);
        if (slot.isConnected) slot.remove();
        _slotCache.delete(url);
      }
    }

    // 2. subUrls の順に append（既存要素は appendChild で位置移動・新規は createSubSlot）
    subUrls.forEach((url, idx) => {
      let slot = _slotCache.get(url);
      if (!slot) {
        slot = createSubSlot(url, idx);
        _slotCache.set(url, slot);
      } else {
        slot.dataset.idx = String(idx);
      }
      bar.appendChild(slot);
    });

    // 3. plus スロット: 必要なら末尾に、不要なら退避（要素は使い回す）
    if (subUrls.length < MAX_SUBS) {
      if (!_plusSlotEl) _plusSlotEl = createPlusSlot();
      bar.appendChild(_plusSlotEl);
    } else if (_plusSlotEl && _plusSlotEl.isConnected) {
      _plusSlotEl.remove();
    }
  }

  // リサイズ時のスロット寸法更新（差分 renderBar では DOM を再生成しないため必要）
  function _resizeAllSlots() {
    for (const slot of _slotCache.values()) {
      slot.style.width  = SLOT_W + 'px';
      slot.style.height = SLOT_H + 'px';
      const canvas = slot.querySelector('canvas');
      if (canvas) {
        // canvas の width/height 属性は描画バッファサイズ。リセットすると一瞬黒くなるが
        // 24fps RAF で即座に次フレームが描かれるため視認上は問題ない。
        canvas.width  = SLOT_W;
        canvas.height = SLOT_H;
      }
    }
    if (_plusSlotEl) {
      _plusSlotEl.style.width  = SLOT_W + 'px';
      _plusSlotEl.style.height = SLOT_H + 'px';
    }
  }

  // ─── サブ追加・削除 ──────────────────────────────────────
  function addSub(url) {
    // 初回起動ガイド表示中なら、ユーザーが説明通りドラッグした時点で目的達成。
    // ガイドを閉じてから通常の追加処理に進む。
    dismissFirstRunGuide();
    subUrls.push(url);
    subData.set(url, { iframe: createHiddenIframe(url), canvas: null, rafId: null, meta: null });
    installAudioObserver(url);
    installEndGuideObserver(url);
    installCanvasObserver(url);
    loadMetaAndUpdateSlot(url);
    renderBar();
    pinBar();
    enterPseudoFullscreen();
    persistState();
  }

  function removeSub(idx) {
    const url = subUrls[idx];
    if (!url) return;

    stopBarDraw(url);
    uninstallAudioObserver(url);
    uninstallCanvasObserver(url);
    const d = subData.get(url);
    if (d) {
      if (d.metaObserver) { d.metaObserver.disconnect(); d.metaObserver = null; }
      if (d.metaSafetyTimer) { clearTimeout(d.metaSafetyTimer); d.metaSafetyTimer = 0; }
      if (d.iframe?.isConnected) d.iframe.remove();
      subData.delete(url);
    }

    if (mainSrc === url) {
      hideMainCanvas();
      mainSrc = 'live';
      syncAudio();
    }

    subUrls.splice(idx, 1);
    renderBar();
    if (subUrls.length === 0) {
      exitPseudoFullscreen();
      // pinned 状態を解除してからバーを退避させる
      barVisibility = 'hidden';
      applyBarVisibility();
    }
    persistState();
  }

  // ─── スワップ（即時・ページナビなし）───────────────────
  function swapWithMain(barIdx) {
    const subUrl = subUrls[barIdx];
    if (!subUrl) return;

    const prevMain   = (mainSrc === 'live') ? liveUrl : mainSrc;
    const oldMainSrc = mainSrc;

    // 本放送（liveUrl）が降格するとき、現在のユーザー設定最大化状態を記憶する。
    if (mainSrc === 'live') {
      _liveUrlSideHidden = _sideHidden;
    }

    if (mainSrc === 'live' && !subData.has(liveUrl)) {
      subData.set(liveUrl, { iframe: null, canvas: null, rafId: null, meta: null });
      loadMetaAndUpdateSlot(liveUrl);
      installCanvasObserver(liveUrl);
    }

    subUrls = subUrls.map((u, i) => (i === barIdx ? prevMain : u));
    mainSrc = (subUrl === liveUrl) ? 'live' : subUrl;

    if (oldMainSrc !== 'live') hideMainCanvas();

    if (mainSrc === 'live') {
      // 本放送（liveUrl）が昇格 → 降格前にユーザーが設定した最大化状態を復元
      uninstallCanvasObserver(liveUrl);
      subData.delete(liveUrl);
      _sideHidden = _liveUrlSideHidden;
      document.body.classList.toggle('nmv2-side-hidden', _sideHidden);
      updateCustomMaxBtnLabel();
    } else {
      showMainCanvas(subUrl);
      // サブ放送が昇格 → 仕様上、常に最大化で表示
      _sideHidden = true;
      document.body.classList.add('nmv2-side-hidden');
      updateCustomMaxBtnLabel();
    }

    updateMuteOverlay();
    syncAudio();
    renderBar();
    // renderBar() が DOM を再構成した後、canvas が正しい親にあることを保証する
    if (mainSrc !== 'live') {
      _placeCanvasEls();
      repositionMainCanvas();
    }
    // 独自最大化ボタンは FC2 では未実装（no-op）。スワップ後の状態管理だけ。
    persistState();
  }

  // ─── 初回起動ガイド ──────────────────────────────────────
  // インストール直後の初回ロード時のみ、空のバー（＋スロット）と説明オーバーレイを
  // 表示する。任意の場所をクリック、または最初のサブを追加した時点で dismiss し、
  // chrome.storage.local にフラグを保存して再表示を抑止する。
  const FIRST_RUN_KEY = 'nmv2_first_run_done';
  let _guideOverlay      = null;
  let _guideClickHandler = null;

  async function maybeShowFirstRunGuide() {
    // 既にサブがある状態（セッション復元など）では案内不要
    if (subUrls.length > 0) return;
    try {
      const got = await chrome.storage.local.get(FIRST_RUN_KEY);
      if (got[FIRST_RUN_KEY]) return;
    } catch (_) {
      // フラグ取得失敗時はフェイルオープン（表示する）
    }
    showFirstRunGuide();
  }

  function showFirstRunGuide() {
    if (_guideOverlay) return;
    // バーを pinned 状態にして「＋」スロットを画面に出す
    // （pseudo-fs には入らない。あくまで案内表示のみ）
    pinBar();

    const ov = document.createElement('div');
    ov.id = 'nmv2-firstrun-guide';
    // pointer-events:none でオーバーレイ自体はクリックを素通りさせる
    // （＋スロットへのドラッグ＆ドロップを妨げない）
    ov.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483646',
      'background:rgba(0,0,0,0.55)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'color:#fff',
      'font-family:system-ui,sans-serif',
      'user-select:none',
      'pointer-events:none',
    ].map(p => p + '!important').join(';') + ';';

    const card = document.createElement('div');
    // カードは pointer-events:auto にして下のページ UI を遮断する
    card.style.cssText = [
      'background:rgba(20,20,20,0.96)',
      'border:1px solid #5af',
      'border-radius:12px',
      'padding:24px 32px',
      'max-width:520px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'text-align:left',
      'pointer-events:auto',
      'cursor:pointer',
    ].map(p => p + '!important').join(';') + ';';

    const title = document.createElement('div');
    title.textContent = 'FC2MultiViewer の使い方';
    title.style.cssText = 'font-size:20px;font-weight:bold;margin-bottom:16px;color:#5af;';

    const step1 = document.createElement('div');
    step1.style.cssText = 'font-size:15px;line-height:1.6;margin-bottom:16px;';
    step1.innerHTML =
      '視聴したい放送ページのURLをドラッグすると画面下に<b style="color:#5af;">「＋」</b> 領域が表示されます。</br>' +
      'そのまま<b style="color:#5af;">「＋」</b> 領域へURLをドロップするとサブ放送が追加されます。';

    const hint = document.createElement('div');
    hint.textContent = '— クリックで閉じる —';
    hint.style.cssText = 'font-size:12px;color:#aaa;text-align:center;';

    card.appendChild(title);
    card.appendChild(step1);
    card.appendChild(hint);
    ov.appendChild(card);

    getOverlayParent().appendChild(ov);
    _guideOverlay = ov;

    // window レベルの capture click で dismiss（バー上やカード上を含め、任意の領域）。
    // 次イベントループから登録して、表示トリガーとなったクリックが即時 dismiss しないようにする。
    setTimeout(() => {
      if (!_guideOverlay) return;
      _guideClickHandler = () => dismissFirstRunGuide();
      window.addEventListener('click', _guideClickHandler, true);
    }, 0);
  }

  function dismissFirstRunGuide() {
    if (!_guideOverlay) return;
    if (_guideClickHandler) {
      window.removeEventListener('click', _guideClickHandler, true);
      _guideClickHandler = null;
    }
    if (_guideOverlay.isConnected) _guideOverlay.remove();
    _guideOverlay = null;
    // 再表示抑止フラグを保存
    try { chrome.storage.local.set({ [FIRST_RUN_KEY]: true }); } catch (_) {}
    // サブが無ければ通常状態（バー非表示）に戻す。
    // サブが既にある（ドラッグ起因の dismiss）場合はそのままバーを残す。
    if (subUrls.length === 0) {
      barVisibility = 'hidden';
      applyBarVisibility();
    }
  }

  // ─── バー本体 ────────────────────────────────────────────
  function createBar() {
    const bar = document.createElement('div');
    bar.id = 'nmv2-bar';
    // 初期状態は画面外（applyBarVisibility が transform を上書きする）
    bar.style.cssText = [
      'position:fixed',
      'bottom:0',
      'left:0',
      'right:0',
      `height:${BAR_H}px`,
      'z-index:2147483647',
      'background:#111',
      'border-top:1px solid #444',
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:6px 8px',
      'box-sizing:border-box',
      'overflow:hidden',
      'transform:translateY(100%)',
      'transition:transform 180ms ease-out',
      'pointer-events:none',
      'will-change:transform',  // S14: スライドイン/アウトを GPU で
    ].map(p => p + '!important').join(';') + ';';
    bar.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
    bar.addEventListener('drop',     e => { e.preventDefault(); e.stopPropagation(); });
    return bar;
  }

  // ─── 初期化 ──────────────────────────────────────────────
  async function init() {
    try {
      tabId = await new Promise(resolve => {
        try {
          chrome.runtime.sendMessage({ type: 'getTabId' }, id => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(typeof id === 'number' ? id : null);
          });
        } catch (_) { resolve(null); }
      });
    } catch (_) {}

    if (tabId != null) stateKey = 'tab_' + tabId;

    if (stateKey) {
      try {
        const got = await chrome.storage.session.get(stateKey);
        const st  = got[stateKey];
        if (st && Array.isArray(st.subs)) {
          subUrls = st.subs.filter(isFc2LiveUrl).slice(0, MAX_SUBS);
        }
      } catch (_) {}
    }

    // 「この放送をメインにする」ボタンによる遷移データを確認（30 秒以内）
    // URL の完全一致ではなく FC2 ID（数字）で照合する。
    try {
      const got = await chrome.storage.local.get('nmv2_transfer');
      const tr  = got['nmv2_transfer'];
      const trId = _extractFc2Id(tr?.to);
      if (tr && trId && trId === _extractFc2Id(liveUrl) && Array.isArray(tr.subs) && Date.now() - tr.ts < 30000) {
        subUrls = tr.subs.filter(isFc2LiveUrl).slice(0, MAX_SUBS);
        // 音量を復元（各放送ごとの独立音量を引き継ぐ）
        if (tr.volumes && typeof tr.volumes === 'object') {
          for (const [u, v] of Object.entries(tr.volumes)) {
            if (typeof v === 'number' && v >= 0 && v <= 1 && isFc2LiveUrl(u)) {
              urlVolumes.set(u, v);
            }
          }
          // 新ページのメイン放送（liveUrl）の音量は mainVideo が出現次第適用
          if (urlVolumes.has(liveUrl)) {
            _pendingInitialMainVolume = urlVolumes.get(liveUrl);
          }
        }
        chrome.storage.local.remove('nmv2_transfer').catch(() => {});
      }
    } catch (_) {}

    updateSlotDims();

    // バーは body の外（documentElement 直下）に置く。
    // body に transform を当てて最大化を抑え込む際、バーを body の外に置くことで
    // バー自身は viewport 下端に固定され続ける。
    const bar = createBar();
    document.documentElement.appendChild(bar);

    for (const url of subUrls) {
      subData.set(url, { iframe: createHiddenIframe(url), canvas: null, rafId: null, meta: null });
      installAudioObserver(url);
      installEndGuideObserver(url);
      installCanvasObserver(url);
      loadMetaAndUpdateSlot(url);
    }

    ensureVolumeListener();
    setupMainVideoObserver();
    renderBar();
    persistState();

    // バー表示状態の初期化（subs があれば pinned + pseudo-fs、無ければ hidden）
    if (subUrls.length > 0) {
      pinBar();
      enterPseudoFullscreen();
    } else {
      applyBarVisibility();
      // 初回起動時のみ、空のスロット領域と説明オーバーレイを表示する
      maybeShowFirstRunGuide();
    }

    setupGlobalDragReceiver();

    // frame-content.js → background 中継 → ここで受け取る放送終了通知
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'nmv2-sub-ended') return;
      const endedId = _extractFc2Id(msg.url);
      if (!endedId) return;
      for (const url of subUrls) {
        if (_extractFc2Id(url) === endedId) {
          markSubEnded(url);
          break;
        }
      }
    });

    window.addEventListener('resize', onResize);
    setupMaximizeConstraint();

    // S18: タブ非アクティブ時は統合 RAF を停止、復帰時に再開
    // RAF はブラウザが自動でスロットリングするが、明示停止で wakeup を確実に減らす。
    // iframe 内の video 再生・コメント取得は継続する（canvas 転写のみ停止）。
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (_globalRafId) { cancelAnimationFrame(_globalRafId); _globalRafId = 0; }
      } else {
        // 描画対象があれば RAF を起こす
        if (_drawMainPending || barVisibility !== 'hidden') _ensureGlobalRaf();
      }
    });
  }

  init();
})();
