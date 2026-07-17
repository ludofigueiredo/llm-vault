// GPT content script — injected on chatgpt.com. Fully independent of the
// Claude content.js. Uses DOM scraping for project-scoped data (instructions,
// the project's conversation list, multi-project selection) and ChatGPT's
// internal /backend-api for conversation content and file downloads.

function gptWaitForCondition(checkFn, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const result = checkFn();
      if (result) { resolve(result); return; }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function gptStripCitations(str) {
  return str.replace(/【[^】]*】/g, '');
}

function gptExtractFileReferences(convo) {
  const refs = [];
  const seen = new Set();
  const mapping = convo.mapping || {};
  for (const node of Object.values(mapping)) {
    const msg = node && node.message;
    if (!msg) continue;
    if (msg.content && msg.content.parts) {
      for (const part of msg.content.parts) {
        if (part && part.content_type === 'image_asset_pointer' && part.asset_pointer) {
          const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            refs.push({ fileId: match[1], filename: 'image.png', type: 'image' });
          }
        }
      }
    }
    if (msg.metadata && msg.metadata.attachments) {
      for (const att of msg.metadata.attachments) {
        if (att.id && !seen.has(att.id)) {
          seen.add(att.id);
          refs.push({ fileId: att.id, filename: att.name || 'attachment', type: 'attachment' });
        }
      }
    }
    if (msg.metadata && msg.metadata.citations) {
      for (const cit of msg.metadata.citations) {
        const fileId = (cit.metadata && cit.metadata.file_id) || cit.file_id;
        const title = (cit.metadata && cit.metadata.title) || cit.title || 'citation';
        if (fileId && !seen.has(fileId)) {
          seen.add(fileId);
          refs.push({ fileId, filename: title, type: 'citation' });
        }
      }
    }
  }
  return refs;
}

function gptMappingToTurns(convo, fileMap) {
  fileMap = fileMap || {};
  const turns = [];
  const mapping = convo.mapping || {};
  const rootId = Object.keys(mapping).find((k) => mapping[k].parent == null);
  if (!rootId) return turns;

  const queue = [rootId];
  while (queue.length) {
    const nid = queue.shift();
    const node = mapping[nid] || {};
    const msg = node.message;
    if (msg && msg.content && msg.content.parts) {
      const role = (msg.author && msg.author.role) || 'unknown';
      const contentType = (msg.content && msg.content.content_type) || 'text';
      const skip =
        role === 'system' ||
        role === 'tool' ||
        (role === 'assistant' && contentType !== 'text');
      if (!skip) {
        const textParts = [];
        for (const part of msg.content.parts) {
          if (typeof part === 'string') {
            textParts.push(part);
          } else if (part && part.content_type === 'image_asset_pointer' && part.asset_pointer) {
            const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
            if (match && fileMap[match[1]]) {
              textParts.push(`![image](${fileMap[match[1]]})`);
            } else {
              textParts.push('[image]');
            }
          } else {
            textParts.push(JSON.stringify(part));
          }
        }
        if (msg.metadata && msg.metadata.attachments) {
          for (const att of msg.metadata.attachments) {
            if (att.id && fileMap[att.id]) {
              textParts.push(`\n📎 [${att.name || 'attachment'}](${fileMap[att.id]})`);
            }
          }
        }
        const text = gptStripCitations(textParts.join('\n')).trim();
        if (text) turns.push({ role: role === 'user' ? 'user' : 'assistant', markdown: text });
      }
    }
    queue.push(...((node.children) || []));
  }
  return turns;
}

function gptGetProjectTitle() {
  const h1Btn = document.querySelector('button[name="project-title"]');
  if (h1Btn) return h1Btn.textContent.trim();
  const h1 = document.querySelector('h1');
  return h1 ? h1.textContent.trim() : '';
}

function gptFindVisibleDetailsButton() {
  // The details button can be duplicated across responsive layouts; pick the
  // one that's actually rendered (offsetParent is null for display:none).
  const buttons = document.querySelectorAll('button[aria-label="Afficher les détails du projet"]');
  for (const btn of buttons) {
    if (btn.offsetParent !== null) return btn;
  }
  return buttons[0] || null;
}

function gptFindProjectSettingsMenuItem() {
  // The details button opens an intermediate menu; we want its
  // "Paramètres du projet" item, which opens the settings dialog.
  const items = document.querySelectorAll('[role="menuitem"]');
  for (const item of items) {
    if (item.textContent.trim() === 'Paramètres du projet') return item;
  }
  return null;
}

