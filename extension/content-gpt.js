// GPT content script — injected on chatgpt.com. Fully independent of the
// Claude content.js. Uses DOM scraping for: multi-project selection on
// /projects (no API exposes that listing's row click targets, though the
// listing itself — including every project's real id — is available via
// gptGetAllProjectIds() below) and the project page's own conversation list
// (its "Chats" tab) — the user wants the project page to actually render
// and its conversations highlighted/visited one by one, rather than
// everything resolved invisibly through an API call. Project metadata
// (name/instructions) comes from the gizmos API (never fragile, no reason
// to DOM-scrape it), and conversation content/files are fetched from
// ChatGPT's internal /backend-api, called from this content script running
// in the page's own origin (so session cookies/token apply automatically,
// no separate auth needed). Navigating TO a selected project is now a
// plain URL navigation (see gptGetAllProjectIds), not a click on anything.

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
// once already on a project page (sidepanel.js navigates there directly by
// URL — see gptGetAllProjectIds) to call the gizmos API for that project,
// without needing a second DOM scrape. Mirrors gptDetectContext's
// 'project' pattern in gptDetect.js.
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

// Project metadata (name + instructions + the project's "Sources" file
// list) via the gizmos API, replacing the previous DOM-scrape that opened
// the project's details dialog to read input#project-name/
// textarea#instructions — that dialog flow was fragile (multi-step click
// sequence, 5s timeouts at each step) and the UI it depends on can change
// independently of this data actually being available directly from
// /backend-api/gizmos/<projectId>. The same response's top-level `files`
// array (not nested under `gizmo`) is each Sources-tab file's
// {file_id, name, ...} — language-independent, unlike scraping the
// Sources tab's own DOM, and it's already being fetched here for the
// name/instructions, so reading it too costs nothing extra.
async function gptGetProjectMetadata() {
  const fallback = { name: gptGetProjectTitle(), instructions: '', sources: [] };
  const projectId = gptGetProjectIdFromLocation();
  if (!projectId) return fallback;

  try {
    const token = await gptGetSessionToken();
    const resp = await gptApiGet(`gizmos/${projectId}?include_file_limits=true`, token);
    const gizmo = resp && resp.gizmo;
    if (!gizmo) return fallback;
    const sources = ((resp && resp.files) || [])
      .filter((f) => f && f.file_id)
      .map((f) => ({ fileId: f.file_id, name: f.name || f.file_id }));
    return {
      name: (gizmo.display && gizmo.display.name) || fallback.name,
      instructions: (gizmo.instructions || '').trim(),
      sources,
    };
  } catch (e) {
    return fallback;
  }
}

// Downloads every file listed in the project's "Sources" tab, via the same
// /backend-api/files/download/<fileId> endpoint used for conversation
// attachments (gptDownloadFile) — download_intent=true&gizmo_id=<projectId>
// is appended since that's confirmed (via a live test against this user's
// own project) to be what the download link request actually needs for a
// project-level source, as opposed to a conversation attachment.
async function gptDownloadProjectSources(projectId, sources) {
  if (!sources || sources.length === 0) return [];
  const token = await gptGetSessionToken();
  const usedNames = new Set();
  const files = [];
  for (const source of sources) {
    try {
      const dl = await gptDownloadFile(
        source.fileId, source.name, token, usedNames,
        `download_intent=true&gizmo_id=${encodeURIComponent(projectId)}`
      );
      files.push(dl);
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      // Skip this source; keep going — same tolerance as conversation
      // attachment downloads (gptGetConversationViaApi).
    }
  }
  return files;
}

// Conversation rows on a project page's "Chats" tab carry a real href:
// /g/g-p-<id>/c/<convId> (confirmed live — no "-<slug>" segment on this
// page, unlike some other ChatGPT conversation links elsewhere, so the
// slug is optional here to tolerate either shape).
function gptFindConversationLinks() {
  return [...document.querySelectorAll('a[href*="/c/"]')].filter((a) =>
    /\/g\/g-p-[a-f0-9]+(?:-[^/]*)?\/c\/[a-f0-9-]+/.test(a.getAttribute('href') || '')
  );
}

