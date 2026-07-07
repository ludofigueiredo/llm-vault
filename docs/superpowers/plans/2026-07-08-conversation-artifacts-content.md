# Conversation Artifacts & Content Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When exporting a single conversation, automatically capture its "Artéfacts" (via simulated UI interaction + a MAIN-world Blob-capture hook) and "Contenu" files (via direct fetch of preview URLs), populating the existing `artefacts/`/`contenu/` placeholder folders with real content.

**Architecture:** A new MAIN-world content script hooks `URL.createObjectURL` to intercept the artifact zip Blob claude.ai generates client-side. The existing isolated-world `content.js` is extended to orchestrate DOM interaction (open sidebar, click "Tout télécharger", arm/disarm the hook) and to scrape "Contenu" file URLs. `popup.js` requests this data during conversation export; `zipBuilder.js` unzips the captured artifact Blob and fetches content files into the export zip.

**Tech Stack:** Same as the existing extension — Manifest V3, vanilla JS, no build step, vendored JSZip (already present, reused here for unzipping too).

## Global Constraints

- No build process, no new npm dependencies.
- This mechanism is scoped to single-conversation export (`exportMode === 'conversation'`) ONLY — `buildProjectZip`'s per-conversation calls must NOT pass artifact-capture data; project-mode conversations keep empty `artefacts/`/`contenu/` exactly as before this plan.
- Every capture step must degrade gracefully: a missing button, a missing section, a capture timeout, or a failed file fetch must NEVER throw an error that aborts the overall export. The export's success/failure status is unaffected by whether artifacts/content were captured.
- No live claude.ai verification is possible during implementation (sandboxed environment, no real Chrome browser). All verification is by code review, Node syntax checks, and DOM-structure tracing against the captured snapshot `sidebar.html` in the repo root. Live verification by the user after implementation is essential for this plan specifically, more so than prior phases, given the fragility documented in the design spec.
- The MAIN-world hook must only intercept `createObjectURL` calls while explicitly "armed" (between an explicit start signal and either a successful capture or a timeout) — it must not unconditionally intercept for the page's entire lifetime.
- `chrome.runtime.sendMessage`/`sendResponse` payloads must be structured-cloneable — the captured Blob is transferred as an `ArrayBuffer`, never a raw `Blob` object, across the content-script message boundary.

---

## File Structure

```
extension/
  manifest.json              # MODIFIED: content_scripts array — new MAIN-world entry, extend/add chat/* matches
  content.js                  # MODIFIED: add captureArtifactsZip(), scrapeContentFiles(), new message type
  main-world-hook.js           # NEW: MAIN-world Blob-capture hook for URL.createObjectURL
  popup.js                      # MODIFIED: request GET_CONVERSATION_ARTIFACTS in conversation branch
  lib/
    zipBuilder.js                # MODIFIED: buildConversationFolder gains artifactsData param, unzips + fetches
```

---

## Task 1: MAIN-world Blob-capture hook

**Files:**
- Create: `extension/main-world-hook.js`
- Modify: `extension/manifest.json`

**Interfaces:**
- Produces: a script running in the page's MAIN world that, once armed via a `window.postMessage` of shape `{source: 'claude-exporter', type: 'ARM_CAPTURE'}`, intercepts the next `URL.createObjectURL(blob)` call, reads the Blob via `blob.arrayBuffer()`, and posts `{source: 'claude-exporter', type: 'BLOB_CAPTURED', buffer: ArrayBuffer}` back via `window.postMessage`. Responds to `{source: 'claude-exporter', type: 'DISARM_CAPTURE'}` by disarming without capturing.

- [ ] **Step 1: Write main-world-hook.js**

Create `extension/main-world-hook.js`:
```javascript
(function () {
  const MESSAGE_SOURCE = 'claude-exporter';
  let armed = false;
  let originalCreateObjectURL = null;

  function installHook() {
    if (originalCreateObjectURL) return;
    originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      const result = originalCreateObjectURL(blob);
      if (armed && blob instanceof Blob) {
        armed = false;
        blob.arrayBuffer().then((buffer) => {
          window.postMessage({ source: MESSAGE_SOURCE, type: 'BLOB_CAPTURED', buffer }, '*');
        }).catch(() => {
          window.postMessage({ source: MESSAGE_SOURCE, type: 'BLOB_CAPTURE_FAILED' }, '*');
        });
      }
      return result;
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE) return;

    if (data.type === 'ARM_CAPTURE') {
      installHook();
      armed = true;
    } else if (data.type === 'DISARM_CAPTURE') {
      armed = false;
    }
  });
})();
```

