# Multi-Project Visual Selection & Batch Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user visually select multiple projects on `claude.ai/projects` (red-border toggle on click), then batch-scrape them one at a time in the same tab, producing a single combined `.zip` with one subfolder per project.

**Architecture:** A content script arms a click-interception "selection mode" on the projects listing page, tracking selected UUIDs and drawing a red border. The side panel drives the batch: it reads the final selection, then loops — navigate the active tab to each project, wait for the page/content-script to be ready, run the existing project-export pipeline, and accumulate results into one shared `JSZip` (via a refactored `buildProjectZip` that nests into a caller-supplied folder instead of always producing its own root zip). One download at the end.

**Tech Stack:** Same as the existing extension — Manifest V3, vanilla JS, no build step, vendored JSZip.

## Global Constraints

- No build process, no new npm dependencies.
- No change to single-conversation export (`buildConversationZip`, `buildConversationFolder`) — untouched by this plan.
- Single-project export (today's "Export Project" button on a project page) must keep working identically after the `buildProjectZip` refactor — same output structure, byte-for-byte, for that call site.
- Every step must degrade gracefully: a project that fails to navigate to, or fails to fetch, is skipped (recorded in a failures list) and the batch continues — one bad project must never abort the whole batch.
- If the side panel is closed mid-batch, the in-progress operation is lost — accepted, no persistence attempted (per the spec's Non-goals).
- No automated test suite exists in this project; verification is manual (live claude.ai session) plus, where possible in this sandboxed implementation environment, Node syntax checks and code-review traces against the captured DOM snapshot `select_projects.html` (repo root).

---

## File Structure

```
extension/
  manifest.json              # MODIFIED: content_scripts matches extended to cover claude.ai/projects
  content.js                  # MODIFIED: add selection-mode logic + 3 new message types
  sidepanel.html               # MODIFIED: add "Select Projects" / "Confirm Selection" buttons
  sidepanel.js                  # MODIFIED: detect /projects context, drive selection UI + batch orchestration
  lib/
    zipBuilder.js                # MODIFIED: buildProjectZip signature change (zip, folderPath, ...)
```

---

## Task 1: Refactor `buildProjectZip` to nest into a caller-supplied zip/folder

**Files:**
- Modify: `extension/lib/zipBuilder.js`
- Modify: `extension/sidepanel.js` (update the single-project export call site)

**Interfaces:**
- Produces: `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata)` — no longer creates its own `JSZip` or calls `.generateAsync()`; the caller owns `zip` and generates the blob itself, exactly once, after all desired content has been added. `folderPath` is a string folder name to nest this project's contents under (empty string `''` means "at the root of `zip`", preserving today's single-project output exactly).
- Consumes (unchanged from before): `conversationFolderName`, `convertToMarkdown`, `createIndexMarkdown` from `lib/markdown.js`; the global `JSZip` class.

This is a pure refactor — no new capability in this task, just changing where the `JSZip` instance and folder nesting come from, so Task 5 (batch orchestration) can call this function once per selected project against one shared zip.

- [ ] **Step 1: Modify buildProjectZip in zipBuilder.js**

Read the current `extension/lib/zipBuilder.js` first. Replace the `buildProjectZip` function with:

```javascript
async function buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata) {
  const target = folderPath ? zip.folder(folderPath) : zip;

  target.file('index.md', createIndexMarkdown(projectId, conversations));

  if (projectMetadata && projectMetadata.memory) {
    target.file('memory.md', projectMetadata.memory);
  }
  if (projectMetadata && projectMetadata.instructions) {
    target.file('instructions.md', projectMetadata.instructions);
  }
  target.folder('fichiers').file('.gitkeep', '');

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    await buildConversationFolder(target, folderName, conv);
  }
}
```

Design notes for this exact implementation (do not deviate):
- `folderPath ? zip.folder(folderPath) : zip` — when `folderPath` is `''` (falsy), `target` is the passed-in `zip` itself, so `index.md`/`memory.md`/etc. land at its root exactly as they did in the pre-refactor version. When `folderPath` is a non-empty string (e.g. `'project_a1b2c3d4'`), `target` is a JSZip subfolder object, and every subsequent `.file(...)`/`.folder(...)` call on `target` is automatically nested under that path — this is standard JSZip folder-object behavior, not something this code has to manage manually.
- The function still returns a Promise (the `for` loop over conversations is async, since `buildConversationFolder` is async) — callers MUST `await buildProjectZip(...)`, they just no longer receive a `Blob` back from it. Blob generation is entirely the caller's responsibility now (via `zip.generateAsync({type: 'blob'})` on whatever root `zip` they created), so it can be called multiple times against the same `zip` (once per project in a batch) before generating once at the end.
- Do NOT rename or modify `buildConversationFolder` or `buildConversationZip` in this task — both are untouched, single-conversation export is out of scope for this whole plan.

- [ ] **Step 2: Update the single-project export call site in sidepanel.js**

In `extension/sidepanel.js`, locate this line inside the `exportMode === 'project'` branch of `runExport()`:
```javascript
      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      blob = await buildProjectZip(exportProjectId, conversations, projectMetadata);
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;
```
Replace it with:
```javascript
      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      const projectZip = new JSZip();
      await buildProjectZip(projectZip, '', exportProjectId, conversations, projectMetadata);
      blob = await projectZip.generateAsync({ type: 'blob' });
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;
```

This preserves the exact same output (`index.md`, `memory.md`/`instructions.md` if present, `fichiers/`, and every conversation subfolder, all at the zip root) — only the mechanics of how the zip/blob get created changed, not what ends up inside it.

- [ ] **Step 3: Verify both files are syntactically valid**

If Node is available:
```bash
node -c extension/lib/zipBuilder.js
node -c extension/sidepanel.js
```
Expected: no output from either command (success).

- [ ] **Step 4: Trace the refactor against the pre-existing single-project behavior**

By code review (no live browser available), write out in your report: for a project with 2 conversations and both `memory`/`instructions` present, trace through `new JSZip(); buildProjectZip(zip, '', 'proj-id', [conv1, conv2], {memory: 'm', instructions: 'i'})` and confirm the resulting `zip`'s file listing is IDENTICAL in paths to what the pre-refactor `buildProjectZip('proj-id', [conv1, conv2], {memory: 'm', instructions: 'i'})` would have produced internally before calling `.generateAsync()` — i.e. `index.md`, `memory.md`, `instructions.md`, `fichiers/.gitkeep`, `<conv1-folder>/conversation.md`, `<conv1-folder>/artefacts/.gitkeep`, `<conv1-folder>/contenu/.gitkeep`, and the same for conv2 — all at the zip root, no unexpected nesting.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/zipBuilder.js extension/sidepanel.js
git commit -m "refactor: buildProjectZip nests into a caller-supplied zip/folder instead of always creating its own root zip"
```

---

## Task 2: Content script — selection mode on the projects listing page

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/manifest.json`

**Interfaces:**
- Produces: three new message types handled by the existing `chrome.runtime.onMessage` listener in `content.js`:
  - `{type: 'START_SELECTION_MODE'}` — arms selection mode; response `{armed: boolean}` (`false` if the project list wasn't found).
  - `{type: 'GET_SELECTED_PROJECTS'}` — response `Array<{uuid: string, name: string}>` reflecting current selection (empty array if selection mode was never armed or nothing is selected).
  - `{type: 'STOP_SELECTION_MODE'}` — removes the listener and all visual borders; response `{stopped: true}`.

- [ ] **Step 1: Add selection-mode logic to content.js**

Read the current `extension/content.js` first (it currently ends with a `chrome.runtime.onMessage.addListener` block handling `GET_PROJECT_METADATA` and `GET_CONVERSATION_ARTIFACTS`). Add the following new code BEFORE that listener, and MODIFY the listener itself to also handle the three new message types:

```javascript
let selectionModeActive = false;
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
  const match = link.getAttribute('href').match(/\/project\/([a-f0-9-]{36})/);
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
  selectionModeActive = true;
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
  selectionModeActive = false;

  for (const li of findProjectListItems()) {
    li.classList.remove(SELECTED_BORDER_CLASS);
  }
  selectedProjectUuids = new Set();
}
```

Then MODIFY the existing listener at the bottom of the file from:
```javascript
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
```
to:
```javascript
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
  return false;
});
```

Design notes for this exact implementation (do not deviate):
- `findProjectListItems`/`getProjectInfoFromListItem` are based on the captured `select_projects.html` snapshot (repo root): the project list is `<ul role="list" aria-label="Projets">`, each project is an `<li>` containing an `<a href="/project/[uuid]">` whose child `<div class="truncate ...">` holds the display name (see snapshot lines 2, 7, 11).
- The click listener is attached with `true` for the `useCapture` argument (`list.addEventListener('click', handler, true)`) so it fires in the capture phase, BEFORE the link's own click handler (which would otherwise navigate) — this is what makes `event.preventDefault()`/`event.stopPropagation()` effective at blocking navigation. Do not remove the `true` argument or navigation-blocking will not reliably work.
- `event.target.closest('li')` finds the enclosing project `<li>` regardless of which exact child element (icon, text, whitespace) was clicked within the card — matches the spec's "clicking the card toggles it" requirement without requiring the user to click a precise sub-element.
- `toggleProjectSelection` adds/removes both the in-memory `Set` entry and the CSS class in the same call — these two must never drift apart (a UUID in the Set without the visual class, or vice versa, would be a bug), which is why they're always updated together in one function rather than two separate call sites.
- `getSelectedProjects()` re-derives its return value fresh from the current DOM + `selectedProjectUuids` on every call rather than caching a separate list — this avoids the two representations (DOM state via CSS class, and the `Set`) ever needing manual reconciliation; the `Set` is the single source of truth for "is this selected," and the DOM traversal just looks up display names for the currently-selected UUIDs.
- `stopSelectionMode()` unconditionally strips the CSS class from every list item (not just ones currently in `selectedProjectUuids`) as a defensive cleanup, and resets the module-level `selectedProjectUuids` to a fresh empty `Set` — ensures no stale state leaks into a hypothetical future `START_SELECTION_MODE` call without a page reload in between.
- None of `startSelectionMode`/`getSelectedProjects`/`stopSelectionMode` throw under any DOM state (missing list, empty list, list present but no matching `<li>`s) — each guards with an early return/empty-result rather than assuming the list exists.

- [ ] **Step 2: Extend manifest.json's content.js entry to also match the projects listing page**

Modify `extension/manifest.json`'s content_scripts entry for `content.js` (NOT the `main-world-hook.js` entry, which stays untouched). Change:
```json
    {
      "matches": ["https://claude.ai/project/*", "https://claude.ai/chat/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
```
to:
```json
    {
      "matches": ["https://claude.ai/project/*", "https://claude.ai/chat/*", "https://claude.ai/projects"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
```

Note: `https://claude.ai/projects` (no trailing `/*`) — the listing page is at the exact path `/projects` with no further segments, unlike `/project/*` (singular, with a UUID after it). Do not add a wildcard here; an exact match is correct and intentional, matching how claude.ai structures this URL.

- [ ] **Step 3: Verify manifest.json is still valid JSON and content.js is syntactically valid**

If Node is available:
```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8')); console.log('valid JSON')"
node -c extension/content.js
```
Expected: `valid JSON` printed, and no output from the syntax check (success).

- [ ] **Step 4: Trace the selection logic against select_projects.html**

Read `select_projects.html` (repo root) and write out in your report:
- Confirm `document.querySelector('ul[aria-label="Projets"]')` matches the `<ul>` at line 2.
- For the first project `<li>` (lines 4-29, "Keensight", `href="/project/019e6e02-4759-7377-85e4-f78695be6f02"`), confirm `getProjectInfoFromListItem` correctly extracts `{uuid: '019e6e02-4759-7377-85e4-f78695be6f02', name: 'Keensight'}` — trace the regex match against the href and confirm `.truncate` finds the name div at line 11.
- Same trace for the second project (lines 30-55, "TEst", uuid `019f3d92-7045-7607-a0cd-29c4b65c70f8`).
- Confirm a click anywhere within the first `<li>` (e.g. on the `<a>` at line 7, or the inner `<div>` at line 11) would resolve via `event.target.closest('li')` to the same `<li>` element (line 4), so both toggle the same project regardless of the exact click target.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js extension/manifest.json
git commit -m "feat: add project selection mode to content script for claude.ai/projects"
```

---

## Task 3: Side panel — detect /projects context and show Select/Confirm buttons

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `START_SELECTION_MODE`, `GET_SELECTED_PROJECTS`, `STOP_SELECTION_MODE` message contract from Task 2.
- Produces: new global state (`selectionMode`, `selectedProjects`) and two new button elements (`select-projects-btn`, `confirm-selection-btn`) wired up so the panel can transition into and out of selection mode. Exposes a `startBatchExport(selectedProjects)` function STUB (implemented fully in Task 5) so this task's UI wiring is testable/committable independently.

- [ ] **Step 1: Add the new buttons to sidepanel.html**

In `extension/sidepanel.html`, locate:
```html
  <div id="context-message"></div>
  <button id="export-btn" style="display:none;"></button>
  <div id="status"></div>
```
Replace it with:
```html
  <div id="context-message"></div>
  <button id="export-btn" style="display:none;"></button>
  <button id="select-projects-btn" style="display:none;">Select Projects</button>
  <button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
  <div id="status"></div>
```

- [ ] **Step 2: Extend detectContext() in sidepanel.js to detect the projects listing page**

In `extension/sidepanel.js`, add this helper function near the top of the file, right after the existing `let exportMode = ...` / `let exportProjectId = ...` / `let exportConversationId = ...` declarations:

```javascript
let selectionMode = false;
let selectedProjects = [];

function isProjectsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && parsed.pathname === '/projects';
  } catch (e) {
    return false;
  }
}
```

Then modify `detectContext()`. The current function reads:
```javascript
async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');

  const projectId = getProjectIdFromUrl(url);
  const conversationId = getConversationIdFromUrl(url);

  if (projectId) {
    exportMode = 'project';
    exportProjectId = projectId;
    contextMessage.textContent = 'Claude Project detected.';
    exportBtn.textContent = 'Export Project';
    exportBtn.style.display = 'block';
  } else if (conversationId) {
    exportMode = 'conversation';
    exportConversationId = conversationId;
    contextMessage.textContent = 'Claude Conversation detected.';
    exportBtn.textContent = 'Export Conversation';
    exportBtn.style.display = 'block';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
  }
}
```

Replace it with:
```javascript
async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');

  if (selectionMode) {
    // Don't clobber the selection-mode UI while a selection is in progress —
    // context re-detection from tab-switch listeners must not interrupt it.
    return;
  }

  const projectId = getProjectIdFromUrl(url);
  const conversationId = getConversationIdFromUrl(url);

  if (projectId) {
    exportMode = 'project';
    exportProjectId = projectId;
    contextMessage.textContent = 'Claude Project detected.';
    exportBtn.textContent = 'Export Project';
    exportBtn.style.display = 'block';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
  } else if (conversationId) {
    exportMode = 'conversation';
    exportConversationId = conversationId;
    contextMessage.textContent = 'Claude Conversation detected.';
    exportBtn.textContent = 'Export Conversation';
    exportBtn.style.display = 'block';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
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
}
```

Design notes:
- The early `if (selectionMode) return;` guard is critical: `detectContext()` is already called by the existing `chrome.tabs.onActivated`/`onUpdated` listeners (from a prior phase) whenever the user switches tabs — but during an active selection (Task 4) or an in-progress batch (Task 5), those tab changes are EXPECTED (the batch itself drives navigation) and must not reset the panel back to a plain "Select Projects" button, wiping out the in-progress selection/batch state and UI.

- [ ] **Step 3: Wire the Select Projects and Confirm Selection buttons**

In `extension/sidepanel.js`, locate the existing `document.addEventListener('DOMContentLoaded', ...)` block:
```javascript
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
});
```
Replace it with:
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

async function enterSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION_MODE' });
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the project list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }

  selectionMode = true;
  document.getElementById('select-projects-btn').style.display = 'none';
  document.getElementById('confirm-selection-btn').style.display = 'block';
  document.getElementById('confirm-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click project cards to select them, then click Confirm.';
  pollSelectionCount();
}

let selectionPollTimer = null;

function pollSelectionCount() {
  if (selectionPollTimer) clearInterval(selectionPollTimer);
  selectionPollTimer = setInterval(async () => {
    if (!selectionMode) {
      clearInterval(selectionPollTimer);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const projects = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_PROJECTS' });
      const count = Array.isArray(projects) ? projects.length : 0;
      document.getElementById('confirm-selection-btn').textContent = `Confirm Selection (${count})`;
    } catch (e) {
      // Content script not reachable (e.g. user navigated away) — leave the
      // last known count displayed rather than erroring the panel.
    }
  }, 500);
}

async function confirmSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let projects = [];
  try {
    projects = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_PROJECTS' });
  } catch (e) {
    projects = [];
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SELECTION_MODE' });
  } catch (e) {
    // Best-effort cleanup — if this fails, the visual borders may linger on
    // the page until the next reload, but the batch itself is unaffected.
  }

  if (selectionPollTimer) {
    clearInterval(selectionPollTimer);
    selectionPollTimer = null;
  }

  selectionMode = false;
  document.getElementById('confirm-selection-btn').style.display = 'none';

  if (!Array.isArray(projects) || projects.length === 0) {
    setStatus('No projects were selected.', 'error');
    detectContext();
    return;
  }

  selectedProjects = projects;
  await startBatchExport(selectedProjects);
}

async function startBatchExport(projects) {
  setStatus(`Batch export not yet implemented (would process ${projects.length} project(s)).`, 'error');
}
```

