chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PS_OPEN_PANEL') {
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  }
});
