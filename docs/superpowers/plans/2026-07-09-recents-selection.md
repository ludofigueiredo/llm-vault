# Recents Page Multi-Conversation Selection & Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user visually select an arbitrary set of conversations from `claude.ai/recents` (one-by-one, or all via auto-scroll) and export them into a single `.zip`, with the same completeness (text, artifacts, uploaded files, image content files) as project export.

**Architecture:** A new, fully independent selection mode in `extension/content.js` (separate message types/state from the existing `/projects` selection, since the two are mutually exclusive by URL but should not share failure modes), a new side-panel flow in `extension/sidepanel.js` that reuses the existing `fetchAllConversations`/`buildArtifactsDataByUuid`/`captureProjectConversationImages` helpers already built for project export, and one new zip-building function in `extension/lib/zipBuilder.js` plus one new markdown function in `extension/lib/markdown.js` for the project-less output structure.

**Tech Stack:** Vanilla JavaScript, Chrome Extension Manifest V3, no build step (see project CLAUDE.md).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no ES modules, no dynamic `import()` (all files loaded via `<script>` tags in `sidepanel.html`).
- Every new/changed function must degrade gracefully: a missing table, a failed individual conversation fetch/capture step, or the content script being unreachable must never crash the extension or abort the rest of an in-progress export.
- New message types must be named distinctly from the existing `/projects` selection messages (`START_SELECTION_MODE`, `GET_SELECTED_PROJECTS`, `STOP_SELECTION_MODE`) to avoid any ambiguity — use `START_RECENTS_SELECTION_MODE`, `GET_SELECTED_RECENTS_CONVERSATIONS`, `STOP_RECENTS_SELECTION_MODE`, `SELECT_ALL_RECENTS_CONVERSATIONS` exactly as named here.
- Do not reuse or interact with claude.ai's own native row-selection/checkbox UI (see design spec's Context section) — this feature's selection is a fully separate mechanism (red border via a custom CSS class, in-page `Set`).
- `createConversationsSelectionIndexMarkdown` must read `created_at`/`updated_at`/`model` from `conv.data`, NOT `conv.metadata` (unlike `createIndexMarkdown`, which reads from `conv.metadata` because project export's conversation list always has those fields populated from the `conversations_v2` API — this feature's selection only ever provides `{uuid, name}` per conversation, so `conv.metadata` lacks those fields; `conv.data` is always populated by the time this runs, since it comes from the already-fetched `conversations` array).

---