// Visual confirmation, mirroring the gold/amber selection highlight used
// elsewhere: outlines every conversation row found on the project page so
// a user watching the tab can see the extension found the right list
// before it starts visiting each one.
function gptHighlightConversationRows() {
  gptEnsureSelectionStyle();
  const links = gptFindConversationLinks();
  for (const a of links) a.classList.add(GPT_SELECTED_CLASS);
  return links.length;
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

// The project page can still be rendering its chat list a moment after
// GET_GPT_PROJECT_CONVERSATIONS is sent (e.g. just after navigation) — poll
// the link count until it stops growing (3 consecutive stable checks) or a
// timeout elapses, mirroring the stabilization pattern used by Claude's
// Recents "Select All" and ChatGPT's own earlier conversation-list scrape.
function gptWaitForListToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;
    const poll = () => {
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
  await gptWaitForListToStabilize(15000, 3, 500);
  gptHighlightConversationRows();
  return { conversations: gptScrapeConversationList() };
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

async function gptDownloadFile(fileId, fallbackName, token, usedNames, extraQuery) {
  const meta = await gptApiGet(`files/download/${fileId}${extraQuery ? `?${extraQuery}` : ''}`, token);
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

// Lists every one of the user's projects with its real g-p-<hex> id, via
// the same internal endpoint ChatGPT's own sidebar uses to render its
// project list. This replaces the previous approach entirely: there was
// no way to read a project's id from the /projects page's own DOM (no
// element exposes it), so navigating to a selected project required
// clicking a button on its row and either hoping the resulting client-side
// route change rendered the page, or forcing a reload once it didn't —
// both confirmed live to be unreliable (the click itself was intermittent
// even with different click-simulation strategies, and the page sometimes
// failed to render even once the click did land). Resolving ids up front
// means navigating to a selected project becomes a plain
// chrome.tabs.update to its real URL — an ordinary browser navigation,
// not a synthetic click — which has none of those failure modes.
// conversations_per_gizmo=0 keeps the response small since only the
// id/name pairing is needed here.
async function gptGetAllProjectIds() {
  const token = await gptGetSessionToken();
  const resp = await gptApiGet('gizmos/snorlax/sidebar?conversations_per_gizmo=0&limit=50&owned_only=true', token);
  const items = (resp && resp.items) || [];
  const idByName = new Map();
  for (const item of items) {
    // The response's per-item shape has been observed both as
    // {gizmo: {gizmo: {...}}} and {gizmo: {...}} depending on context —
    // unwrap defensively rather than assume one specific nesting.
    const g = (item && item.gizmo && item.gizmo.gizmo) || (item && item.gizmo);
    const name = g && g.display && g.display.name;
    if (g && g.id && name) {
      idByName.set(name.trim(), g.id);
    }
  }
  return idByName;
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

// Cheap, synchronous — used for the live "Confirm Selection (N)" count
// polled every 500ms while selection mode is active. Resolving project ids
// (gptGetSelectedProjectsWithIds below) does a network request, which is
// unnecessary overhead at that polling frequency and only actually needed
// once, at confirm time.
function gptGetSelectedProjects() {
  const results = [];
  for (const [index, name] of gptSelectedProjectsByIndex) {
    results.push({ index, name });
  }
  return results;
}

// Resolves each selected row's name to its real project id via the
// sidebar endpoint (gptGetAllProjectIds), so the caller can navigate there
// directly instead of needing to click anything on this page. A name that
// can't be resolved (sidebar fetch failed, or a name mismatch) is returned
// with id: null — the caller treats that project as failed rather than
// guessing.
async function gptGetSelectedProjectsWithIds() {
  const results = [];
  let idByName;
  try {
    idByName = await gptGetAllProjectIds();
  } catch (e) {
    idByName = new Map();
  }
  for (const [index, name] of gptSelectedProjectsByIndex) {
    results.push({ index, name, id: idByName.get(name) || null });
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
    if (message && message.type === 'DOWNLOAD_GPT_PROJECT_SOURCES') {
      // projectId comes from the current page's own URL, not the message —
      // the caller already navigated here for GET_GPT_PROJECT_METADATA, so
      // this content script is already on the right project's page.
      const projectId = gptGetProjectIdFromLocation();
      gptDownloadProjectSources(projectId, message.sources)
        .then((files) => sendResponse({ files }))
        .catch(() => sendResponse({ files: [] }));
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
    if (message && message.type === 'GET_GPT_SELECTED_PROJECTS_WITH_IDS') {
      gptGetSelectedProjectsWithIds().then(sendResponse);
      return true;
    }
    if (message && message.type === 'STOP_GPT_SELECTION_MODE') {
      gptStopSelectionMode();
      sendResponse({ stopped: true });
      return false;
    }
    return false;
  });
}

// Node export for pure-function tests only (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptStripCitations, gptExtractFileReferences, gptMappingToTurns };
}
