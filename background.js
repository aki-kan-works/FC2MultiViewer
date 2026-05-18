chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'getTabId') {
    sendResponse(sender.tab ? sender.tab.id : null);
    return true;
  }
  // サブ iframe の frame-content.js が検出した放送終了通知を
  // メインフレームの content.js（frameId:0）へ中継する
  if (msg && msg.type === 'nmv2-sub-ended' && sender.tab) {
    chrome.tabs.sendMessage(
      sender.tab.id,
      { type: 'nmv2-sub-ended', url: msg.url },
      { frameId: 0 }
    ).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab_' + tabId);
});