### Task 1: Manifest and side panel HTML

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/sidepanel.html`

**Interfaces:**
- Produces: `content.js` now injected on `claude.ai/recents`; three new buttons in the DOM (`select-recents-btn`, `select-all-recents-btn`, `confirm-recents-selection-btn`) for Task 6 to wire up.

- [ ] **Step 1: Add `claude.ai/recents` to the content script's matches**

In `extension/manifest.json`, find:

```json
  "content_scripts": [
    {
      "matches": ["https://claude.ai/project/*", "https://claude.ai/chat/*", "https://claude.ai/projects"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
```

Replace with:

```json
  "content_scripts": [
    {
      "matches": ["https://claude.ai/project/*", "https://claude.ai/chat/*", "https://claude.ai/projects", "https://claude.ai/recents"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
```

- [ ] **Step 2: Add the three new buttons to `sidepanel.html`**

In `extension/sidepanel.html`, find:

```html
  <button id="export-btn" style="display:none;"></button>
  <button id="select-projects-btn" style="display:none;">Select Projects</button>
  <button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
```

Replace with:

```html
  <button id="export-btn" style="display:none;"></button>
  <button id="select-projects-btn" style="display:none;">Select Projects</button>
  <button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
  <button id="select-recents-btn" style="display:none;">Select Conversations</button>
  <button id="select-all-recents-btn" style="display:none;">Select All</button>
  <button id="confirm-recents-selection-btn" style="display:none;">Confirm Selection (0)</button>
```

- [ ] **Step 3: Verify manifest.json is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json'))"`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension/sidepanel.html
git commit -m "feat: add recents page matches and selection UI buttons"
```

---

### Task 2: Content script — recents selection mode (manual toggle)

**Files:**
- Modify: `extension/content.js`

**Interfaces:**
- Consumes: `SELECTED_BORDER_CLASS`, `ensureSelectionStyle()` (both already defined in this file, reused as-is — no changes to them).
- Produces: `startRecentsSelectionMode()` → `boolean`, `getSelectedRecentsConversations()` → `Array<{uuid, name}>`, `stopRecentsSelectionMode()` → `void`. New message types `START_RECENTS_SELECTION_MODE`, `GET_SELECTED_RECENTS_CONVERSATIONS`, `STOP_RECENTS_SELECTION_MODE` wired into the existing `chrome.runtime.onMessage` listener.

- [ ] **Step 1: Add row-finding and info-extraction helpers**

In `extension/content.js`, add these functions right after `stopSelectionMode()` (the existing `/projects` selection cleanup function, which ends right before the `chrome.runtime.onMessage.addListener` block):

```javascript
let selectedRecentsUuids = new Set();
let recentsSelectionClickListener = null;

function findRecentsTable() {
  return document.querySelector('table[data-cds="Table"]');
}

function findRecentsRows() {
  const table = findRecentsTable();
  if (!table) return [];
  return [...table.querySelectorAll('tbody tr[data-hoverable]')];
}

function getConversationInfoFromRow(row) {
  const link = row.querySelector('a[href^="/chat/"]');
  if (!link) return null;
  const match = link.getAttribute('href').match(/\/chat\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  if (!match) return null;
  const name = link.getAttribute('aria-label') || match[1];
  return { uuid: match[1], name };
}
```

`findRecentsTable()` uses the `data-cds="Table"` attribute confirmed present in the captured DOM snapshot (`snippet-claude-website/all-conversations.html`) — this is the same design-system attribute pattern already relied on elsewhere in the page (e.g. `data-cds="Checkbox"` for the native, unused checkboxes). `getConversationInfoFromRow` mirrors `getProjectInfoFromListItem`'s exact shape (regex-validated UUID extraction, name fallback to the UUID itself if the label is somehow missing).

- [ ] **Step 2: Add toggle/click-handling/selection-mode start**

Add these functions right after the helpers from Step 1:

```javascript
function toggleRecentsSelection(row) {
  const info = getConversationInfoFromRow(row);
  if (!info) return;

  if (selectedRecentsUuids.has(info.uuid)) {
    selectedRecentsUuids.delete(info.uuid);
    row.classList.remove(SELECTED_BORDER_CLASS);
  } else {
    selectedRecentsUuids.add(info.uuid);
    row.classList.add(SELECTED_BORDER_CLASS);
  }
}

function handleRecentsSelectionClick(event) {
  const row = event.target.closest('tr[data-hoverable]');
  if (!row) return;
  const table = findRecentsTable();
  if (!table || !table.contains(row)) return;

  event.preventDefault();
  event.stopPropagation();
  toggleRecentsSelection(row);
}

function startRecentsSelectionMode() {
  const table = findRecentsTable();
  if (!table) return false;

  ensureSelectionStyle();
  selectedRecentsUuids = new Set();
  recentsSelectionClickListener = handleRecentsSelectionClick;
  table.addEventListener('click', recentsSelectionClickListener, true);
  return true;
}
```

This exactly mirrors `toggleProjectSelection`/`handleSelectionClick`/`startSelectionMode`'s structure, substituting the recents table/row shape for the projects list/item shape. `ensureSelectionStyle()` is reused unmodified — it only depends on `SELECTED_BORDER_CLASS`, which is shared.

- [ ] **Step 3: Add selection getter and mode-stop cleanup**

Add these functions right after `startRecentsSelectionMode()`:

```javascript
function getSelectedRecentsConversations() {
  const rows = findRecentsRows();
  const results = [];
  for (const row of rows) {
    const info = getConversationInfoFromRow(row);
    if (info && selectedRecentsUuids.has(info.uuid)) {
      results.push({ uuid: info.uuid, name: info.name });
    }
  }
  return results;
}

function stopRecentsSelectionMode() {
  const table = findRecentsTable();
  if (table && recentsSelectionClickListener) {
    table.removeEventListener('click', recentsSelectionClickListener, true);
  }
  recentsSelectionClickListener = null;

  for (const row of findRecentsRows()) {
    row.classList.remove(SELECTED_BORDER_CLASS);
  }
  selectedRecentsUuids = new Set();
}
```

- [ ] **Step 4: Wire the three new message types**

In `extension/content.js`'s `chrome.runtime.onMessage.addListener` block, find:

```javascript
  if (message && message.type === 'STOP_SELECTION_MODE') {
    stopSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'PING') {
```

Replace with:

```javascript
  if (message && message.type === 'STOP_SELECTION_MODE') {
    stopSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'START_RECENTS_SELECTION_MODE') {
    sendResponse({ armed: startRecentsSelectionMode() });
    return false;
  }
  if (message && message.type === 'GET_SELECTED_RECENTS_CONVERSATIONS') {
    sendResponse(getSelectedRecentsConversations());
    return false;
  }
  if (message && message.type === 'STOP_RECENTS_SELECTION_MODE') {
    stopRecentsSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'PING') {
```

(`SELECT_ALL_RECENTS_CONVERSATIONS` is added in Task 3, since it depends on the scroll-loop helper introduced there.)

- [ ] **Step 5: Verify no syntax errors**

Run: `node -c extension/content.js`
Expected: exits with no output.

- [ ] **Step 6: Commit**

```bash
git add extension/content.js
git commit -m "feat: add manual recents conversation selection mode"
```

---

### Task 3: Content script — "Select All" with auto-scroll

**Files:**
- Modify: `extension/content.js`

**Interfaces:**
- Consumes: `findRecentsRows()`, `selectedRecentsUuids`, `SELECTED_BORDER_CLASS`, `getConversationInfoFromRow()` (all from Task 2).
- Produces: `selectAllRecentsConversations()` → `Promise<number>` (final selected count). New message type `SELECT_ALL_RECENTS_CONVERSATIONS`.

- [ ] **Step 1: Add the scroll-until-stable helper**

In `extension/content.js`, add this function right after `stopRecentsSelectionMode()` (from Task 2):

```javascript
function waitForRowCountToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;

    const poll = () => {
      window.scrollTo(0, document.body.scrollHeight);
      const count = findRecentsRows().length;

      if (count === lastCount) {
        stableChecks++;
      } else {
        stableChecks = 0;
        lastCount = count;
      }

      if (stableChecks >= stableChecksRequired) {
        resolve(count);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(count);
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}
```

This is a new polling shape (distinct from the existing `waitForCondition`, which resolves on the FIRST truthy result rather than on stability across repeated checks) because "done scrolling" here means "the row count stopped growing," not "a single condition became true." Each poll iteration scrolls to the bottom (triggering claude.ai's lazy-load) then re-counts rows; `stableChecksRequired` consecutive unchanged counts (not just one) guards against a false-stable read during the brief window between a scroll trigger and the new rows actually rendering.

- [ ] **Step 2: Add the select-all function**

Add this function right after `waitForRowCountToStabilize()`:

```javascript
async function selectAllRecentsConversations() {
  const table = findRecentsTable();
  if (!table) return 0;

  ensureSelectionStyle();
  // 3 consecutive stable checks at 500ms apart (1.5s of no growth) before
  // concluding lazy-load has nothing more to give — long enough to absorb
  // claude.ai's own load latency, short enough not to stall the panel for
  // an account with a merely-large-but-finite history.
  await waitForRowCountToStabilize(30000, 3, 500);

  const rows = findRecentsRows();
  for (const row of rows) {
    const info = getConversationInfoFromRow(row);
    if (!info) continue;
    selectedRecentsUuids.add(info.uuid);
    row.classList.add(SELECTED_BORDER_CLASS);
  }
  return selectedRecentsUuids.size;
}
```

- [ ] **Step 3: Wire the new message type**

In `extension/content.js`'s `chrome.runtime.onMessage.addListener` block, find:

```javascript
  if (message && message.type === 'STOP_RECENTS_SELECTION_MODE') {
    stopRecentsSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'PING') {
```

Replace with:

```javascript
  if (message && message.type === 'STOP_RECENTS_SELECTION_MODE') {
    stopRecentsSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'SELECT_ALL_RECENTS_CONVERSATIONS') {
    selectAllRecentsConversations().then((count) => sendResponse({ count }));
    return true;
  }
  if (message && message.type === 'PING') {
```

- [ ] **Step 4: Verify no syntax errors**

Run: `node -c extension/content.js`
Expected: exits with no output.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js
git commit -m "feat: add Select All with auto-scroll for recents conversations"
```

---

### Task 4: Markdown — conversations-selection index

**Files:**
- Modify: `extension/lib/markdown.js`

**Interfaces:**
- Consumes: nothing new — same `conversationFolderName`/`sanitizeFilename` already in this file.
- Produces: `createConversationsSelectionIndexMarkdown(conversations)` → `string`.

- [ ] **Step 1: Add the new index-markdown function**

In `extension/lib/markdown.js`, add this function right after `createIndexMarkdown` (which ends at line 105):

```javascript
function createConversationsSelectionIndexMarkdown(conversations) {
  let markdown = `# Conversations Export\n\n`;
  markdown += `*Export Date: ${new Date().toLocaleString()}*\n`;
  markdown += `*Total Conversations: ${conversations.length}*\n\n`;
  markdown += `---\n\n`;
  markdown += `## Conversations\n\n`;

  // Unlike createIndexMarkdown (project export, where conv.metadata comes
  // from the conversations_v2 API and already has created_at/updated_at/
  // model), this selection's conv.metadata only ever has {uuid, name} —
  // read those fields from conv.data instead, the full conversation JSON
  // that's always present by the time this runs.
  const sorted = [...conversations].sort((a, b) =>
    new Date(b.data.updated_at) - new Date(a.data.updated_at)
  );

  sorted.forEach((conv, index) => {
    const folderName = conversationFolderName(conv);
    markdown += `${index + 1}. [${conv.metadata.name}](./${folderName}/conversation.md)\n`;
    markdown += `   - Created: ${new Date(conv.data.created_at).toLocaleDateString()}\n`;
    markdown += `   - Updated: ${new Date(conv.data.updated_at).toLocaleDateString()}\n`;
    markdown += `   - Model: ${conv.data.model}\n\n`;
  });

  return markdown;
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c extension/lib/markdown.js`
Expected: exits with no output.

- [ ] **Step 3: Commit**

```bash
git add extension/lib/markdown.js
git commit -m "feat: add createConversationsSelectionIndexMarkdown for recents export"
```

---

### Task 5: Zip builder — conversations-selection zip

**Files:**
- Modify: `extension/lib/zipBuilder.js`

**Interfaces:**
- Consumes: `createConversationsSelectionIndexMarkdown` (Task 4), `buildConversationFolder` (already defined in this file, unchanged), `conversationFolderName` (already used elsewhere in this file).
- Produces: `buildConversationsSelectionZip(conversations, artifactsDataByUuid)` → `Promise<Blob>`.

- [ ] **Step 1: Add the new zip-building function**

In `extension/lib/zipBuilder.js`, add this function right after `buildConversationZip` (the last function in the file, ending at line 59):

```javascript
async function buildConversationsSelectionZip(conversations, artifactsDataByUuid) {
  const zip = new JSZip();
  zip.file('index.md', createConversationsSelectionIndexMarkdown(conversations));

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    const artifactsData = (artifactsDataByUuid && artifactsDataByUuid.get(conv.metadata.uuid)) || { artifactFiles: [], contentFiles: [] };
    await buildConversationFolder(zip, folderName, conv, artifactsData);
  }

  return zip.generateAsync({ type: 'blob' });
}
```

This mirrors `buildProjectZip`'s per-conversation loop exactly (same `artifactsDataByUuid` lookup pattern, same fallback), but writes `index.md` at the zip root with no `memory.md`/`instructions.md`/`fichiers/` and no project subfolder — every conversation folder sits directly at the zip root.

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c extension/lib/zipBuilder.js`
Expected: exits with no output.

- [ ] **Step 3: Commit**

```bash
git add extension/lib/zipBuilder.js
git commit -m "feat: add buildConversationsSelectionZip for recents export"
```

---

### Task 6: Side panel — context detection, selection UI, and export orchestration

**Files:**
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `buildArtifactsDataByUuid`, `captureProjectConversationImages`, `waitForContentScriptReady`, `fetchAllConversations`, `getOrganizationId`, `sanitizeFilename` (all already defined/imported globally, unchanged) plus `buildConversationsSelectionZip` (Task 5).
- Produces: `isRecentsUrl(url)`, `enterRecentsSelectionMode()`, `pollRecentsSelectionCount()`, `selectAllRecents()`, `confirmRecentsSelection()`, `startRecentsExport(conversationsSelected)` — wired into `detectContext()` and the `DOMContentLoaded` button listeners.

- [ ] **Step 1: Add the URL detector**

In `extension/sidepanel.js`, add this function right after `isProjectsListingUrl` (which ends around line 15):

```javascript
function isRecentsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && parsed.pathname === '/recents';
  } catch (e) {
    return false;
  }
}
```

- [ ] **Step 2: Extend `detectContext()` with the new branch**

In `extension/sidepanel.js`'s `detectContext()`, find:

```javascript
  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');

  if (selectionMode || batchInProgress) {
```

Replace with:

```javascript
  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');
  const selectRecentsBtn = document.getElementById('select-recents-btn');
  const selectAllRecentsBtn = document.getElementById('select-all-recents-btn');
  const confirmRecentsSelectionBtn = document.getElementById('confirm-recents-selection-btn');

  if (selectionMode || batchInProgress || recentsSelectionMode) {
```

Then find:

```javascript
  } else if (isProjectsListingUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude Projects list detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    confirmSelectionBtn.style.display = 'none';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
  }
```

Replace with:

```javascript
  } else if (isProjectsListingUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude Projects list detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else if (isRecentsUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude recent conversations detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'block';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  }
```

(The three existing branches above this — `projectId`, `conversationId`, and the top of `isProjectsListingUrl`'s own branch — also need `selectRecentsBtn.style.display = 'none'`, `selectAllRecentsBtn.style.display = 'none'`, `confirmRecentsSelectionBtn.style.display = 'none'` added so the new buttons hide correctly when navigating to a project/conversation page. Add those three lines to the `if (projectId)` and `else if (conversationId)` branches the same way they're added above, right after each branch's existing `confirmSelectionBtn.style.display = 'none';` line.)

- [ ] **Step 3: Add the module-level state for recents selection**

In `extension/sidepanel.js`, find:

```javascript
let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;
let selectionMode = false;
let selectedProjects = [];
let batchInProgress = false;
```

Replace with:

```javascript
let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;
let selectionMode = false;
let selectedProjects = [];
let batchInProgress = false;
let recentsSelectionMode = false;
```

- [ ] **Step 4: Add the recents selection-mode entry/poll functions**

Add these functions right after `pollSelectionCount()` (the existing `/projects` selection poller, which ends right before `async function confirmSelection()`):

```javascript
async function enterRecentsSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_RECENTS_SELECTION_MODE' });
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the conversations list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }

  recentsSelectionMode = true;
  document.getElementById('select-recents-btn').style.display = 'none';
  document.getElementById('select-all-recents-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click conversation rows to select them, then click Confirm.';
  pollRecentsSelectionCount();
}

let recentsSelectionPollTimer = null;

function pollRecentsSelectionCount() {
  if (recentsSelectionPollTimer) clearInterval(recentsSelectionPollTimer);
  recentsSelectionPollTimer = setInterval(async () => {
    if (!recentsSelectionMode) {
      clearInterval(recentsSelectionPollTimer);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const conversations = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_RECENTS_CONVERSATIONS' });
      const count = Array.isArray(conversations) ? conversations.length : 0;
      document.getElementById('confirm-recents-selection-btn').textContent = `Confirm Selection (${count})`;
    } catch (e) {
      // Content script not reachable (e.g. user navigated away) — leave the
      // last known count displayed rather than erroring the panel.
    }
  }, 500);
}

async function selectAllRecents() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus('Scrolling to load all conversations...', '');
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SELECT_ALL_RECENTS_CONVERSATIONS' });
    const count = (response && response.count) || 0;
    document.getElementById('confirm-recents-selection-btn').textContent = `Confirm Selection (${count})`;
    setStatus(`Selected ${count} conversation(s).`, '');
  } catch (e) {
    setStatus('Could not select all conversations — try refreshing the page.', 'error');
  }
}
```

This mirrors `enterSelectionMode()`/`pollSelectionCount()`'s exact structure for the `/projects` equivalent, substituting the new recents message types and DOM IDs.

- [ ] **Step 5: Add the confirm/export orchestration function**

Add this function right after `selectAllRecents()`:

```javascript
async function confirmRecentsSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let selected = [];
  try {
    selected = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_RECENTS_CONVERSATIONS' });
  } catch (e) {
    selected = [];
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECENTS_SELECTION_MODE' });
  } catch (e) {
    // Best-effort cleanup — if this fails, the visual borders may linger on
    // the page until the next reload, but the export itself is unaffected.
  }

  if (recentsSelectionPollTimer) {
    clearInterval(recentsSelectionPollTimer);
    recentsSelectionPollTimer = null;
  }

  recentsSelectionMode = false;
  document.getElementById('select-all-recents-btn').style.display = 'none';
  document.getElementById('confirm-recents-selection-btn').style.display = 'none';

  if (!Array.isArray(selected) || selected.length === 0) {
    setStatus('No conversations were selected.', 'error');
    detectContext();
    return;
  }

  await startRecentsExport(selected);
}

async function startRecentsExport(conversationsSelected) {
  const selectBtn = document.getElementById('select-recents-btn');

  // Same guard as project export's navigation phase (runExport) and the
  // multi-project batch (startBatchExport): the navigation below is driven
  // by this function, not the user, so detectContext() must not reinterpret
  // it as the user browsing away mid-export.
  batchInProgress = true;
  exportBtnDisabledForBatch(true);

  try {
    setStatus('Resolving organization ID...', '');
    const orgId = await getOrganizationId();
    if (!orgId) {
      setStatus('Export failed: could not find your organization ID. Make sure you are logged into claude.ai.', 'error');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;

    setStatus(`Fetching ${conversationsSelected.length} conversation(s)...`, '');
    const conversations = await fetchAllConversations(orgId, conversationsSelected, (fetched, total) => {
      setStatus(`Fetched ${fetched}/${total} conversations...`, '');
    });

    if (conversations.length === 0) {
      setStatus('Export failed: could not fetch any of the selected conversations.', 'error');
      return;
    }

    const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);
    await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
      setStatus(`Capturing images ${current}/${total}: ${name}...`, '');
    });

    try {
      await chrome.tabs.update(tabId, { url: 'https://claude.ai/recents' });
    } catch (e) {
      // Best-effort return navigation — the export itself has already succeeded.
    }

    setStatus(`Building zip for ${conversations.length} conversation(s)...`, '');
    const blob = await buildConversationsSelectionZip(conversations, artifactsDataByUuid);
    const downloadFilename = `conversations_selection_${conversations.length}.zip`;

    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });

    let finalMessage = `✅ Exported ${conversations.length}/${conversationsSelected.length} conversation(s).`;
    if (conversations.length < conversationsSelected.length) {
      finalMessage += ` ${conversationsSelected.length - conversations.length} failed to fetch.`;
    }
    setStatus(finalMessage, 'success');
  } finally {
    batchInProgress = false;
    exportBtnDisabledForBatch(false);
    selectBtn.style.display = 'block';
    await detectContext();
  }
}
```

- [ ] **Step 6: Wire the three new buttons' click listeners**

In `extension/sidepanel.js`'s `DOMContentLoaded` listener, find:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
  document.getElementById('select-projects-btn').addEventListener('click', () => {
    enterSelectionMode();
  });
  document.getElementById('confirm-selection-btn').addEventListener('click', () => {
    confirmSelection();
  });
});
```

Replace with:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
  document.getElementById('select-projects-btn').addEventListener('click', () => {
    enterSelectionMode();
  });
  document.getElementById('confirm-selection-btn').addEventListener('click', () => {
    confirmSelection();
  });
  document.getElementById('select-recents-btn').addEventListener('click', () => {
    enterRecentsSelectionMode();
  });
  document.getElementById('select-all-recents-btn').addEventListener('click', () => {
    selectAllRecents();
  });
  document.getElementById('confirm-recents-selection-btn').addEventListener('click', () => {
    confirmRecentsSelection();
  });
});
```

- [ ] **Step 7: Verify no syntax errors**

Run: `node -c extension/sidepanel.js`
Expected: exits with no output.

- [ ] **Step 8: Manual verification checklist (no automated tests in this project)**

Document in the task report that the following must be manually verified against a live claude.ai session (cannot be verified in this sandboxed environment):
1. On `claude.ai/recents`, click "Select Conversations", click 2-3 rows — confirm red borders toggle correctly and "Confirm Selection (N)" updates live.
2. Click "Select All" on an account with enough history to trigger multiple lazy-load scrolls — confirm the page visibly scrolls and the final count matches the account's total conversation count.
3. Confirm with a small selection — confirm a `conversations_selection_<count>.zip` downloads with `index.md` plus one correctly populated folder per conversation.
4. Confirm existing `/projects` selection, single-project export, single-conversation export, and multi-project batch export still work unaffected (regression check on shared helpers).

- [ ] **Step 9: Commit**

```bash
git add extension/sidepanel.js
git commit -m "feat: wire recents selection UI and export orchestration"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing — pure documentation update reflecting Tasks 1-6's new feature.
- Produces: nothing — no code.

- [ ] **Step 1: Add a new subsection to `CLAUDE.md`**

Insert a new subsection right after the existing `### Multi-Project Batch Export` section in `CLAUDE.md` (read the file first to find that section's exact end point), titled `### Recents Page Multi-Conversation Selection`, describing: the independent selection mechanism (distinct message types from `/projects` selection, same red-border/Set pattern), the `Select All` auto-scroll behavior (`waitForRowCountToStabilize`, 3 consecutive stable checks), and that export reuses the same `fetchAllConversations`/`buildArtifactsDataByUuid`/`captureProjectConversationImages` helpers as project export, producing a project-less zip (`index.md` + one folder per conversation, no `memory.md`/`instructions.md`/`fichiers/`) via `buildConversationsSelectionZip`, downloaded as `conversations_selection_<count>.zip`.

- [ ] **Step 2: Update `README.md`**

Add a bullet to the feature list near the top (alongside the existing "Project export"/"Single conversation export"/"Multi-project batch export" bullets) describing this new capability, and a short "Exporting selected conversations from Recents" usage subsection (modeled on the existing "Batch-exporting multiple projects" subsection) plus an output-structure example (`conversations_selection_<count>.zip` containing `index.md` and per-conversation folders).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document recents page multi-conversation selection/export"
```
