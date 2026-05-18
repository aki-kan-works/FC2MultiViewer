(function () {
  try { Object.defineProperty(window, 'top',         { get: function () { return window; }, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'parent',      { get: function () { return window; }, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'frameElement',{ get: function () { return null;   }, configurable: true }); } catch (_) {}

  // ─── AudioContext ミュートパッチ（サブiframeのゲーム・ギフト音対策）────
  // frame-content.js が data-nmv2-sub="1" をセットしてからこのスクリプトを注入するため、
  // 属性を読んで初期ミュート状態を決定できる。
  const _OrigAC = window.AudioContext || window.webkitAudioContext;
  if (!_OrigAC) return;

  const _gains = [];
  let _muted = document.documentElement.getAttribute('data-nmv2-sub') === '1';
  const _origDestDesc = Object.getOwnPropertyDescriptor(_OrigAC.prototype, 'destination');

  // content.js → frame-content.js(postMessage) → ここ(CustomEvent) の経路でミュート切替を受信
  document.addEventListener('nmv2-set-mute', function (e) {
    if (!e.detail || typeof e.detail.muted !== 'boolean') return;
    _muted = e.detail.muted;
    for (let i = 0; i < _gains.length; i++) {
      try { _gains[i].gain.value = _muted ? 0 : 1; } catch (_) {}
    }
  });

  // AudioContext をラップし、全出力をマスターゲインノード経由にする
  function _PatchedAC(...args) {
    const ctx = new _OrigAC(...args);
    try {
      const realDest = _origDestDesc ? _origDestDesc.get.call(ctx) : ctx.destination;
      const gain = ctx.createGain();
      gain.gain.value = _muted ? 0 : 1;
      gain.connect(realDest);
      _gains.push(gain);
      Object.defineProperty(ctx, 'destination', {
        get: function () { return gain; },
        configurable: true,
      });
    } catch (_) {}
    return ctx;
  }
  _PatchedAC.prototype = _OrigAC.prototype;
  Object.setPrototypeOf(_PatchedAC, _OrigAC);
  window.AudioContext = _PatchedAC;
  if (window.webkitAudioContext) window.webkitAudioContext = _PatchedAC;
})();
