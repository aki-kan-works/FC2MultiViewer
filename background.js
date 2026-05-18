chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'getTabId') {
    sendResponse(sender.tab ? sender.tab.id : null);
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab_' + tabId);
});
