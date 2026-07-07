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

function findArtefactsHeading() {
  const headings = document.querySelectorAll('h3');
  for (const heading of headings) {
    if (heading.textContent.trim() === 'Artéfacts') return heading;
  }
  return null;
}

function findDownloadAllButton(artefactsHeading) {
  let container = artefactsHeading.parentElement;
  for (let i = 0; i < 5 && container; i++) {
    const buttons = container.querySelectorAll('button');
    for (const button of buttons) {
      if (button.textContent.includes('Tout télécharger')) return button;
    }
    container = container.parentElement;
  }
  return null;
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

  toggleButton.click();

  const artefactsHeading = await waitForCondition(findArtefactsHeading, 3000, 150);
  if (!artefactsHeading) {
    toggleButton.click();
    return null;
  }

  const downloadButton = findDownloadAllButton(artefactsHeading);
  if (!downloadButton) {
    toggleButton.click();
    return null;
  }

  window.postMessage({ source: CAPTURE_MESSAGE_SOURCE, type: 'ARM_CAPTURE' }, '*');
  downloadButton.click();
  const buffer = await waitForBlobCapture(10000);

  toggleButton.click();
  return buffer;
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

async function getConversationArtifacts() {
  const artifactsZip = await captureArtifactsZip();
  const contentFiles = scrapeContentFiles();
  return { artifactsZip, contentFiles };
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
  return false;
});
