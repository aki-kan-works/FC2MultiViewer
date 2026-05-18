(function () {
  'use strict';

  const MAX_SUBS = 4;
  const NICO_LIVE_RE = /^https?:\/\/live2?\.nicovideo\.jp\/watch\/lv\d+/i;

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
  let _commentLayerHidden = false; // スワップ映像のコメントレイヤー非表示状態

  // すりガラスオーバーレイ（サブ昇格時のみ存在）
  let frostEl = null;

  // NMV2 独自全画面
  let _leoPlayer      = null;
  let _playerFixed    = false;
  let _nmv2Fullscreen = false;

  // 強制全画面モード（pseudo-fullscreen）関連
  // ニコ生ネイティブの最大化 (data-player-layout-mode="full") を使わず、
  // 独自CSSで似たレイアウトを実現する。サブiframeのコメント描画停止を回避する。
  let barVisibility   = 'hidden';   // 'hidden' | 'preview' | 'pinned'
  let _pseudoFullscreen = false;
  let _dragLeaveTimer = null;
  let _maxBtnObserver = null;

  // 独自最大化ボタン（ニコ生最大化ボタンの位置にオーバーレイ）
  let customMaxBtn         = null;
  let _ctrlBtnObserver    = null;  // controls bar の MutationObserver（ボタン再挿入用）
  // forceLeoPlayerInnerHeight 用 Observers（300ms ポーリングを置換）
  let _forceHeightRO       = null; // ResizeObserver: leo-player サイズ変化
  let _forceHeightMO       = null; // MutationObserver: 直下構造の差し替え
  let _forceHeightTimer    = 0;    // debounce タイマー（100ms 上限で連発抑制）
  let _enteredTheaterMode  = false; // pseudo-fs 時に我々がシアターモードを起動したかどうか

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
  function isNicoLiveUrl(s) {
    return typeof s === 'string' && NICO_LIVE_RE.test(s.trim());
  }

  function extractUrlFromDataTransfer(dt) {
    if (!dt) return '';
    for (const type of ['text/uri-list', 'text/plain', 'URL']) {
      const raw = dt.getData(type);
      if (!raw) continue;
      for (const line of raw.split(/\r?\n/).map(s => s.trim())) {
        if (line && !line.startsWith('#') && isNicoLiveUrl(line)) return line;
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

  // ─── video / leo-player 要素キャッシュ ───────────────────
  // RAF 内・リサイズ時など高頻度パスでの querySelector を排除する。
  // 値が disconnect されたら次回呼び出し時に再取得する。
  let _mainVideoEl    = null;
  let _cachedLeoPlayer = null;

  function getVideoEl(url) {
    if (url === liveUrl) {
      if (_mainVideoEl && _mainVideoEl.isConnected) return _mainVideoEl;
      _mainVideoEl = document.querySelector('video') ?? null;
      return _mainVideoEl;
    }
    const d = subData.get(url);
    if (!d) return null;
    if (d.videoEl && d.videoEl.isConnected) return d.videoEl;
    try {
      d.videoEl = d.iframe?.contentDocument?.querySelector('video') ?? null;
      return d.videoEl;
    } catch (_) { return null; }
  }

  function _getLeoPlayer() {
    if (_cachedLeoPlayer && _cachedLeoPlayer.isConnected) return _cachedLeoPlayer;
    _cachedLeoPlayer = document.querySelector('[class*="leo-player"]');
    return _cachedLeoPlayer;
  }

  // ─── 音量管理 ─────────────────────────────────────────────
  let _volListenerTarget = null;
  let _extMuting = false; // extension によるミュート変更中フラグ（再入防止）
  let _userMuted = false; // プロモートサブのミュート意図（キャンバス上のボタンで制御）

  // 各放送（URL）ごとの独立音量。スワップ後の初期値はメイン video に揃え、
  // 以後はスライダーで個別に変更可。「移動」遷移時に transfer 経由で引き継ぐ。
  const urlVolumes = new Map();           // URL → 音量(0..1)
  let _pendingInitialMainVolume = null;   // 遷移直後に mainVideo へ適用する初期音量

  function syncVolumeToSubs() {
    if (_extMuting) return;
    const mainVideo = getVideoEl(liveUrl);  // S17: querySelector → キャッシュ
    if (!mainVideo) return;

    if (mainSrc === 'live') {
      // ライブモード: ニコ生 UI 経由の音量変更を liveUrl の独立音量として追跡
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

  function applyUserMuted() {
    const d = subData.get(mainSrc);
    if (!d) return;
    // S17: d.videoEl キャッシュを利用、audio のみ querySelectorAll
    if (d.videoEl && d.videoEl.isConnected) {
      try { d.videoEl.muted = _userMuted; } catch (_) {}
    }
    if (!d.iframe) return;
    try {
      d.iframe.contentDocument?.querySelectorAll('audio').forEach(el => {
        el.muted = _userMuted;
      });
    } catch (_) {}
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
          d.iframe.contentDocument?.querySelectorAll('audio').forEach(el => {
            if (el.muted !== wantMuted) el.muted = wantMuted;
          });
        } catch (_) {}
      }
    } finally {
      _extMuting = false;
    }
  }

  // ─── サブ音声制御（旧 1500ms ポーリングをイベント駆動化）──
  // ニコ生が video 要素を React で再作成・音量リセットしても、以下で追従する:
  //   - MutationObserver(subtree childList): 新規 <video>/<audio> 出現を捕捉
  //   - 各要素の volumechange リスナー: ニコ生による mute/volume 改変を即時是正
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
    }
    _applySubAudioPolicy(url, el);
    try {
      el.addEventListener('volumechange', () => _applySubAudioPolicy(url, el));
    } catch (_) {}
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
        // 既存要素を 1 回スキャン
        doc.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
        // 動的追加を監視
        const mo = new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (!n || n.nodeType !== 1) continue;
              const tag = n.tagName;
              if (tag === 'VIDEO' || tag === 'AUDIO') {
                _trackSubAudioEl(url, n);
              } else if (n.querySelectorAll) {
                n.querySelectorAll('video, audio').forEach(el => _trackSubAudioEl(url, el));
              }
            }
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
  }

  // ─── コメント canvas キャッシュ（毎フレーム querySelectorAll の置換）──
  // iframe（または liveUrl のとき main document）内の <canvas> を MutationObserver
  // で観測し、d.commentCanvases にキャッシュする。RAF 内では配列を直接イテレート。
  function _refreshCanvasCache(url, doc) {
    const d = subData.get(url);
    if (!d) return;
    const cs = [];
    try {
      doc.querySelectorAll('canvas').forEach(c => {
        if (c === mainCanvas) return;          // メイン canvas（自前）
        if (c === d.canvas) return;            // バースロット canvas（自前）
        if (c.closest && c.closest('#nmv2-bar')) return; // 全バー canvas
        cs.push(c);
      });
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
        _mainVideoEl = document.querySelector('video') ?? null;
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
    // pseudo-fs モードでは leo-player を基準にする。
    // ニコ生内部の video 要素は height:auto の連鎖で leo-player 全高に届かない
    // ことがあるため、信頼性の高い leo-player の rect から
    // 「高さ＝leo-player 全高」「横位置・幅＝パネル状態に応じて切替」を組み立てる。
    if (_pseudoFullscreen) {
      const lp = _getLeoPlayer();
      if (lp) {
        const lpRect = lp.getBoundingClientRect();
        if (lpRect.width > 0 && lpRect.height > 0) {
          // パネル非表示時: leo-player 全域を使う
          if (_sideHidden) return lpRect;
          // パネル表示時: 横は video 要素に追従、縦は leo-player 全高に固定
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
      // （書き込むとニコ生 UI 側の表示が乱れたり、ライブ放送に副作用が出るため）
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
      const lvId = mainSrc.match(/lv\d+/)?.[0] ?? '';
      navBtn.title = `この放送をメインにする${lvId ? '（' + lvId + '）' : ''}`;
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
  }

  function hideMainCanvas() {
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

  // ─── ニコ生最大化のスロット被り対策 ──────────────────────
  // 診断で判明したこと:
  //   - 最大化フラグは #watchPage の data-player-layout-mode="full" 属性
  //   - leo-player はインラインスタイル無し → CSS !important で確実に勝てる
  //   - 既存コードは [class*="player-display"][data-layout-mode] を見ていたが、
  //     data-layout-mode は watchPage (祖先) に "liquid" として常に付いており、
  //     最大化検知としては誤りだった。
  (function () {
    const styleEl = document.createElement('style');
    styleEl.id = 'nmv2-maximize-guard';
    // CSS のみで leo-player を制約する。
    // セレクタ: data-player-layout-mode="full" を持つ祖先（watchPage）の
    // 子孫の leo-player に対して、サイズと位置を強制する。
    styleEl.textContent =
      `[data-player-layout-mode="full"] [class*="leo-player"]{` +
      `position:fixed!important;` +
      `top:0!important;left:0!important;right:0!important;` +
      `bottom:var(--nmv2-bar-h,192px)!important;` +
      `height:calc(100vh - var(--nmv2-bar-h,192px))!important;` +
      `max-height:calc(100vh - var(--nmv2-bar-h,192px))!important;` +
      `overflow:hidden!important;` +
      `z-index:2147483640!important;}`;
    document.head.appendChild(styleEl);
  })();

  // ─── 強制全画面モード（pseudo-fullscreen）─────────────────
  // ニコ生ネイティブの最大化（data-player-layout-mode="full"）はサブiframeの
  // コメント描画を停止させるため使えない。代替として body にクラスを付与し、
  // 静的CSSで leo-player をビューポート最大化する。
  (function () {
    const styleEl = document.createElement('style');
    styleEl.id = 'nmv2-pseudo-fs-style';
    // 注: 周辺UI非表示セレクタは推測。ニコ生のDOMが変わった場合は実機で再採取が必要。
    styleEl.textContent = [
      // ページ全体のスクロール抑止
      'body.nmv2-pseudo-fs{overflow:hidden!important;}',
      // leo-player をビューポート全面に固定（バー高さ分だけ下端を空ける）
      'body.nmv2-pseudo-fs [class*="leo-player"]{' +
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
      'body.nmv2-pseudo-fs [class*="leo-player"] video{' +
        'width:100%!important;height:100%!important;' +
        'object-fit:contain!important;' +
        'background:#000!important;' +
      '}',
      // 周辺UI（コメント入力欄・コメント一覧・番組情報パネル等）を非表示
      // :has() は Chromium 105+ で利用可。leo-player を含まない兄弟要素を畳む。
      'body.nmv2-pseudo-fs #watchPage > *:not(:has([class*="leo-player"])){' +
        'display:none!important;' +
      '}',
      // ニコ生最大化／全画面ボタンを非表示（独自ボタンがその直前に挿入されるため不要）。
      // display:none でスペースを詰める。querySelector() は display:none でも動作するため問題なし。
      'body.nmv2-pseudo-fs button[aria-label*="最大化"],' +
      'body.nmv2-pseudo-fs button[aria-label*="フルスクリーン"],' +
      'body.nmv2-pseudo-fs button[aria-label*="全画面"],' +
      'body.nmv2-pseudo-fs [class*="MaximizeButton"],' +
      'body.nmv2-pseudo-fs [class*="FullscreenButton"]{' +
        'display:none!important;' +
      '}',
      // pseudo-fs モードでは映像コンテナが leo-player 全高を常に埋めるよう強制する。
      // ニコ生内部は height:auto / aspect-ratio:16/9 / padding-top:56.25% などで
      // 自然サイズに留まる連鎖になっているため、それらを明示的に解除する。
      // :has(video) で video 要素の祖先 wrapper を一括捕捉（パネル・フッターは除外）。
      // 注意: [class*="player-display"] は [class*="player-display-footer"] にもマッチするため
      //       :not([class*="footer"]) で明示除外する（誤適用でコントロールバーが上端に飛ぶのを防ぐ）。
      'body.nmv2-pseudo-fs [class*="leo-player"] *:has(video):not([class*="player-status-panel"]):not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="video-display"]:not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="player-display"]:not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="player-display-screen"],' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="video-container"]:not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="VideoContainer"]:not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="player-area"]:not([class*="footer"]),' +
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="PlayerArea"]:not([class*="footer"]){' +
        'height:100%!important;' +
        'max-height:none!important;' +
        'min-height:0!important;' +
        'aspect-ratio:auto!important;' +
        'padding-top:0!important;' +
        'padding-bottom:0!important;' +
      '}',
      // コントロールバー（player-display-footer）は高さ制約ルールから除外し、
      // position:absolute で leo-player（position:fixed）の下端に固定する。
      'body.nmv2-pseudo-fs [class*="leo-player"] [class*="player-display-footer"]{' +
        'position:absolute!important;' +
        'bottom:0!important;left:0!important;width:100%!important;' +
        'height:auto!important;max-height:none!important;flex:none!important;' +
      '}',
      // シアターモードボタン・デフォルト表示ボタンは pseudo-fs 中に自動制御するため非表示にする
      'body.nmv2-pseudo-fs button[aria-label*="シアター"],' +
      'body.nmv2-pseudo-fs button[aria-label*="Theater"],' +
      'body.nmv2-pseudo-fs button[aria-label*="デフォルト"],' +
      'body.nmv2-pseudo-fs button[aria-label*="通常表示"],' +
      'body.nmv2-pseudo-fs button[aria-label*="小画面"],' +
      'body.nmv2-pseudo-fs [class*="TheaterButton"],' +
      'body.nmv2-pseudo-fs [class*="theaterButton"],' +
      'body.nmv2-pseudo-fs [class*="DefaultButton"],' +
      'body.nmv2-pseudo-fs [class*="defaultButton"]{' +
        'display:none!important;' +
      '}',
      // 右側エリア（player-status-panel）非表示トグル
      // ニコ生のクラスは ___player-status-panel___ のような難読化形式なので部分一致で拾う
      'body.nmv2-side-hidden [class*="player-status-panel"]{' +
        'display:none!important;' +
      '}',
      // パネル非表示時、leo-player 内の映像領域を最大化（flex/grid 兄弟が縮んだ分を埋める）。
      // :not([class*="footer"]) でコントロールバーを誤って対象にしないよう除外する。
      'body.nmv2-side-hidden [class*="leo-player"] [class*="video-display"]:not([class*="footer"]),' +
      'body.nmv2-side-hidden [class*="leo-player"] [class*="player-display"]:not([class*="footer"]),' +
      'body.nmv2-side-hidden [class*="leo-player"] [class*="video-container"]:not([class*="footer"]),' +
      'body.nmv2-side-hidden [class*="leo-player"] [class*="VideoContainer"]:not([class*="footer"]){' +
        'width:100%!important;height:100%!important;flex:1 1 auto!important;' +
      '}',
      // video 要素にもアスペクト比維持を適用（横幅が広がった際に縦が置いてかれないよう）
      'body.nmv2-side-hidden [class*="leo-player"] video{' +
        'width:100%!important;object-fit:contain!important;' +
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

  // ─── シアターモード制御 ──────────────────────────────────
  // pseudo-fs 開始時に自動でシアターモードに入り、終了時に元に戻す。
  function _getTheaterBtn() {
    return document.querySelector(
      'button[aria-label*="シアター"], button[aria-label*="Theater"], ' +
      '[class*="TheaterButton"], [class*="theaterButton"]'
    );
  }

  function enterTheaterModeIfNeeded() {
    if (_enteredTheaterMode) return;
    const btn = _getTheaterBtn();
    if (!btn) return;
    // aria-pressed="true" 等でシアターモード中かチェック。すでにアクティブなら何もしない。
    const isActive = btn.getAttribute('aria-pressed') === 'true' ||
                     btn.getAttribute('data-enable') === 'true';
    if (!isActive) {
      btn.click();
      _enteredTheaterMode = true;
    }
  }

  function exitTheaterModeIfNeeded() {
    if (!_enteredTheaterMode) return;
    _enteredTheaterMode = false;
    const btn = _getTheaterBtn();
    if (btn) btn.click();
  }

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

  // ─── 独自最大化ボタン（ニコ生最大化ボタン位置にオーバーレイ）──
  // ニコ生ネイティブの最大化ボタンは pseudo-fs 中は CSS で opacity:0 にしてあるため、
  // 同じ位置（getBoundingClientRect）に独自ボタンを重ねる。
  // 押下で _sideHidden を切り替え、コメント欄を畳んで映像を最大化する。

  function createCustomMaxBtn() {
    if (customMaxBtn) return;
    customMaxBtn = document.createElement('button');
    customMaxBtn.id = 'nmv2-custom-max-btn';
    customMaxBtn.type = 'button';
    // ニコ生コントロールバーの他のボタンに合わせたスタイル。
    // position:fixed は使わず、updateCustomMaxBtnPos() で orig の隣に DOM 挿入する。
    customMaxBtn.style.cssText = [
      'background:transparent',
      'color:#fff',
      'border:none',
      'border-radius:4px',
      'cursor:pointer',
      'padding:5px',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'font-size:20px',
      'line-height:1',
      'user-select:none',
      'box-sizing:border-box',
      'flex-shrink:0',
      'align-self:center',
    ].map(p => p + '!important').join(';') + ';';
    updateCustomMaxBtnLabel();
    customMaxBtn.addEventListener('mouseenter', () => {
      customMaxBtn.style.setProperty('background', 'rgba(255,255,255,0.15)', 'important');
    });
    customMaxBtn.addEventListener('mouseleave', () => {
      customMaxBtn.style.setProperty('background', 'transparent', 'important');
    });
    customMaxBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _sideHidden = !_sideHidden;
      document.body.classList.toggle('nmv2-side-hidden', _sideHidden);
      updateCustomMaxBtnLabel();
      // controlsBar 側の commentToggleBtn と状態同期（mainSrc!=='live' のとき存在）
      if (commentToggleBtn) {
        commentToggleBtn.style.setProperty('opacity', _sideHidden ? '0.5' : '1', 'important');
        commentToggleBtn.title = _sideHidden ? 'コメント欄を表示' : 'コメント欄を非表示';
      }
      setTimeout(() => repositionMainCanvas(), 150);
    });
    // DOM への追加は updateCustomMaxBtnPos() が orig の隣に挿入する
  }

  function updateCustomMaxBtnLabel() {
    if (!customMaxBtn) return;
    customMaxBtn.textContent = _sideHidden ? '⮌' : '⛶';
    customMaxBtn.title = _sideHidden ? '最大化を解除' : '最大化（コメント欄を隠す）';
  }

  // ─── ボタン挿入・Observer・interval ───────────────────────
  // ニコ生最大化ボタン（orig）は display:none だが DOM には残るため
  // querySelector / insertAdjacentElement は正常に動作する。
  const _ORIG_BTN_SEL =
    'button[aria-label*="最大化"], button[aria-label*="フルスクリーン"], ' +
    'button[aria-label*="全画面"], [class*="MaximizeButton"], [class*="FullscreenButton"]';

  function insertCustomMaxBtn() {
    if (!customMaxBtn || !_pseudoFullscreen || mainSrc !== 'live') return;
    const orig = document.querySelector(_ORIG_BTN_SEL);
    if (!orig || !orig.parentElement) {
      // controls bar がまだ DOM にない場合（ページ読み込み直後等）はリトライ
      setTimeout(insertCustomMaxBtn, 300);
      return;
    }
    if (customMaxBtn.previousElementSibling !== orig) {
      orig.insertAdjacentElement('beforebegin', customMaxBtn);
    }
    customMaxBtn.style.setProperty('display', 'flex', 'important');
    _watchCtrlBtn(orig.parentElement);
  }

  // controls bar（orig の親）を MutationObserver で監視し、
  // React の再レンダリングでボタンが消えたら自動再挿入する
  function _watchCtrlBtn(container) {
    if (_ctrlBtnObserver) return;
    _ctrlBtnObserver = new MutationObserver(() => {
      if (!_pseudoFullscreen || mainSrc !== 'live') return;
      if (customMaxBtn && !customMaxBtn.isConnected) insertCustomMaxBtn();
    });
    _ctrlBtnObserver.observe(container, { childList: true });
  }

  // forceLeoPlayerInnerHeight を Observer 駆動で実行（旧 300ms ポーリングを置換）。
  // - ResizeObserver: leo-player の外形変化（ウィンドウリサイズ・パネル開閉等）を捕捉
  // - MutationObserver(childList only): leo-player 直下の React 差し替えを捕捉
  //   注: subtree:true はコメント等の頻繁な DOM 変化で過剰発火するため使用しない
  // - 100ms debounce: 連発を抑制
  // - 既存値と同じならスタイル書き換えをスキップ（自己トリガーの再帰回避）
  function _scheduleForceHeight() {
    if (_forceHeightTimer) return;
    _forceHeightTimer = setTimeout(() => {
      _forceHeightTimer = 0;
      forceLeoPlayerInnerHeight();
    }, 100);
  }

  function startForceHeightObservers() {
    forceLeoPlayerInnerHeight(); // 初回適用
    const lp = _getLeoPlayer();
    if (!lp) return; // 後続の出現は pseudo-fs 再進入や setupMaximizeConstraint 経由で拾う
    if (!_forceHeightRO) {
      _forceHeightRO = new ResizeObserver(_scheduleForceHeight);
      _forceHeightRO.observe(lp);
    }
    if (!_forceHeightMO) {
      _forceHeightMO = new MutationObserver(_scheduleForceHeight);
      _forceHeightMO.observe(lp, { childList: true });
    }
  }

  function stopForceHeightObservers() {
    if (_forceHeightRO) { _forceHeightRO.disconnect(); _forceHeightRO = null; }
    if (_forceHeightMO) { _forceHeightMO.disconnect(); _forceHeightMO = null; }
    if (_forceHeightTimer) { clearTimeout(_forceHeightTimer); _forceHeightTimer = 0; }
  }

  // ② 対策: video から leo-player までの親要素チェーンに leo-player の実測高さを
  // インライン !important で強制する。
  //
  // 注意: display / flex-direction / position は変更しない。
  // ニコ生プレイヤーが flex-direction:column-reverse や CSS order 等で
  // コントロールバーを下端に配置している場合、それらを上書きすると
  // コントロールが画面上端へ飛ぶ原因になるため。
  function forceLeoPlayerInnerHeight() {
    if (!_pseudoFullscreen) return;
    const lp = _getLeoPlayer();
    if (!lp) return;
    const video = getVideoEl(liveUrl) || lp.querySelector('video');
    if (!video) return;
    const lpH = lp.getBoundingClientRect().height;
    if (lpH <= 0) return;

    const lpHpx = `${lpH}px`;
    let el = video.parentElement;
    let depth = 0;
    while (el && el !== lp && depth < 12) {
      const cls = ((el.className || '') + '');
      // 右パネルは縦伸ばし不要なため除外
      if (!cls.includes('player-status-panel')) {
        // 既存値と一致するなら書き換えをスキップ（不要な MutationRecord・reflow を回避）
        if (el.style.getPropertyValue('height') !== lpHpx ||
            el.style.getPropertyPriority('height') !== 'important') {
          el.style.setProperty('height',        lpHpx, 'important');
          el.style.setProperty('max-height',    lpHpx, 'important');
          el.style.setProperty('min-height',    '0',   'important');
          el.style.setProperty('aspect-ratio',  'auto','important');
          el.style.setProperty('padding-top',   '0',   'important');
          el.style.setProperty('padding-bottom','0',   'important');
        }
      }
      el = el.parentElement;
      depth++;
    }
  }

  // pseudo-fs 解除時に forceLeoPlayerInnerHeight() が付けたインラインスタイルを全て除去する。
  // 残留スタイルが通常モードのレイアウトを壊すのを防ぐ。
  function cleanLeoPlayerInnerHeight() {
    const lp = document.querySelector('[class*="leo-player"]');
    if (!lp) return;
    const video = lp.querySelector('video');
    if (!video) return;
    const props = ['height', 'max-height', 'min-height', 'aspect-ratio',
                   'padding-top', 'padding-bottom'];
    let el = video.parentElement;
    let depth = 0;
    while (el && el !== lp && depth < 12) {
      props.forEach(p => el.style.removeProperty(p));
      el = el.parentElement;
      depth++;
    }
  }

  function showCustomMaxBtn() {
    createCustomMaxBtn();
    updateCustomMaxBtnLabel();
    insertCustomMaxBtn();
    startForceHeightObservers();
  }

  function hideCustomMaxBtn() {
    stopForceHeightObservers();
    if (_ctrlBtnObserver) { _ctrlBtnObserver.disconnect(); _ctrlBtnObserver = null; }
    if (customMaxBtn) {
      customMaxBtn.style.setProperty('display', 'none', 'important');
      if (customMaxBtn.isConnected) customMaxBtn.remove();
    }
  }

  // ─── ニコ生最大化ボタンの無効化（二段構え）─────────────
  // (A) CSS で display:none （pseudo-fs style 内）
  // (B) MutationObserver + click ハンドラでクリックを握りつぶす（セレクタ変化への保険）
  function _nmv2StopMaximizeClick(e) {
    if (!_pseudoFullscreen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function _nmv2TagMaximizeButtons() {
    document.querySelectorAll(
      'button[aria-label*="最大化"], button[aria-label*="フルスクリーン"], ' +
      'button[aria-label*="全画面"], [class*="MaximizeButton"], [class*="FullscreenButton"]'
    ).forEach(btn => {
      if (btn.dataset.nmv2Disabled) return;
      btn.dataset.nmv2Disabled = '1';
      btn.addEventListener('click', _nmv2StopMaximizeClick, true);
    });
  }

  function disableNicoMaximizeButton() {
    _nmv2TagMaximizeButtons();
    if (_maxBtnObserver) return;
    _maxBtnObserver = new MutationObserver(_nmv2TagMaximizeButtons);
    _maxBtnObserver.observe(document.body, { childList: true, subtree: true });
  }

  function enableNicoMaximizeButton() {
    if (_maxBtnObserver) { _maxBtnObserver.disconnect(); _maxBtnObserver = null; }
    // click ハンドラは残置しても _pseudoFullscreen フラグで内部判定するので無害。
  }

  function setupMaximizeConstraint() {
    // watchPage の data-player-layout-mode 変化を検知して
    // _nmv2Fullscreen フラグとキャンバス位置を更新する
    const watchWatchPage = (wp) => {
      const update = () => {
        const state = wp.getAttribute('data-player-layout-mode') === 'full';
        if (_nmv2Fullscreen === state) return;
        _nmv2Fullscreen = state;
        _placeCanvasEls();
        repositionMainCanvas();
      };
      update();
      new MutationObserver(update).observe(wp, {
        attributes: true, attributeFilter: ['data-player-layout-mode'],
      });
    };
    const tryFind = () => {
      const wp = document.getElementById('watchPage')
              || document.querySelector('[data-player-layout-mode]');
      if (wp) { watchWatchPage(wp); return true; }
      return false;
    };
    if (!tryFind()) {
      const obs = new MutationObserver((_, o) => { if (tryFind()) o.disconnect(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ブラウザ Fullscreen API: バーを fullscreen 要素内に移動
    document.addEventListener('fullscreenchange', () => {
      // pseudo-fs 中は、ネイティブ Fullscreen と重畳しないようキャンセルする。
      // （pseudo-fs 起動中にユーザーが F11 等を押した場合の保険）
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

  // ─── スロットメタ情報（放送者名・サムネ・タイトル）─────────
  function extractSlotMeta(doc) {
    if (!doc) return null;
    try {
      const el = doc.getElementById('embedded-data');
      if (!el) return null;
      const data = JSON.parse(el.dataset.props ?? 'null');
      if (!data) return null;

      const program = data.program ?? {};
      const title   = program.title ?? '';
      const sp      = program.supplier    ?? {};
      const bc      = program.broadcaster ?? {};
      const sg      = data.socialGroup    ?? {};
      const us      = data.user           ?? {};

      const name = sp.name || bc.name || sg.name || us.nickname || us.name || '';

      const thumb =
        sp.icons?.uri50x50  ||
        sp.icons?.uri150x150 ||
        bc.iconUrl          ||
        sg.thumbnailUrl     ||
        doc.querySelector('a.user-thumbnail img')?.src ||
        '';

      if (!name && !title) return null;
      return { title, name, thumb };
    } catch (_) { return null; }
  }

  function updateSlotLabel(url) {
    const bar = document.getElementById('nmv2-bar');
    if (!bar) return;
    const slot = bar.querySelector(`.nmv2-slot[data-url="${CSS.escape(url)}"]`);
    if (!slot) return;
    const d = subData.get(url);
    if (!d?.meta) return;
    const { title, name, thumb } = d.meta;
    if (title) slot.title = title;
    const label = slot.querySelector('.nmv2-label');
    if (!label) return;
    label.innerHTML = '';
    if (thumb) {
      const img = document.createElement('img');
      img.src = thumb;
      img.style.cssText = 'width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;';
      img.onerror = () => { img.style.display = 'none'; };
      label.appendChild(img);
    }
    const nameEl = document.createElement('span');
    nameEl.textContent = name || url.match(/lv\d+/)?.[0] || url;
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

    // MutationObserver で #embedded-data の出現を即時検知（旧 setTimeout 多段ポーリングを置換）
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
    slot.title = _meta?.title || url.match(/lv\d+/)?.[0] || url;
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
    ctx.fillText(url.match(/lv\d+/)?.[0] ?? '...', SLOT_W / 2, SLOT_H / 2);

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
    if (_meta) {
      if (_meta.thumb) {
        const img = document.createElement('img');
        img.src = _meta.thumb;
        img.style.cssText = 'width:20px;height:20px;border-radius:50%;object-fit:cover;flex-shrink:0;';
        img.onerror = () => { img.style.display = 'none'; };
        label.appendChild(img);
      }
      const nameEl = document.createElement('span');
      nameEl.textContent = _meta.name || url.match(/lv\d+/)?.[0] || url;
      nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
      label.appendChild(nameEl);
    } else {
      const initSpan = document.createElement('span');
      initSpan.textContent = url.match(/lv\d+/)?.[0] ?? url;
      initSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
      label.appendChild(initSpan);
    }
    slot.appendChild(label);

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

  function createPlusSlot() {
    const plus = document.createElement('div');
    plus.className = 'nmv2-plus';
    plus.style.cssText = `
      width:${SLOT_W}px;height:${SLOT_H}px;flex:0 0 auto;
      display:flex;align-items:center;justify-content:center;
      border:2px dashed #666;background:#1a1a1a;
      color:#aaa;font-size:64px;cursor:default;
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
    subUrls.push(url);
    subData.set(url, { iframe: createHiddenIframe(url), canvas: null, rafId: null, meta: null });
    installAudioObserver(url);
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

    if (mainSrc === 'live' && !subData.has(liveUrl)) {
      subData.set(liveUrl, { iframe: null, canvas: null, rafId: null, meta: null });
      loadMetaAndUpdateSlot(liveUrl);
      installCanvasObserver(liveUrl);
    }

    subUrls = subUrls.map((u, i) => (i === barIdx ? prevMain : u));
    mainSrc = (subUrl === liveUrl) ? 'live' : subUrl;

    if (oldMainSrc !== 'live') hideMainCanvas();

    if (mainSrc === 'live') {
      uninstallCanvasObserver(liveUrl);
      subData.delete(liveUrl);
    } else {
      showMainCanvas(subUrl);
      // スワップ時はデフォルトでサイドパネルを非表示にして映像領域を最大化する。
      // コメントレイヤーは hideMainCanvas() でリセット済みのため初期表示状態は常に「表示」。
      if (!_sideHidden) {
        _sideHidden = true;
        document.body.classList.add('nmv2-side-hidden');
      }
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
    // 独自最大化ボタン: live 表示時は再挿入、sub 表示時は退避
    if (_pseudoFullscreen) {
      if (mainSrc === 'live') {
        setTimeout(insertCustomMaxBtn, 100);
      } else {
        if (customMaxBtn && customMaxBtn.isConnected) customMaxBtn.remove();
        if (_ctrlBtnObserver) { _ctrlBtnObserver.disconnect(); _ctrlBtnObserver = null; }
      }
    }
    persistState();
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
          subUrls = st.subs.filter(isNicoLiveUrl).slice(0, MAX_SUBS);
        }
      } catch (_) {}
    }

    // 「この放送をメインにする」ボタンによる遷移データを確認（30 秒以内）
    try {
      const got = await chrome.storage.local.get('nmv2_transfer');
      const tr  = got['nmv2_transfer'];
      if (tr && tr.to === liveUrl && Array.isArray(tr.subs) && Date.now() - tr.ts < 30000) {
        subUrls = tr.subs.filter(isNicoLiveUrl).slice(0, MAX_SUBS);
        // 音量を復元（各放送ごとの独立音量を引き継ぐ）
        if (tr.volumes && typeof tr.volumes === 'object') {
          for (const [u, v] of Object.entries(tr.volumes)) {
            if (typeof v === 'number' && v >= 0 && v <= 1 && isNicoLiveUrl(u)) {
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
    }

    setupGlobalDragReceiver();

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
