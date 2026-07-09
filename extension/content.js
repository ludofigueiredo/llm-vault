function extractSectionText(labelText) {
  const headings = document.querySelectorAll('h3');

  for (const heading of headings) {
    const headingText = heading.textContent.trim();
    if (headingText !== labelText) continue;

    let container = heading.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const paragraph = container.querySelector('p');
      if (paragraph && paragraph.textContent.trim()) {
        return paragraph.textContent.trim();
      }
      container = container.parentElement;
    }
  }

  return null;
}

function getProjectMetadata() {
  return {
    memory: extractSectionText('Mémoire'),
    instructions: extractSectionText('Instructions')
  };
}

function waitForCondition(checkFn, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const result = checkFn();
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function findFilesToggleButton() {
  return document.querySelector('[aria-label="Fichiers"]');
}

function isFilesSidebarOpen(toggleButton) {
  return toggleButton.getAttribute('aria-pressed') === 'true';
}

function findContenuSection() {
  const headings = document.querySelectorAll('h3');
  for (const heading of headings) {
    if (heading.textContent.trim() !== 'Contenu') continue;
    const container = heading.closest('.flex.flex-col.gap-3');
    if (container) return container;
  }
  return null;
}

function scrapeImageContentFiles() {
  const section = findContenuSection();
  if (!section) return [];

  const files = [];
  const images = section.querySelectorAll('img[src]');
  images.forEach((img) => {
    const alt = img.getAttribute('alt');
    const src = img.getAttribute('src');
    if (!alt || !src) return;
    const url = new URL(src, window.location.origin).href;
    files.push({ filename: alt, url });
  });
  return files;
}

async function getConversationArtifacts() {
  // Image attachments have a /preview URL that only exists in the DOM (not
  // derivable from the conversation JSON's /mnt/user-data paths), and that
  // DOM lives behind the Files sidebar's "Contenu" section — everything
  // else this extension needs (artifact filenames, uploaded non-image
  // filenames) comes from the conversation JSON instead (see
  // extractFilePaths in lib/api.js), so this is now the only thing left
  // to scrape here.
  // The content script can respond to PING (confirming injection) before
  // the page's own React app has rendered the Files toggle button, which
  // happens routinely right after a fresh navigation — bound-poll for it
  // rather than checking once, or every conversation visited early in a
  // project export's navigation phase would silently return zero images.
  const toggleButton = await waitForCondition(findFilesToggleButton, 3000, 150);
  if (!toggleButton) return { contentFiles: [] };

  const wasAlreadyOpen = isFilesSidebarOpen(toggleButton);
  if (!wasAlreadyOpen) toggleButton.click();

  await waitForCondition(findContenuSection, 3000, 150);
  const contentFiles = scrapeImageContentFiles();

  if (!wasAlreadyOpen) toggleButton.click();
  return { contentFiles };
}

let selectedProjectUuids = new Set();
const SELECTED_BORDER_CLASS = 'claude-exporter-selected';
let selectionClickListener = null;

function ensureSelectionStyle() {
  if (document.getElementById('claude-exporter-selection-style')) return;
  const style = document.createElement('style');
  style.id = 'claude-exporter-selection-style';
  style.textContent = `.${SELECTED_BORDER_CLASS} { outline: 3px solid red !important; outline-offset: -3px; }`;
  document.head.appendChild(style);
}

function findProjectListItems() {
  const list = document.querySelector('ul[aria-label="Projets"]');
  if (!list) return [];
  return [...list.querySelectorAll('li')];
}

function getProjectInfoFromListItem(li) {
  const link = li.querySelector('a[href^="/project/"]');
  if (!link) return null;
  const match = link.getAttribute('href').match(/\/project\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  if (!match) return null;
  const nameEl = link.querySelector('.truncate');
  const name = nameEl ? nameEl.textContent.trim() : match[1];
  return { uuid: match[1], name, link };
}

function toggleProjectSelection(li) {
  const info = getProjectInfoFromListItem(li);
  if (!info) return;

  if (selectedProjectUuids.has(info.uuid)) {
    selectedProjectUuids.delete(info.uuid);
    li.classList.remove(SELECTED_BORDER_CLASS);
  } else {
    selectedProjectUuids.add(info.uuid);
    li.classList.add(SELECTED_BORDER_CLASS);
  }
}

function handleSelectionClick(event) {
  const li = event.target.closest('li');
  if (!li) return;
  const list = document.querySelector('ul[aria-label="Projets"]');
  if (!list || !list.contains(li)) return;

  event.preventDefault();
  event.stopPropagation();
  toggleProjectSelection(li);
}

function startSelectionMode() {
  const list = document.querySelector('ul[aria-label="Projets"]');
  if (!list) return false;

  ensureSelectionStyle();
  selectedProjectUuids = new Set();
  selectionClickListener = handleSelectionClick;
  list.addEventListener('click', selectionClickListener, true);
  return true;
}

function getSelectedProjects() {
  const items = findProjectListItems();
  const results = [];
  for (const li of items) {
    const info = getProjectInfoFromListItem(li);
    if (info && selectedProjectUuids.has(info.uuid)) {
      results.push({ uuid: info.uuid, name: info.name });
    }
  }
  return results;
}

function stopSelectionMode() {
  const list = document.querySelector('ul[aria-label="Projets"]');
  if (list && selectionClickListener) {
    list.removeEventListener('click', selectionClickListener, true);
  }
  selectionClickListener = null;

  for (const li of findProjectListItems()) {
    li.classList.remove(SELECTED_BORDER_CLASS);
  }
  selectedProjectUuids = new Set();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'GET_PROJECT_METADATA') {
    sendResponse(getProjectMetadata());
    return false;
  }
  if (message && message.type === 'GET_CONVERSATION_ARTIFACTS') {
    getConversationArtifacts().then(sendResponse);
    return true;
  }
  if (message && message.type === 'START_SELECTION_MODE') {
    sendResponse({ armed: startSelectionMode() });
    return false;
  }
  if (message && message.type === 'GET_SELECTED_PROJECTS') {
    sendResponse(getSelectedProjects());
    return false;
  }
  if (message && message.type === 'STOP_SELECTION_MODE') {
    stopSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'PING') {
    sendResponse({ pong: true, pathname: window.location.pathname });
    return false;
  }
  return false;
});