Design notes:
- `pollSelectionCount()` uses a 500ms `setInterval` poll rather than a push-based mechanism (e.g. the content script proactively messaging the panel on every click) — simpler to implement correctly given `chrome.tabs.sendMessage` is the panel-initiated request/response pattern already used everywhere else in this codebase, and 500ms is frequent enough to feel responsive without hammering the message-passing boundary on every single click.
- `startBatchExport` is an intentional STUB in this task — it exists so `confirmSelection()` has something to call and this task's UI flow (arm → see live count → confirm → see a placeholder outcome) is fully testable on its own, without waiting on Task 5. Task 5 REPLACES this stub's body entirely; the function name and single `projects` parameter (an `Array<{uuid, name}>`) are the exact interface Task 5 must implement.
- `confirmSelection()` always attempts `STOP_SELECTION_MODE` (even if `GET_SELECTED_PROJECTS` failed) as best-effort DOM cleanup, matching this extension's established pattern of never letting one failed step block the rest of a flow.

- [ ] **Step 4: Verify sidepanel.js is syntactically valid**

If Node is available:
```bash
node -c extension/sidepanel.js
```
Expected: no output (success).

- [ ] **Step 5: Trace the UI flow by code review**

Since no live browser is available, write out in your report a trace of: (a) panel opened on `claude.ai/projects` — confirm `detectContext()` shows "Select Projects" button, hides "Export"/"Confirm Selection"; (b) "Select Projects" clicked — confirm `enterSelectionMode()` sends `START_SELECTION_MODE`, and on a truthy `{armed: true}` response, shows "Confirm Selection (0)" and starts polling; (c) polling tick — confirm it calls `GET_SELECTED_PROJECTS` and updates the button text with the count; (d) "Confirm Selection" clicked with 2 projects selected — confirm `confirmSelection()` fetches the final list, stops selection mode, and calls `startBatchExport` with an array of 2 `{uuid, name}` objects.