Design notes for this exact implementation (do not deviate):
- The hook installs `URL.createObjectURL`'s override lazily (on first `ARM_CAPTURE`), not at script load — minimizes any behavioral change to the page before this feature is actually used.
- The override ALWAYS calls through to the original `createObjectURL` and returns its real result — the page's own download flow is never blocked or altered, only observed. This matches the design spec's "the hook observes, it does not block" requirement.
- `armed` is set to `false` immediately upon capturing (before the async `arrayBuffer()` read resolves) so a second, unrelated `createObjectURL` call that happens to fire before the first capture's promise resolves is not also captured — only the first Blob after arming is captured.
- `event.source !== window` check guards against processing postMessage events from other frames/origins — only same-window messages (which is what content-script-to-MAIN-world communication uses) are considered.
- No MIME-type filtering on the Blob (per the design spec: "the hook should be lenient and capture any Blob-based call that occurs while armed, not filter strictly by MIME type").

- [ ] **Step 2: Register the content script in manifest.json**

Modify `extension/manifest.json` to add a new entry to the `content_scripts` array (do not remove or modify the existing `content.js` entry in this step — Task 3 handles extending its `matches`). The array should now contain two entries; add this one:
```json
{
  "matches": ["https://claude.ai/chat/*"],
  "js": ["main-world-hook.js"],
  "world": "MAIN",
  "run_at": "document_idle"
}
```

