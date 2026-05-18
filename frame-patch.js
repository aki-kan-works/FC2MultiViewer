(function () {
  try { Object.defineProperty(window, 'top',         { get: function () { return window; }, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'parent',      { get: function () { return window; }, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'frameElement',{ get: function () { return null;   }, configurable: true }); } catch (_) {}
})();