- [ ] **Step 6: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "feat: add Select Projects / Confirm Selection UI to side panel"
```

---

## Task 4: Wait-for-content-script-ready helper

**Files:**
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Produces: `waitForContentScriptReady(tabId, timeoutMs)` — polls `chrome.tabs.sendMessage(tabId, {type: 'PING'})` until it resolves successfully or `timeoutMs` elapses, returning `true`/`false`. Requires `content.js` to respond to a new lightweight `PING` message type.
- Consumes: nothing new from other tasks; this is a standalone utility Task 5 will call.

This task exists as its own step (rather than folded into Task 5) because it touches BOTH `content.js` (a new trivial message handler) and `sidepanel.js` (the polling logic), and is independently testable/reviewable before being wired into the full batch loop.

**Files (continued):**
- Modify: `extension/content.js`

- [ ] **Step 1: Add a PING handler to content.js**

In `extension/content.js`, modify the `chrome.runtime.onMessage.addListener` block (from Task 2) to add one more branch. It currently ends with:
```javascript
  if (message && message.type === 'STOP_SELECTION_MODE') {
    stopSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  return false;
});
```
Change it to:
```javascript
  if (message && message.type === 'STOP_SELECTION_MODE') {
    stopSelectionMode();
    sendResponse({ stopped: true });
    return false;
  }
  if (message && message.type === 'PING') {
    sendResponse({ pong: true });
    return false;
  }
  return false;
});
```

- [ ] **Step 2: Add waitForContentScriptReady to sidepanel.js**

In `extension/sidepanel.js`, add this function anywhere after the existing `setStatus` function definition:
```javascript
function waitForContentScriptReady(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = async () => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (response && response.pong) {
          resolve(true);
          return;
        }
      } catch (e) {
        // Not ready yet — content script hasn't injected on the new page.
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}
```

Design notes:
- This follows the exact same bounded-polling shape already used in `content.js`'s `waitForCondition` (from a prior phase) — poll every 200ms, give up after `timeoutMs`, never throw. Using a consistent polling idiom across this codebase rather than inventing a new one.
- A fresh `chrome.tabs.update(tabId, {url: ...})` navigation destroys and recreates the content script on the new page, and that injection is not instantaneous — this function exists specifically to bridge that gap before Task 5's batch loop tries to message the newly-navigated page.

- [ ] **Step 3: Verify both files are syntactically valid**

If Node is available:
```bash
node -c extension/content.js
node -c extension/sidepanel.js
```
Expected: no output from either (success).

- [ ] **Step 4: Commit**

```bash
git add extension/content.js extension/sidepanel.js
git commit -m "feat: add content-script-ready polling helper for post-navigation waits"
```

---

## Task 5: Batch orchestration — navigate, scrape, and combine into one zip

**Files:**
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `startBatchExport(projects)` stub from Task 3 (this task replaces its body), `waitForContentScriptReady(tabId, timeoutMs)` from Task 4, `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata)` from Task 1, `fetchConversationsList`/`fetchAllConversations`/`fetchConversation` from `lib/api.js` (unchanged), `getOrganizationId` from `lib/orgId.js` (unchanged), `GET_PROJECT_METADATA` message contract from a prior phase (unchanged).
- Produces: a fully working batch export — the final feature this plan delivers.

- [ ] **Step 1: Replace the startBatchExport stub in sidepanel.js**

In `extension/sidepanel.js`, replace the Task 3 stub:
```javascript
async function startBatchExport(projects) {
  setStatus(`Batch export not yet implemented (would process ${projects.length} project(s)).`, 'error');
}
```
with:
```javascript
async function startBatchExport(projects) {
  const confirmBtn = document.getElementById('confirm-selection-btn');
  const selectBtn = document.getElementById('select-projects-btn');

  setStatus('Resolving organization ID...', '');
  const orgId = await getOrganizationId();
  if (!orgId) {
    setStatus('Batch export failed: could not find your organization ID. Make sure you are logged into claude.ai.', 'error');
    selectBtn.style.display = 'block';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;

  const zip = new JSZip();
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    setStatus(`Scraping project ${i + 1}/${projects.length}: ${project.name}...`, '');

    try {
      await chrome.tabs.update(tabId, { url: `https://claude.ai/project/${project.uuid}` });

      const ready = await waitForContentScriptReady(tabId, 15000);
      if (!ready) {
        throw new Error('page did not finish loading in time');
      }

      const conversationsList = await fetchConversationsList(orgId, project.uuid);
      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('no conversations found');
      }

      let projectMetadata = { memory: null, instructions: null };
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Proceed without memory/instructions for this project.
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Scraping project ${i + 1}/${projects.length}: ${project.name} (${fetched}/${total} conversations)...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('failed to fetch any conversations');
      }

      const folderName = `${sanitizeFilename(project.name)}_${project.uuid.substring(0, 8)}`;
      await buildProjectZip(zip, folderName, project.uuid, conversations, projectMetadata);

      succeeded.push(project.name);
    } catch (error) {
      failed.push({ name: project.name, reason: error.message });
    }
  }

  if (succeeded.length === 0) {
    setStatus(`Batch export failed: all ${projects.length} project(s) failed. ${failed.map(f => `${f.name}: ${f.reason}`).join('; ')}`, 'error');
    selectBtn.style.display = 'block';
    return;
  }

  setStatus(`Building combined zip for ${succeeded.length} project(s)...`, '');
  const blob = await zip.generateAsync({ type: 'blob' });
  const downloadFilename = `projects_batch_${succeeded.length}.zip`;

  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
  });

  let finalMessage = `✅ Batch export complete: ${succeeded.length}/${projects.length} project(s) exported.`;
  if (failed.length > 0) {
    finalMessage += ` Failed: ${failed.map(f => `${f.name} (${f.reason})`).join(', ')}.`;
  }
  setStatus(finalMessage, 'success');
  selectBtn.style.display = 'block';
}
```

Design notes for this exact implementation (do not deviate):
- The loop uses `chrome.tabs.update(tabId, {url: ...})` (navigating the SAME tab the panel is anchored to) rather than `chrome.tabs.create` — per the spec's explicit choice of sequential same-tab navigation over background tabs.
- `waitForContentScriptReady(tabId, 15000)` is awaited immediately after navigation, BEFORE attempting `fetchConversationsList` — the REST API fetches themselves don't need the content script (they're plain `fetch()` calls from the panel's own context), but `GET_PROJECT_METADATA` does, and more importantly this wait also serves as "has the navigation actually landed on a real page" confirmation before proceeding.
- Every per-project step from `chrome.tabs.update` through `buildProjectZip` is inside one `try` block — ANY failure at any point (navigation, readiness timeout, conversations fetch, zero conversations, all-conversations-fail) is caught by the single `catch (error)`, recorded in `failed`, and the loop's `for` continues to the next project. This is what satisfies the Global Constraint that one bad project must not abort the batch.
- `folderName` uses the already-existing `sanitizeFilename` (from `lib/markdown.js`, loaded by `sidepanel.html`) plus an 8-char UUID suffix — same collision-avoidance pattern already used by `conversationFolderName` for individual conversations, applied here at the project-folder level for the batch zip.
- `projectMetadata`'s try/catch mirrors the exact established pattern from the single-project export path (Task in a prior phase) — a missing/unresponsive content script for THIS SPECIFIC MESSAGE degrades to no memory/instructions for that one project, without being treated as a fatal error for the whole project (unlike the readiness-timeout and conversations-fetch failures, which ARE fatal for that project).
- If `succeeded.length === 0` (every project failed), no zip is generated at all and no download is triggered — matches the spec's explicit requirement to avoid downloading an empty/near-empty zip.
- `selectBtn.style.display = 'block'` at the end (both the all-failed early-return and the success path) restores the "Select Projects" button so the user can immediately start another batch or return to normal single-project use — the panel doesn't get stuck in a dead-end state after a batch completes.

- [ ] **Step 2: Verify sidepanel.js is syntactically valid**

If Node is available:
```bash
node -c extension/sidepanel.js
```
Expected: no output (success).

- [ ] **Step 3: Trace the batch loop for a 2-project scenario, including one failure**

By code review, write out in your report a trace of: `startBatchExport([{uuid: 'a', name: 'ProjA'}, {uuid: 'b', name: 'ProjB'}])` where project `a` succeeds normally (has conversations, memory, instructions) and project `b`'s `fetchConversationsList` returns an empty array. Confirm:
- Project `a`: navigates, waits for readiness, fetches conversations + metadata, calls `buildProjectZip(zip, 'ProjA_<uuid8>', 'a', [...], {...})`, pushed to `succeeded`.
- Project `b`: navigates, waits for readiness, `fetchConversationsList` returns `[]`, the `if (!conversationsList || conversationsList.length === 0) throw new Error('no conversations found')` fires, caught by the surrounding `catch`, pushed to `failed` with reason `'no conversations found'` — loop does NOT stop, there is no project `c` in this example so the loop ends naturally.
- After the loop: `succeeded.length` is 1 (not 0), so the zip IS generated and downloaded, containing only `ProjA_<uuid8>/...` — confirm `ProjB` contributes NOTHING to the zip (its `buildProjectZip` call was never reached).
- Final status message correctly reports `1/2` succeeded and lists `ProjB (no conversations found)` as the failure.

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel.js
git commit -m "feat: implement sequential multi-project batch scraping into one combined zip"
```