The full `content_scripts` array in `extension/manifest.json` should read (for now — Task 3 will further modify the first entry's `matches`):
```json
  "content_scripts": [
    {
      "matches": ["https://claude.ai/project/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://claude.ai/chat/*"],
      "js": ["main-world-hook.js"],
      "world": "MAIN",
      "run_at": "document_idle"
    }
  ]
```

- [ ] **Step 3: Verify manifest.json is valid JSON**

If Node is available:
```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8')); console.log('valid JSON')"
```
Expected: `valid JSON` with no errors.

- [ ] **Step 4: Verify main-world-hook.js is syntactically valid**

If Node is available:
```bash
node -c extension/main-world-hook.js
```
Expected: no output (success). Note: this only checks syntax — `URL`, `Blob`, and `window` are undefined/different in plain Node, so do not attempt to execute the hook's logic in Node, a syntax check is sufficient for this task.

- [ ] **Step 5: Trace the arm/capture/disarm state machine by code review**

Write out in your report a trace of these scenarios: (a) `ARM_CAPTURE` received, then a `createObjectURL(zipBlob)` call happens — confirm `armed` flips to `false` synchronously and a `BLOB_CAPTURED` message is posted once `arrayBuffer()` resolves; (b) `ARM_CAPTURE` received but no `createObjectURL` call ever happens — confirm nothing is posted and no error occurs (this is the expected timeout path, handled by the caller in Task 2/3, not this file); (c) `DISARM_CAPTURE` received after `ARM_CAPTURE` but before any capture — confirm `armed` flips back to `false` and a subsequent `createObjectURL` call is NOT captured.

- [ ] **Step 6: Commit**

```bash
git add extension/main-world-hook.js extension/manifest.json
git commit -m "feat: add MAIN-world hook to capture claude.ai's artifact zip Blob"
```

---

## Task 2: Extend content.js — sidebar interaction, capture orchestration, and Contenu scraping

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/manifest.json`

**Interfaces:**
- Consumes: the MAIN-world hook's `postMessage` protocol from Task 1 (`ARM_CAPTURE`/`DISARM_CAPTURE` outbound, `BLOB_CAPTURED`/`BLOB_CAPTURE_FAILED` inbound).
- Produces: a new message handler for `{type: 'GET_CONVERSATION_ARTIFACTS'}` responding with `{artifactsZip: ArrayBuffer|null, contentFiles: Array<{filename: string, url: string}>}`. Never throws.

- [ ] **Step 1: Extend manifest.json's content.js entry to also match chat pages**

Modify `extension/manifest.json`'s first `content_scripts` entry (the one with `"js": ["content.js"]`) to match both project and chat URLs. Change:
```json
    {
      "matches": ["https://claude.ai/project/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
```
to:
```json
    {
      "matches": ["https://claude.ai/project/*", "https://claude.ai/chat/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
```
Leave the second entry (`main-world-hook.js`, from Task 1) unchanged.

- [ ] **Step 2: Verify manifest.json is still valid JSON**

If Node is available:
```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8')); console.log('valid JSON')"
```
Expected: `valid JSON` with no errors.

- [ ] **Step 3: Add captureArtifactsZip(), scrapeContentFiles(), and wire the new message type in content.js**

Read the current `extension/content.js` first (it currently ends with the `chrome.runtime.onMessage.addListener` block handling `GET_PROJECT_METADATA`). Add the following new code BEFORE the existing `chrome.runtime.onMessage.addListener` call, and MODIFY that listener to also handle the new message type. The full new/changed content:

```javascript
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
```

Then MODIFY the existing listener at the bottom of the file from:
```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'GET_PROJECT_METADATA') {
    sendResponse(getProjectMetadata());
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
  return false;
});
```

Design notes for this exact implementation (do not deviate):
- `findFilesToggleButton` uses the exact `[aria-label="Fichiers"]` selector matching the captured `sidebar.html` snapshot (line 6: `aria-label="Fichiers"`).
- `waitForCondition` is a generic bounded-polling helper (not a fixed `setTimeout` delay) — it resolves as soon as `checkFn()` returns truthy, or `null` after `timeoutMs`. Used to wait for the sidebar's "Artéfacts" heading to appear after the toggle click, since the sidebar's open animation takes an unknown, non-zero amount of time.
- `findArtefactsHeading` reuses the same `<h3>` exact-text-match pattern as the existing `extractSectionText` function (for Memory/Instructions) — matches `sidebar.html` line 23 (`<h3 class="font-medium text-sm">Artéfacts</h3>`).
- `findDownloadAllButton` walks up from the Artéfacts heading (same bounded-ancestor-walk pattern as `extractSectionText`) and searches each ancestor's `<button>` descendants for one whose text includes `'Tout télécharger'` — matches `sidebar.html` lines 23-31, where the button is a sibling of the heading within the same `.flex.items-center.justify-between` container (1 hop up from the heading reaches it).
- `captureArtifactsZip`'s error paths (`!artefactsHeading`, `!downloadButton`) explicitly click `toggleButton` again to CLOSE the sidebar before returning `null` — the design spec requires restoring the page to its original state regardless of outcome. The success path does the same at the very end, after `waitForBlobCapture` resolves (whether it got a real buffer or `null` from a timeout).
- `waitForBlobCapture`'s timeout path explicitly posts `DISARM_CAPTURE` before resolving `null` — ensures the MAIN-world hook doesn't stay armed indefinitely if the click never triggered a capture (e.g., claude.ai didn't use `createObjectURL` for this download after all).
- `findContenuSection` distinguishes "Contenu" from "Contenu du projet" by requiring an EXACT trimmed match of `'Contenu'` (not a substring match, and not matching `'Contenu du projet'`) — per `sidebar.html` lines 223 (`Contenu du projet`, must NOT match) vs 263 (`Contenu`, must match). It also filters by finding an ancestor with class `.flex.flex-col.gap-3` (matching the container structure at `sidebar.html` line 261) so it doesn't accidentally treat an unrelated same-named heading elsewhere as a match — if no ancestor with that class exists within a few hops via `closest()`, treat as not found.
- `scrapeContentFiles` reads `alt`/`src` off every `<img>` inside the matched section — matches `sidebar.html`'s `Contenu` section structure (lines 266-345), where each file thumbnail is an `<img alt="..." src="/api/.../preview">`. Note this means the non-image file entry (the `.pptx` at lines 267-294, which renders as a `<button>` with an `<h3>` filename and no `<img>`) is NOT captured by this function — it has no `src` to fetch from. This is an accepted, known gap: only image-thumbnail files (which do have a fetchable `/preview` URL) are captured by this mechanism; document this in your report, do not attempt to handle the non-image case since it has no discoverable download URL in the DOM.

- [ ] **Step 4: Verify content.js is syntactically valid**

If Node is available:
```bash
node -c extension/content.js
```
Expected: no output (success).

- [ ] **Step 5: Trace the full capture flow against sidebar.html**

Read `sidebar.html` (repo root) and write out in your report:
- Confirm `findFilesToggleButton()`'s selector matches the button at line 6.
- Confirm `findArtefactsHeading()` matches the `<h3>` at line 23, and `findDownloadAllButton()` starting from that heading finds the button at lines 23-31 within the ancestor walk (state the hop count).
- Confirm `findContenuSection()` matches the `<h3>Contenu</h3>` at line 263 (NOT the `<h3 class="text-text-300 mb-2 mt-4 text-sm font-medium">Contenu du projet</h3>` at line 223), and that its `closest('.flex.flex-col.gap-3')` ancestor lookup resolves to the container at line 261.
- Confirm `scrapeContentFiles()` would extract 5 `{filename, url}` entries from the 5 `<img>` thumbnails at lines 296-343 (`thumbnails-1.jpg` through `thumbnails-5.jpg`), and would NOT extract an entry for the `.pptx` file at lines 267-294 (no `<img>` present there).

- [ ] **Step 6: Commit**

```bash
git add extension/content.js extension/manifest.json
git commit -m "feat: orchestrate artifact zip capture and scrape conversation content files"
```

---

## Task 3: Wire popup.js to request conversation artifacts during export

**Files:**
- Modify: `extension/popup.js`

**Interfaces:**
- Consumes: the content script's `GET_CONVERSATION_ARTIFACTS` message contract from Task 2 (resolves to `{artifactsZip: ArrayBuffer|null, contentFiles: Array<{filename, url}>}`, or rejects if no listener is present).
- Produces: `runExport()`'s `conversation` branch now calls `buildConversationZip(conversation, artifactsData)` (2-arg form) instead of the current 1-arg form — this is the interface Task 4 must implement.

- [ ] **Step 1: Modify the conversation branch of runExport() in popup.js**

In `extension/popup.js`, locate the `} else if (exportMode === 'conversation') { ... }` block (currently lines 97-109). Replace it with:

```javascript
    } else if (exportMode === 'conversation') {
      setStatus('Fetching conversation...', '');
      const data = await fetchConversation(orgId, exportConversationId);
      if (!data) {
        throw new Error('Failed to fetch this conversation.');
      }

      const conversation = { metadata: { name: data.name, uuid: data.uuid, created_at: data.created_at, updated_at: data.updated_at, model: data.model }, data };

      let artifactsData = { artifactsZip: null, contentFiles: [] };
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' });
        if (response) {
          artifactsData = response;
        }
      } catch (e) {
        // Content script not present/responsive — proceed without artifacts/content.
      }

      setStatus('Building zip...', '');
      blob = await buildConversationZip(conversation, artifactsData);
      downloadFilename = `${conversationFolderName(conversation)}.zip`;
      setStatus('✅ Exported conversation.', 'success');
    } else {
```

(The trailing `} else {` line marks where the existing next block begins — do not duplicate it, this just shows the seam so you can locate the correct end point. Everything from `} else {` onward, through the end of the function, stays exactly as it currently is — unchanged.)

Design notes:
- The artifact-capture message is sent AFTER `fetchConversation` succeeds (no point capturing artifacts for a conversation whose data we couldn't even fetch) and BEFORE `buildConversationZip` (which needs the data).
- Same try/catch-and-degrade pattern as the existing Memory/Instructions call in the project branch — a rejected `sendMessage` (no content script listening) must never abort the export, only leave `artifactsData` at its safe empty default.
- The status message `'Capturing artifacts and content files...'` is shown before the (potentially slow, up to ~10+ seconds per the hook timeout) capture attempt, so the user isn't left wondering why the export seems to pause.

- [ ] **Step 2: Verify popup.js is syntactically valid**

If Node is available:
```bash
node -c extension/popup.js
```
Expected: no output (success).

- [ ] **Step 3: Cross-check the new call site against Task 4's planned interface**

Read this plan's Task 4 brief section (or, if Task 4 is already implemented when you do this, read the actual `extension/lib/zipBuilder.js`) and confirm `buildConversationZip(conversation, artifactsData)` — 2 positional args, in that order — matches the function signature documented there.

- [ ] **Step 4: Confirm the project branch is untouched**

Read the full current `extension/popup.js` and confirm the `if (exportMode === 'project') { ... }` branch (including its own Memory/Instructions capture logic from a prior phase) is byte-for-byte unchanged by this task's edit.

- [ ] **Step 5: Commit**

```bash
git add extension/popup.js
git commit -m "feat: request conversation artifacts/content from content script during export"
```

---

## Task 4: Extend zipBuilder to unzip artifacts and fetch content files

**Files:**
- Modify: `extension/lib/zipBuilder.js`

**Interfaces:**
- Consumes: `artifactsData` object of shape `{artifactsZip: ArrayBuffer|null, contentFiles: Array<{filename: string, url: string}>}` as produced by Task 3's `popup.js` call site.
- Produces: `buildConversationZip(conversation, artifactsData)` — the 2nd parameter is optional (function must not throw if called with only 1 arg, so `buildProjectZip`'s existing per-conversation calls via `buildConversationFolder` continue to work unmodified). `buildConversationFolder(zip, folderName, conversation, artifactsData)` gains the same optional 4th parameter.

- [ ] **Step 1: Modify buildConversationFolder and buildConversationZip in zipBuilder.js**

Read the current `extension/lib/zipBuilder.js` first. Replace `buildConversationFolder` and `buildConversationZip` (leave `buildProjectZip` untouched — it calls `buildConversationFolder` without a 4th arg, which is fine given the optional-parameter design) with:

```javascript
async function buildConversationFolder(zip, folderName, conversation, artifactsData) {
  const folder = zip.folder(folderName);
  folder.file('conversation.md', convertToMarkdown(conversation));

  const artefactsFolder = folder.folder('artefacts');
  if (artifactsData && artifactsData.artifactsZip) {
    const artifactsZipInstance = await JSZip.loadAsync(artifactsData.artifactsZip);
    const entries = [];
    artifactsZipInstance.forEach((relativePath, entry) => {
      entries.push({ relativePath, entry });
    });
    for (const { relativePath, entry } of entries) {
      if (entry.dir) continue;
      const content = await entry.async('arraybuffer');
      artefactsFolder.file(relativePath, content);
    }
  } else {
    artefactsFolder.file('.gitkeep', '');
  }

  const contenuFolder = folder.folder('contenu');
  const contentFiles = (artifactsData && artifactsData.contentFiles) || [];
  if (contentFiles.length > 0) {
    let anySucceeded = false;
    for (const file of contentFiles) {
      try {
        const response = await fetch(file.url, { credentials: 'include' });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        contenuFolder.file(file.filename, buffer);
        anySucceeded = true;
      } catch (e) {
        // Skip this file, continue with the rest.
      }
    }
    if (!anySucceeded) {
      contenuFolder.file('.gitkeep', '');
    }
  } else {
    contenuFolder.file('.gitkeep', '');
  }
}

async function buildProjectZip(projectId, conversations, projectMetadata) {
  const zip = new JSZip();
  zip.file('index.md', createIndexMarkdown(projectId, conversations));

  if (projectMetadata && projectMetadata.memory) {
    zip.file('memory.md', projectMetadata.memory);
  }
  if (projectMetadata && projectMetadata.instructions) {
    zip.file('instructions.md', projectMetadata.instructions);
  }
  zip.folder('fichiers').file('.gitkeep', '');

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    await buildConversationFolder(zip, folderName, conv);
  }

  return zip.generateAsync({ type: 'blob' });
}

