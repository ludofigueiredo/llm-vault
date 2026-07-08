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

const CAPTURE_MESSAGE_SOURCE = 'claude-exporter';

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

function findArtefactsHeading() {
  const headings = document.querySelectorAll('h3');
  for (const heading of headings) {
    if (heading.textContent.trim() === 'Artéfacts') return heading;
  }
  return null;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function findDownloadAllButton(artefactsHeading) {
  let container = artefactsHeading.parentElement;
  for (let i = 0; i < 5 && container; i++) {
    const buttons = container.querySelectorAll('button');
    for (const button of buttons) {
      if (normalizeWhitespace(button.textContent).includes('Tout télécharger')) return button;
    }
    container = container.parentElement;
  }
  return null;
}

function findSingleArtifactDownloadButton(artefactsHeading) {
  let container = artefactsHeading.parentElement;
  for (let i = 0; i < 5 && container; i++) {
    const button = container.querySelector('button[aria-label^="Télécharger "]');
    if (button) return button;
    container = container.parentElement;
  }
  return null;
}

function armCaptureAndWait(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const listener = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== CAPTURE_MESSAGE_SOURCE) return;
      if (data.type === 'ARM_CAPTURE_ACK') {
        settled = true;
        window.removeEventListener('message', listener);
        resolve(true);
      }
    };
    window.addEventListener('message', listener);
    window.postMessage({ source: CAPTURE_MESSAGE_SOURCE, type: 'ARM_CAPTURE' }, '*');
    setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', listener);
        resolve(false);
      }
    }, timeoutMs);
  });
}

function waitForBlobCapture(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const listener = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== CAPTURE_MESSAGE_SOURCE) return;
      if (data.type === 'BLOB_CAPTURED') {
        settled = true;
        window.removeEventListener('message', listener);
        resolve(data.buffer);
      } else if (data.type === 'BLOB_CAPTURE_FAILED') {
        settled = true;
        window.removeEventListener('message', listener);
        resolve(null);
      }
    };
    window.addEventListener('message', listener);
    setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', listener);
        window.postMessage({ source: CAPTURE_MESSAGE_SOURCE, type: 'DISARM_CAPTURE' }, '*');
        resolve(null);
      }
    }, timeoutMs);
  });
}

async function captureArtifactsZip() {
  const toggleButton = findFilesToggleButton();
  if (!toggleButton) return null;

  const wasAlreadyOpen = isFilesSidebarOpen(toggleButton);
  if (!wasAlreadyOpen) toggleButton.click();

  const artefactsHeading = await waitForCondition(findArtefactsHeading, 3000, 150);
  if (!artefactsHeading) {
    if (!wasAlreadyOpen) toggleButton.click();
    return null;
  }

  let downloadButton = findDownloadAllButton(artefactsHeading);
  let singleArtifactFilename = null;
  if (!downloadButton) {
    // "Tout télécharger" only renders when there is more than one artifact —
    // with exactly one, fall back to that artifact's own download button.
    downloadButton = findSingleArtifactDownloadButton(artefactsHeading);
    if (downloadButton) {
      const label = downloadButton.getAttribute('aria-label') || '';
      singleArtifactFilename = label.replace(/^Télécharger\s+/, '').trim() || null;
    }
  }
  if (!downloadButton) {
    if (!wasAlreadyOpen) toggleButton.click();
    return null;
  }

  const armed = await armCaptureAndWait(2000);
  if (!armed) {
    if (!wasAlreadyOpen) toggleButton.click();
    return null;
  }
  downloadButton.click();
  const buffer = await waitForBlobCapture(10000);

  if (!wasAlreadyOpen) toggleButton.click();
  return { buffer, singleArtifactFilename };
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

function scrapeContentFiles() {
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

function findNonImageThumbnailButtons() {
  const section = findContenuSection();
  console.log('[claude-exporter] Contenu section found:', !!section);
  if (!section) return [];

  const buttons = [];
  const wrappers = section.querySelectorAll('[data-testid="file-thumbnail"]');
  console.log('[claude-exporter] non-image file-thumbnail wrappers found:', wrappers.length);
  wrappers.forEach((wrapper) => {
    const button = wrapper.querySelector('button');
    const heading = wrapper.querySelector('h3');
    if (!button || !heading) return;
    const filename = heading.textContent.trim();
    if (!filename) return;
    buttons.push({ button, filename });
  });
  console.log('[claude-exporter] non-image entries extracted:', buttons.map(b => b.filename));
  return buttons;
}

function findPreviewDownloadButton() {
  const buttons = document.querySelectorAll('button');
  for (const button of buttons) {
    if (normalizeWhitespace(button.textContent) === 'Télécharger') return button;
  }
  return null;
}

function findPreviewCloseButton() {
  return document.querySelector('[aria-label="Fermer"]');
}

async function captureNonImageContentFile(entry) {
  console.log('[claude-exporter] clicking non-image thumbnail:', entry.filename);
  entry.button.click();

  const downloadButton = await waitForCondition(findPreviewDownloadButton, 3000, 150);
  console.log('[claude-exporter] preview download button found:', !!downloadButton);
  if (!downloadButton) {
    const closeButton = findPreviewCloseButton();
    if (closeButton) closeButton.click();
    return null;
  }

  const armed = await armCaptureAndWait(2000);
  console.log('[claude-exporter] hook armed for', entry.filename, ':', armed);
  if (!armed) {
    const closeButton = findPreviewCloseButton();
    if (closeButton) closeButton.click();
    return null;
  }
  downloadButton.click();
  console.log('[claude-exporter] clicked preview Télécharger, waiting for blob...');
  const buffer = await waitForBlobCapture(10000);
  console.log('[claude-exporter] blob captured for', entry.filename, ':', !!buffer, buffer ? buffer.byteLength : 0);

  const closeButton = findPreviewCloseButton();
  if (closeButton) closeButton.click();
  return buffer;
}

async function captureNonImageContentFiles() {
  const entries = findNonImageThumbnailButtons();
  const results = [];
  for (const entry of entries) {
    const buffer = await captureNonImageContentFile(entry);
    if (buffer) results.push({ filename: entry.filename, buffer });
  }
  return results;
}

async function getConversationArtifacts() {
  const artifactsResult = await captureArtifactsZip();
  const contentFiles = scrapeContentFiles();
  const nonImageContentFiles = await captureNonImageContentFiles();
  return {
    artifactsZip: artifactsResult ? artifactsResult.buffer : null,
    singleArtifactFilename: artifactsResult ? artifactsResult.singleArtifactFilename : null,
    contentFiles,
    nonImageContentFiles
  };
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
