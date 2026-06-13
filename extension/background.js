'use strict';

// Mooseflip Amazon helper — background service worker.
// Registers the right-click entry and forwards both it and the toolbar-icon
// click to the page's content script, which does the scraping + opens the tab.

const MENU_ID = 'mooseflip-search';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Search this book on Mooseflip',
    contexts: ['page', 'link', 'selection'],
    documentUrlPatterns: [
      '*://*.amazon.com/*',
      '*://*.amazon.co.uk/*',
      '*://*.amazon.ca/*',
    ],
  });
});

function trigger(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'mooseflip:open' }).catch(() => {
    // Content script not present (e.g. page loaded before install) — inject then retry.
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content.js'] })
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'mooseflip:open' }))
      .catch(() => {});
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) trigger(tab && tab.id);
});

chrome.action.onClicked.addListener((tab) => trigger(tab && tab.id));