async function buildConversationZip(conversation, artifactsData) {
  const zip = new JSZip();
  const folderName = conversationFolderName(conversation);
  await buildConversationFolder(zip, folderName, conversation, artifactsData);
  return zip.generateAsync({ type: 'blob' });
}
```

Design notes for this exact implementation (do not deviate):
- `buildConversationFolder` is now `async` (it wasn't before) — this is a necessary, intentional signature change since unzipping and fetching are both asynchronous. `buildProjectZip`'s loop over conversations is changed from `conversations.forEach(...)` (which does not await async callbacks) to a `for...of` loop with `await buildConversationFolder(...)` so each conversation's folder is fully built (including any awaited work) before moving to the next — this preserves correctness even though `buildProjectZip`'s calls don't pass artifact data (the `await` is still required because the function signature itself is now async, not because project-mode needs the artifact logic).
- `artefactsFolder`/`contenuFolder` each independently fall back to a `.gitkeep`-only placeholder when there's nothing real to put there — matching the existing pre-this-plan behavior exactly for the no-data case, so a project-mode export (which never passes `artifactsData`) is byte-for-byte identical in output to before this plan.
- The artifacts-unzip loop skips directory entries (`entry.dir`) from the captured zip and re-adds only files, using `entry.async('arraybuffer')` to read each file's bytes — this preserves the original zip's internal relative path structure (per the design spec's "preserving the captured zip's internal file/folder structure") since JSZip's `.file(relativePath, content)` on a path containing `/` automatically creates the necessary subfolder structure.
- The content-files fetch loop tracks `anySucceeded` and only falls back to `.gitkeep` if EVERY fetch failed — if at least one file succeeded, `contenu/` contains just the successful files (no `.gitkeep` needed since the folder is non-empty). This matches the design spec's "on failure, skip that file silently... continue with the rest" and "if the array is empty or fetches all fail, contenu/ keeps its .gitkeep placeholder-only behavior (or ends up with only whichever files succeeded)".

- [ ] **Step 2: Verify zipBuilder.js is syntactically valid**

If Node is available:
```bash
node -c extension/lib/zipBuilder.js
```
Expected: no output (success).

- [ ] **Step 3: Verify the function logically handles all input shapes**

By code review, confirm and write out in your report:
- Called as `buildConversationZip(conv, {artifactsZip: someArrayBuffer, contentFiles: [{filename, url}, ...]})` → artifacts unzipped into `artefacts/` preserving structure, content files fetched into `contenu/`.
- Called as `buildConversationZip(conv, {artifactsZip: null, contentFiles: []})` → both folders get `.gitkeep` only (matches pre-this-plan empty-placeholder behavior).
- Called as `buildConversationZip(conv, undefined)` or `buildConversationZip(conv)` (1-arg legacy call) → the `artifactsData && ...` guards short-circuit safely, no `TypeError`, both folders get `.gitkeep` only.
- Called via `buildProjectZip`'s internal loop (no `artifactsData` passed to `buildConversationFolder` at all) → same safe fallback, confirming project-mode output is unaffected by this plan.
- A `contentFiles` entry whose `fetch` throws (network error) or resolves non-ok → skipped, loop continues to the next entry without stopping.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/zipBuilder.js
git commit -m "feat: unzip captured artifacts and fetch content files into conversation folder"
```

