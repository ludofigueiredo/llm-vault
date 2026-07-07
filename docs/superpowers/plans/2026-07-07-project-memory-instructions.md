# Project Memory & Instructions Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When exporting a Claude Project, also capture the project's Memory and Instructions text (scraped from the open project page's DOM, since no REST API exposes them) and include them as `memory.md`/`instructions.md` in the output zip, plus reserve an empty `fichiers/` folder for a future phase.

**Architecture:** A new Manifest V3 content script (`extension/content.js`) is injected on `claude.ai/project/*` pages and, on request, scrapes the Memory/Instructions sections' text from the DOM. `popup.js` messages the content script during a project export, passes the result into an extended `buildProjectZip()`, which writes the two new files (only if found) and an empty `fichiers/.gitkeep` placeholder.

**Tech Stack:** Same as the existing extension — Manifest V3, vanilla JS, no build step, no new dependencies.

## Global Constraints

- No build process, no new npm dependencies.
- Single-conversation export (`buildConversationZip`) is NOT touched by this plan — Memory/Instructions/Files are project-only concepts.
- The export must never fail or show an error because Memory/Instructions couldn't be found — this is enrichment, not a required part of a successful export (per the spec's Error handling section).
- No new `permissions` needed in manifest.json beyond what already exists (`downloads`, `activeTab`, `cookies`, `host_permissions: ["https://claude.ai/*"]`) — `content_scripts` requires no separate permission grant when its `matches` pattern is already covered by `host_permissions`.
- This implementation cannot be verified against a live claude.ai session (sandboxed environment, no real Chrome browser) — verification is by code review, Node syntax checks, and DOM-parsing logic traced against the captured HTML snapshot at `web_source.html` in the repo root. Live verification is an explicit follow-up for the user (per the spec's Known risk section on DOM truncation).

---

## File Structure

```
extension/
  manifest.json          # MODIFIED: add content_scripts entry
  popup.js                 # MODIFIED: request project metadata from content script, pass to buildProjectZip
  content.js               # NEW: injected on claude.ai/project/* — scrapes Memory/Instructions on request
  lib/
    zipBuilder.js            # MODIFIED: buildProjectZip gains projectMetadata param, writes memory.md/instructions.md/fichiers/
```

---

## Task 1: Content script — scrape Memory and Instructions from the project page DOM

**Files:**
- Create: `extension/content.js`
- Modify: `extension/manifest.json`

**Interfaces:**
- Produces: a content script that responds to a `chrome.runtime.onMessage` request of shape `{type: 'GET_PROJECT_METADATA'}` with a response of shape `{memory: string|null, instructions: string|null}`. Never throws; unmatched sections resolve to `null`.

- [ ] **Step 1: Write content.js**

Create `extension/content.js`:
```javascript
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'GET_PROJECT_METADATA') {
    sendResponse(getProjectMetadata());
  }
  return false;
});
```

Design notes for this exact implementation (do not deviate):
- `extractSectionText` matches `<h3>` elements by exact trimmed `textContent` equality against the label — this works for both the Memory heading (`<h3><div>Mémoire</div></h3>`, where `h3.textContent` still yields `"Mémoire"` since `textContent` concatenates all descendant text) and the Instructions heading (`<h3>Instructions</h3>`, direct text) without needing to special-case the nesting difference.
- It then walks UP from the matched `<h3>` through up to 5 ancestor levels, and at each level does `container.querySelector('p')` (searches the container's full subtree, not just direct children) to find the first paragraph with non-empty text. This tolerates some variation in exact DOM nesting between the heading and the content paragraph, since the captured snapshot shows the heading in an `.h-6` row div, itself inside a `.flex.flex-col.gap-0.5` div that also contains the sibling `<p>` — walking up 1-2 levels from the heading and then querying for `p` within that ancestor reaches the paragraph. The 5-level cap prevents runaway walking to `document.body` and accidentally matching an unrelated `<p>` elsewhere on the page.
- `chrome.runtime.onMessage.addListener`'s callback returns `false` (not `true`) because `sendResponse` is called synchronously — no need to keep the message channel open for an async response.
- The label strings `'Mémoire'` and `'Instructions'` are hardcoded to match the captured snapshot (`web_source.html` in the repo root, lines 361 and 449). If claude.ai's UI language differs (e.g. English "Memory"/"Instructions" for non-French accounts), this will not match — this is a known limitation, not a bug to fix in this task; note it in your report but do not attempt to add English labels or i18n detection, that's explicitly out of scope for this plan.

- [ ] **Step 2: Register the content script in manifest.json**

Modify `extension/manifest.json` — add a `content_scripts` key. The full file should read:
```json
{
  "manifest_version": 3,
  "name": "Claude Conversations Exporter",
  "version": "1.0.0",
  "description": "Export Claude Project conversations or a single conversation as a structured Markdown zip.",
  "permissions": ["downloads", "activeTab", "cookies"],
  "host_permissions": ["https://claude.ai/*"],
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": ["https://claude.ai/project/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 3: Verify manifest.json is valid JSON**

If Node is available:
```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8')); console.log('valid JSON')"
```
Expected: `valid JSON` with no errors.

If Node is unavailable, read the file back and visually confirm balanced braces/brackets and valid JSON syntax.

- [ ] **Step 4: Verify content.js is syntactically valid**

If Node is available:
```bash
node -c extension/content.js
```
Expected: no output (success). Note: this only checks syntax — `chrome` is undefined in plain Node, so do NOT try to actually execute `getProjectMetadata()` or trigger the listener in Node; a syntax check is sufficient for this task.

- [ ] **Step 5: Trace the extraction logic against the captured HTML snapshot**

Read `web_source.html` (repo root) and manually verify, by reading the markup around lines 356-443 (Memory section) and lines 445-474 (Instructions section), that `extractSectionText('Mémoire')` and `extractSectionText('Instructions')` would each correctly locate their respective `<h3>` and then find the sibling `<p class="text-text-500 font-small line-clamp-2">` within the ancestor-walk. Write out the trace in your report: which `<h3>` matches, how many `parentElement` hops it takes to reach an ancestor whose subtree contains the right `<p>`, and confirm it's within the 5-level cap.

- [ ] **Step 6: Commit**

```bash
git add extension/content.js extension/manifest.json
git commit -m "feat: add content script to scrape project memory/instructions from DOM"
```

---

## Task 2: Wire popup.js to request project metadata and pass it to the zip builder

**Files:**
- Modify: `extension/popup.js`

**Interfaces:**
- Consumes: the content script's message contract from Task 1 (`chrome.tabs.sendMessage(tabId, {type: 'GET_PROJECT_METADATA'})` resolving to `{memory: string|null, instructions: string|null}`, or rejecting if no listener is present).
- Produces: `runExport()`'s `project` branch now calls `buildProjectZip(exportProjectId, conversations, projectMetadata)` (3-arg form) instead of the current 2-arg form — this is the interface Task 3 must implement.

- [ ] **Step 1: Modify the project branch of runExport() in popup.js**

In `extension/popup.js`, locate the `if (exportMode === 'project') { ... }` block (currently lines 60-85). Replace it with:

```javascript
    if (exportMode === 'project') {
      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, exportProjectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      let projectMetadata = { memory: null, instructions: null };
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive — proceed without memory/instructions.
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      blob = await buildProjectZip(exportProjectId, conversations, projectMetadata);
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        setStatus(`✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`, 'success');
      } else {
        setStatus(`✅ Exported ${conversations.length} conversations.`, 'success');
      }
    } else if (exportMode === 'conversation') {
```

(The `else if (exportMode === 'conversation') {` line marks where the existing next block begins — do not duplicate it, this just shows the seam so you can locate the correct insertion point. Everything from `} else if (exportMode === 'conversation') {` onward, through the end of the function, stays exactly as it currently is — unchanged.)

Design notes:
- The metadata fetch happens BEFORE `fetchAllConversations` (which can take a while for large projects) so the tab is queried while still fresh/active, and so a failure here surfaces early via the try/catch without affecting the conversations fetch that follows.
- `chrome.tabs.sendMessage` rejects with an error (not resolves with `undefined`) when there's no listener in the target tab (e.g., the content script didn't inject because the user is on a project page loaded before the extension was installed/reloaded, or on some other claude.ai page that doesn't match `https://claude.ai/project/*`). The try/catch swallows this silently by design — per the spec, missing memory/instructions must never fail the export.
- The `if (response)` guard handles the case where `sendMessage` resolves but the content script's `sendResponse` was somehow called with `undefined`/`null` — defensive, keeps `projectMetadata` at its safe default in that case too.

- [ ] **Step 2: Verify popup.js is syntactically valid**

If Node is available:
```bash
node -c extension/popup.js
```
Expected: no output (success).

- [ ] **Step 3: Cross-check the new call site against Task 3's planned interface**

Read this plan's Task 3 brief section (or, if Task 3 is already implemented when you do this, read the actual `extension/lib/zipBuilder.js`) and confirm `buildProjectZip(exportProjectId, conversations, projectMetadata)` — 3 positional args, in that order — matches the function signature. If Task 3 is not yet implemented, this is a forward-reference check: just confirm your call site matches the signature documented in this plan's Task 3 "Interfaces" section below.

- [ ] **Step 4: Commit**

```bash
git add extension/popup.js
git commit -m "feat: request project memory/instructions from content script during export"
```

---

## Task 3: Extend zipBuilder to write memory.md, instructions.md, and the fichiers/ placeholder

**Files:**
- Modify: `extension/lib/zipBuilder.js`

**Interfaces:**
- Consumes: `projectMetadata` object of shape `{memory: string|null, instructions: string|null}` (or `undefined`/`null` entirely) as produced by Task 2's `popup.js` call site.
- Produces: `buildProjectZip(projectId, conversations, projectMetadata)` — the 3rd parameter is optional (function must not throw if called with only 2 args, matching the spec's "optional" note so any other future caller isn't broken).

- [ ] **Step 1: Modify buildProjectZip in zipBuilder.js**

In `extension/lib/zipBuilder.js`, replace the `buildProjectZip` function (currently lines 8-18) with:

```javascript
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

  conversations.forEach(conv => {
    const folderName = conversationFolderName(conv);
    buildConversationFolder(zip, folderName, conv);
  });

  return zip.generateAsync({ type: 'blob' });
}
```

Leave `buildConversationFolder` and `buildConversationZip` (the rest of the file) completely unchanged.

- [ ] **Step 2: Verify zipBuilder.js is syntactically valid**

If Node is available:
```bash
node -c extension/lib/zipBuilder.js
```
Expected: no output (success).

- [ ] **Step 3: Verify the function logically handles all input shapes**

By code review (no live JSZip execution needed — this was already validated in the prior plan's Task 6 review for the sibling `buildConversationFolder`/`.folder().file()` pattern), confirm:
- Called as `buildProjectZip(id, convs, {memory: 'text', instructions: 'text'})` → both `memory.md` and `instructions.md` are added.
- Called as `buildProjectZip(id, convs, {memory: null, instructions: 'text'})` → only `instructions.md` is added.
- Called as `buildProjectZip(id, convs, {memory: null, instructions: null})` → neither file is added, `fichiers/.gitkeep` still is.
- Called as `buildProjectZip(id, convs, undefined)` or `buildProjectZip(id, convs)` (2-arg call) → the `projectMetadata && ...` guards short-circuit safely, no `TypeError` from reading `.memory`/`.instructions` off `undefined`, `fichiers/.gitkeep` still is added and existing conversations/index behavior is fully unchanged.

Write this trace out in your report.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/zipBuilder.js
git commit -m "feat: write memory.md, instructions.md, and fichiers/ placeholder to project zip"
```

---

## Self-Review Notes

- **Spec coverage:** content script scraping Memory/Instructions (Task 1), graceful no-op on missing content script or missing sections (Task 1 + Task 2's try/catch), `memory.md`/`instructions.md` conditionally written (Task 3), empty `fichiers/` placeholder (Task 3), single-conversation export untouched (no task modifies `buildConversationZip`), no new permissions (Task 1's manifest change verified to need none beyond existing `host_permissions`) — all covered.
- **Placeholder scan:** all code blocks are complete and copy-pasteable; no TBD/TODO.
- **Type consistency:** `buildProjectZip(projectId, conversations, projectMetadata)` signature is identical between Task 2's call site and Task 3's implementation — 3 positional args, `projectMetadata` shaped `{memory, instructions}`. The content script's response shape (`{memory: string|null, instructions: string|null}`, Task 1) matches what Task 2 assigns to `projectMetadata` and what Task 3 destructures.
- **Scope check:** this plan only touches project export; single-conversation export (`buildConversationZip`, the `else if (exportMode === 'conversation')` branch of `popup.js`) is explicitly unmodified in every task — confirmed no task's file changes touch that code path.