async function gptGetProjectMetadata() {
  const fallback = { name: gptGetProjectTitle(), instructions: '' };

  const detailsBtn = gptFindVisibleDetailsButton();
  if (!detailsBtn) return fallback;
  detailsBtn.click();

  // Step 1: the details button opens a menu — click its "Paramètres du
  // projet" item to reach the settings dialog (the dialog does not open
  // directly from the details button).
  const menuItem = await gptWaitForCondition(gptFindProjectSettingsMenuItem, 5000, 100);
  if (!menuItem) return fallback;
  menuItem.click();

  // Step 2: wait for the settings dialog with the name/instructions fields.
  const dialog = await gptWaitForCondition(
    () => document.querySelector('div[role="dialog"] input#project-name'),
    5000, 100
  );
  if (!dialog) return fallback;

  const nameInput = document.querySelector('div[role="dialog"] input#project-name');
  const instrArea = document.querySelector('div[role="dialog"] textarea#instructions');
  const result = {
    name: (nameInput && nameInput.value.trim()) || fallback.name,
    instructions: (instrArea && instrArea.value.trim()) || '',
  };

  const closeBtn = document.querySelector('div[role="dialog"] button[data-testid="close-button"]');
  if (closeBtn) closeBtn.click();

  return result;
}

function gptFindConversationLinks() {
  // Conversation rows on a project page carry a real href:
  // /g/g-p-<id>-<slug>/c/<convId>
  return [...document.querySelectorAll('a[href*="/c/"]')].filter((a) =>
    /\/g\/g-p-[a-f0-9]+-[^/]*\/c\/[a-f0-9-]+/.test(a.getAttribute('href') || '')
  );
}

function gptScrapeConversationList() {
  const seen = new Set();
  const conversations = [];
  for (const a of gptFindConversationLinks()) {
    const href = a.getAttribute('href');
    const m = href.match(/\/c\/([a-f0-9-]+)/);
    if (!m) continue;
    const convId = m[1];
    if (seen.has(convId)) continue;
    seen.add(convId);
    const titleEl = a.querySelector('.text-sm.font-medium');
    const title = (titleEl && titleEl.textContent.trim()) || convId;
    const url = new URL(href, window.location.origin).href;
    conversations.push({ title, convId, url });
  }
  return conversations;
}

function gptWaitForListToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;
    const poll = () => {
      window.scrollTo(0, document.body.scrollHeight);
      const count = gptFindConversationLinks().length;
      if (count === lastCount) { stableChecks++; }
      else { stableChecks = 0; lastCount = count; }
      if (stableChecks >= stableChecksRequired || Date.now() - start >= timeoutMs) {
        resolve(count); return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

async function gptGetProjectConversations() {
  await gptWaitForListToStabilize(30000, 3, 500);
  return { conversations: gptScrapeConversationList() };
}

let gptCachedToken = null;
let gptDeviceId = null;

async function gptGetSessionToken() {
  if (gptCachedToken) return gptCachedToken;
  const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json());
  if (!session || !session.accessToken) throw new Error('no ChatGPT session token');
  gptCachedToken = session.accessToken;
  return gptCachedToken;
}

function gptApiHeaders(token) {
  if (!gptDeviceId) gptDeviceId = crypto.randomUUID();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Oai-Device-Id': gptDeviceId,
    'Oai-Language': 'en-US',
  };
}