---

## Self-Review Notes

- **Spec coverage:** MAIN-world hook with arm/disarm lifecycle (Task 1), sidebar open/close + Artéfacts detection + Download-all click + capture-with-timeout (Task 2), Contenu section scraping distinct from "Contenu du projet" (Task 2), popup.js wiring with graceful degradation (Task 3), zipBuilder unzip-and-fetch with `.gitkeep` fallback preserving pre-plan behavior for project-mode (Task 4), scope restricted to conversation-mode only (`buildProjectZip` never passes `artifactsData` — confirmed in Task 4's own code) — all covered.
- **Placeholder scan:** all code blocks are complete and copy-pasteable; no TBD/TODO.
- **Type consistency:** `GET_CONVERSATION_ARTIFACTS` response shape `{artifactsZip: ArrayBuffer|null, contentFiles: Array<{filename, url}>}` is identical between Task 2's `getConversationArtifacts()` return, Task 3's `artifactsData` assignment, and Task 4's `buildConversationFolder`/`buildConversationZip` parameter destructuring. `buildConversationZip(conversation, artifactsData)` signature matches between Task 3's call site and Task 4's implementation. The MAIN-world postMessage protocol (`ARM_CAPTURE`/`DISARM_CAPTURE`/`BLOB_CAPTURED`/`BLOB_CAPTURE_FAILED`, all namespaced under `source: 'claude-exporter'`) is identical between Task 1's hook and Task 2's `waitForBlobCapture`/`captureArtifactsZip`.
- **Scope check:** confirmed `buildProjectZip` (Task 4) does not pass a 4th argument to `buildConversationFolder` in its per-conversation loop — project-mode conversations get the same `.gitkeep`-only `artefacts/`/`contenu/` as before this plan, satisfying the Global Constraint that this mechanism is conversation-mode-only.