---

## Self-Review Notes

- **Spec coverage:** "Select Projects" button on `/projects` (Task 3), red-border click-toggle selection (Task 2), live "Confirm Selection (N)" count (Task 3), sequential same-tab navigation (Task 5), reuse of the exact existing project-export pipeline per project (Task 5, calling the same `fetchConversationsList`/`fetchAllConversations`/`GET_PROJECT_METADATA`/`buildProjectZip` used by single-project export), one combined zip with per-project subfolders (Task 1's refactor + Task 5's `folderName` nesting), graceful per-project failure without aborting the batch (Task 5's per-iteration try/catch), no zip generated if all projects fail (Task 5), single-project/single-conversation export unaffected (Task 1 Step 2 preserves exact output; Tasks 2-5 never touch `buildConversationFolder`/`buildConversationZip`/the `exportMode === 'conversation'` branch) — all covered.
- **Placeholder scan:** all code blocks are complete and copy-pasteable; the one intentional stub (Task 3's `startBatchExport`) is explicitly flagged as a stub with its exact replacement covered by name in Task 5 — not a hidden gap.
- **Type consistency:** `{uuid, name}` project-info shape is identical across Task 2's `getProjectInfoFromListItem`/`getSelectedProjects`, Task 3's `confirmSelection`/`startBatchExport` stub signature, and Task 5's `startBatchExport` real implementation. `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata)` signature is identical between Task 1's implementation, Task 1 Step 2's single-project call site, and Task 5's batch call site. `waitForContentScriptReady(tabId, timeoutMs)` signature matches between Task 4's definition and Task 5's call. The `PING`/`{pong: true}` message contract matches between Task 4's `content.js` handler and `sidepanel.js`'s poller.
- **Scope check:** confirmed no task modifies `buildConversationFolder`, `buildConversationZip`, `main-world-hook.js`, or the `exportMode === 'conversation'` branch of `runExport()` — single-conversation export is fully untouched, matching the spec's Non-goals.