async function gptApiGet(path, token) {
  const resp = await fetch(`/backend-api/${path}`, {
    headers: gptApiHeaders(token),
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const GPT_MIME_TO_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/html': '.html', 'text/csv': '.csv',
  'application/json': '.json', 'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

function gptDeduplicateFilename(name, usedNames) {
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 1;
  while (usedNames.has(`${base}_${i}${ext}`)) i++;
  const deduped = `${base}_${i}${ext}`;
  usedNames.add(deduped);
  return deduped;
}

function gptBytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function gptDownloadFile(fileId, fallbackName, token, usedNames) {
  const meta = await gptApiGet(`files/download/${fileId}`, token);
  if (!meta || !meta.download_url) throw new Error('no download_url');
  const resp = await fetch(meta.download_url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim();
  let filename = meta.file_name || fallbackName || fileId;
  if (!filename.includes('.') && GPT_MIME_TO_EXT[contentType]) {
    filename += GPT_MIME_TO_EXT[contentType];
  }
  const finalName = gptDeduplicateFilename(filename, usedNames);
  return { filename: finalName, bytesBase64: gptBytesToBase64(bytes) };
}

async function gptGetConversationViaApi(convId) {
  const token = await gptGetSessionToken();
  const convo = await gptApiGet(`conversation/${convId}`, token);

  const refs = gptExtractFileReferences(convo);
  const usedNames = new Set();
  const files = [];
  const fileMap = {};
  for (const ref of refs) {
    try {
      const dl = await gptDownloadFile(ref.fileId, ref.filename, token, usedNames);
      files.push(dl);
      fileMap[ref.fileId] = `contenu-gpt/${dl.filename}`;
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      // Skip this file; keep going.
    }
  }

  const turns = gptMappingToTurns(convo, fileMap);
  return { title: convo.title || '', createTime: convo.create_time || null, turns, files };
}

const GPT_SELECTED_CLASS = 'llmvault-gpt-selected';
let gptSelectedProjectsByIndex = new Map(); // index -> name captured at click time
let gptSelectionClickListener = null;

function gptEnsureSelectionStyle() {
  if (document.getElementById('llmvault-gpt-style')) return;
  const style = document.createElement('style');
  style.id = 'llmvault-gpt-style';
  style.textContent = `.${GPT_SELECTED_CLASS} { outline: 2px solid #e74c3c !important; outline-offset: -2px; }`;
  document.head.appendChild(style);
}

function gptFindProjectGrid() {
  return document.querySelector('div[role="grid"][aria-label="Projets"]');
}

function gptFindProjectRows() {
  const grid = gptFindProjectGrid();
  if (!grid) return [];
  return [...grid.querySelectorAll('div[role="row"][data-page-table-selectable-row="true"]')];
}

function gptRowName(row) {
  const nameEl = row.querySelector('.text-token-text-primary.truncate');
  return nameEl ? nameEl.textContent.trim() : '';
}

function gptHandleSelectionClick(event) {
  const row = event.target.closest('div[role="row"][data-page-table-selectable-row="true"]');
  if (!row) return;
  const grid = gptFindProjectGrid();
  if (!grid || !grid.contains(row)) return;
  event.preventDefault();
  event.stopPropagation();
  const rows = gptFindProjectRows();
  const index = rows.indexOf(row);
  if (index < 0) return;
  if (gptSelectedProjectsByIndex.has(index)) {
    gptSelectedProjectsByIndex.delete(index);
    row.classList.remove(GPT_SELECTED_CLASS);
  } else {
    // Capture the name now, at click time, so a later list reorder can't
    // make the returned name disagree with what the user actually picked.
    gptSelectedProjectsByIndex.set(index, gptRowName(row));
    row.classList.add(GPT_SELECTED_CLASS);
  }
}

function gptStartSelectionMode() {
  const grid = gptFindProjectGrid();
  if (!grid) return false;
  gptEnsureSelectionStyle();
  gptSelectedProjectsByIndex = new Map();
  gptSelectionClickListener = gptHandleSelectionClick;
  grid.addEventListener('click', gptSelectionClickListener, true);
  return true;
}

function gptGetSelectedProjects() {
  const results = [];
  for (const [index, name] of gptSelectedProjectsByIndex) {
    results.push({ index, name });
  }
  return results;
}

function gptStopSelectionMode() {
  const grid = gptFindProjectGrid();
  if (grid && gptSelectionClickListener) {
    grid.removeEventListener('click', gptSelectionClickListener, true);
  }
  gptSelectionClickListener = null;
  for (const row of gptFindProjectRows()) row.classList.remove(GPT_SELECTED_CLASS);
  gptSelectedProjectsByIndex = new Map();
}

function gptNavigateProject(index) {
  const rows = gptFindProjectRows();
  const row = rows[index];
  if (!row) return { navigated: false, name: '' };
  const name = gptRowName(row);
  // The row's first gridcell is the clickable navigation target.
  const target = row.querySelector('[role="gridcell"]') || row;
  target.click();
  return { navigated: true, name };
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'PING') {
      sendResponse({ pong: true, pathname: window.location.pathname });
      return false;
    }
    if (message && message.type === 'GET_GPT_PROJECT_METADATA') {
      gptGetProjectMetadata().then(sendResponse);
      return true;
    }
    if (message && message.type === 'GET_GPT_PROJECT_CONVERSATIONS') {
      gptGetProjectConversations().then(sendResponse);
      return true;
    }
    if (message && message.type === 'GET_GPT_CONVERSATION_VIA_API') {
      gptGetConversationViaApi(message.convId).then(sendResponse).catch(() => sendResponse({ error: true }));
      return true;
    }
    if (message && message.type === 'START_GPT_SELECTION_MODE') {
      sendResponse({ armed: gptStartSelectionMode() });
      return false;
    }
    if (message && message.type === 'GET_GPT_SELECTED_PROJECTS') {
      sendResponse(gptGetSelectedProjects());
      return false;
    }
    if (message && message.type === 'STOP_GPT_SELECTION_MODE') {
      gptStopSelectionMode();
      sendResponse({ stopped: true });
      return false;
    }
    if (message && message.type === 'NAVIGATE_GPT_PROJECT') {
      sendResponse(gptNavigateProject(message.index));
      return false;
    }
    return false;
  });
}

// Node export for pure-function tests only (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptStripCitations, gptExtractFileReferences, gptMappingToTurns };
}
