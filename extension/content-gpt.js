// GPT content script — injected on chatgpt.com. Fully independent of the
// Claude content.js. Uses DOM scraping only for multi-project selection on
// /projects (no API exposes that listing) and to discover a selected
// project's id by navigating to its project page. Project metadata, a
// project's conversation list, and conversation content/files are all
// fetched from ChatGPT's internal /backend-api, called from this content
// script running in the page's own origin (so session cookies/token apply
// automatically, no separate auth needed).

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

// Extracts the g-p-<hex> project id from the current page's own URL — used
// once we're already on a project page (after gptNavigateProject) to call
// the gizmos API for that project, without needing a second DOM scrape.
// Mirrors gptDetectContext's 'project' pattern in gptDetect.js.
function gptGetProjectIdFromLocation() {
  const m = window.location.pathname.match(/^\/g\/(g-p-[a-f0-9]+)(?:-[^/]*)?\/(?:project|c)\b/);
  return m ? m[1] : null;
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

// Project metadata (name + instructions) via the gizmos API, replacing the
// previous DOM-scrape that opened the project's details dialog to read
// input#project-name/textarea#instructions — that dialog flow was fragile
// (multi-step click sequence, 5s timeouts at each step) and the UI it
// depends on can change independently of this data actually being
// available directly from /backend-api/gizmos/<projectId>.
async function gptGetProjectMetadata() {
  const fallback = { name: gptGetProjectTitle(), instructions: '' };
  const projectId = gptGetProjectIdFromLocation();
  if (!projectId) return fallback;

  try {
    const token = await gptGetSessionToken();
    const resp = await gptApiGet(`gizmos/${projectId}?include_file_limits=true`, token);
    const gizmo = resp && resp.gizmo;
    if (!gizmo) return fallback;
    return {
      name: (gizmo.display && gizmo.display.name) || fallback.name,
      instructions: (gizmo.instructions || '').trim(),
    };
  } catch (e) {
    return fallback;
  }
}

// Project's conversation list via the gizmos API, replacing the previous
// DOM-scrape (auto-scroll + stabilize + parse <a href> links) — that relied
// on the project page rendering every conversation as a real link, which
// broke once already (slug segment dropped from the href). The API gives
// {id, title} directly with no DOM/rendering dependency at all, and pages
// via `cursor` instead of scrolling.
async function gptGetProjectConversationsViaApi(projectId) {
  const token = await gptGetSessionToken();
  const conversations = [];
  let cursor = null;
  do {
    const query = `limit=50&owned_only=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const resp = await gptApiGet(`gizmos/${projectId}/conversations?${query}`, token);
    const items = (resp && resp.items) || [];
    for (const item of items) {
      if (!item || !item.id) continue;
      conversations.push({
        title: item.title || item.id,
        convId: item.id,
        url: `${window.location.origin}/g/${projectId}/c/${item.id}`,
      });
    }
    cursor = (resp && resp.cursor) || null;
  } while (cursor);
  return conversations;
}

async function gptGetProjectConversations() {
  const projectId = gptGetProjectIdFromLocation();
  if (!projectId) return { conversations: [] };
  const conversations = await gptGetProjectConversationsViaApi(projectId);
  return { conversations };
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
  // Same gold/amber highlight as Claude's project/recents selection (see
  // content.js's ensureSelectionStyle) for a consistent selection style
  // across both providers.
  style.textContent = `
    .${GPT_SELECTED_CLASS} {
      outline: 3px solid #B8874B !important;
      outline-offset: -3px !important;
      background-color: rgba(184, 135, 75, 0.16) !important;
      box-shadow: 0 4px 16px rgba(184, 135, 75, 0.4) !important;
    }
  `;
  document.head.appendChild(style);
}

// ChatGPT's projects-list markup changed (circa Oct 2026): rows are no
// longer a WAI-ARIA grid (`role="grid"`/`role="row"`/`role="gridcell"`).
// Each project is now a `[data-project-row-wrapper]` containing one
// `[data-project-row]` (the clickable header: icon, name, actions) followed
// by an inline, already-expanded list of the project's own conversations
// (`[role="list"][aria-label="Chats dans <name>"]` with `[role="listitem"]`
// rows) — so a selector scoped to just `[data-project-row]` elements is
// required to avoid also matching conversation rows nested inside.
function gptFindProjectsContainer() {
  // There's no single dedicated container element in the new markup (no
  // role="grid" equivalent) — document is used as the root and all lookups
  // below scope to [data-project-row] specifically, so this just needs to
  // exist to gate "are we on a page with a projects list at all".
  return document.querySelector('[data-project-row]') ? document.body : null;
}

function gptFindProjectRows() {
  return [...document.querySelectorAll('[data-project-row]')];
}

function gptRowName(row) {
  // The project name sits in a plain truncate span next to the
  // expand/collapse toggle button — distinct from a nested conversation
  // row's own truncate span, since this lookup is scoped to a
  // [data-project-row] element, which doesn't contain conversation rows
  // (those live as siblings inside the wrapper, not inside the row itself).
  const nameEl = row.querySelector('span.truncate');
  return nameEl ? nameEl.textContent.trim() : '';
}

function gptHandleSelectionClick(event) {
  const row = event.target.closest('[data-project-row]');
  if (!row) return;
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
  const container = gptFindProjectsContainer();
  if (!container) return false;
  gptEnsureSelectionStyle();
  gptSelectedProjectsByIndex = new Map();
  gptSelectionClickListener = gptHandleSelectionClick;
  container.addEventListener('click', gptSelectionClickListener, true);
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
  if (gptSelectionClickListener) {
    document.body.removeEventListener('click', gptSelectionClickListener, true);
  }
  gptSelectionClickListener = null;
  for (const row of gptFindProjectRows()) row.classList.remove(GPT_SELECTED_CLASS);
  gptSelectedProjectsByIndex = new Map();
}

// A plain el.click() doesn't always trigger React Router navigation on
// ChatGPT's project rows — React's synthetic event system expects a fuller
// pointer/mouse event sequence (pointerdown → mousedown → mouseup → click),
// each bubbling with isTrusted-like properties. Dispatching just 'click'
// works most of the time but is flaky under load; firing the whole sequence
// makes the click far more reliable.
function gptFireFullClick(el) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

function gptNavigateProject(index) {
  const rows = gptFindProjectRows();
  const row = rows[index];
  if (!row) return { navigated: false, name: '', reason: `no project row at index ${index}` };
  const name = gptRowName(row);

  // The new markup (circa Oct 2026) has no ARIA grid/row/gridcell roles and
  // no tabindex on the row, and the row itself is no longer a navigation
  // target at all: clicking the project name only toggles the row's own
  // inline-expanded conversation preview in place (confirmed live — it does
  // not change the URL), and the row's other buttons (pin, "..." menu,
  // expand/collapse toggle) don't navigate either. The one button that does
  // navigate to the dedicated project page (/g/g-p-<id>-<slug>/project) is
  // the "start a new chat in this project" button — confirmed live.
  // Navigating there is still required (not to scrape its DOM anymore — see
  // gptGetProjectConversations, now API-based — but to read the project id,
  // g-p-<hex>, out of the destination URL via gptGetProjectIdFromLocation(),
  // since no selectable-mode DOM element on /projects itself exposes that
  // id). ChatGPT's UI language follows the account/browser locale, so this
  // button's aria-label isn't always French — both observed labels
  // ("Démarrer un nouveau chat dans le projet" / "Start new chat in
  // project") are matched; a locale this doesn't cover will surface as a
  // "could not find..." error listing every label actually found in the
  // row (see below), making it easy to add.
  const newChatBtn = row.querySelector(
    'button[aria-label="Démarrer un nouveau chat dans le projet"], button[aria-label="Start new chat in project"]'
  );
  if (!newChatBtn) {
    // Surface every button aria-label actually present in this row — lets
    // the side panel's error log show directly whether ChatGPT renamed/
    // removed the button (wrong/missing label here) vs. the row having no
    // buttons at all yet (still rendering).
    const labels = [...row.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    return {
      navigated: false,
      name,
      reason: `could not find the project-navigation button (buttons found in row: [${labels.join(', ') || 'none'}])`,
    };
  }
  gptFireFullClick(newChatBtn);

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
    if (message && message.type === 'GET_GPT_PROJECT_ROW_COUNT') {
      // Diagnostic-only: lets the side panel's error log report how many
      // project rows were actually on the page at the moment a navigation
      // attempt failed, e.g. "index 2 requested but only 1 row found" (the
      // selected project disappeared/reordered) vs. "0 rows found" (the
      // page hadn't finished rendering).
      sendResponse({ count: gptFindProjectRows().length });
      return false;
    }
    return false;
  });
}

// Node export for pure-function tests only (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptStripCitations, gptExtractFileReferences, gptMappingToTurns };
}
