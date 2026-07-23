# Content Script Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `scripting`-permission-based content script re-injection helper so the "extension was reloaded while the tab was already open" case recovers silently, without requiring a manual page refresh, at the 5 confirmed entry-point call sites.

**Architecture:** Pure HTML/JS/manifest changes across `extension/manifest.json`, `extension/sidepanel.js`, and `extension/lib/gptExport.js`. No new files, no build step. Task 1 adds the permission and the `sendMessageWithRecovery` helper (a self-contained addition with no dependents yet). Task 2 applies it to the 4 `sidepanel.js` call sites and fixes the `startGptSelection` latent bug. Task 3 applies it to the 1 `gptExport.js` call site, which depends on Task 1's helper existing (cross-file, but same shared global scope per existing convention — see Global Constraints).

**Tech Stack:** Vanilla JS, Manifest V3 side panel, no frameworks/bundler (per `CLAUDE.md`).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no build step.
- `sendMessageWithRecovery` is fallback-after-failure, not ping-first: try the normal `sendMessage` first;
  only on failure, inject via `chrome.scripting.executeScript` and retry once.
- If the retry after injection also fails, the exception propagates unchanged to the caller — every
  existing `try/catch` and error message at each call site stays exactly as it is today. No new error
  message copy.
- No retry loop or backoff — exactly one re-attempt after one injection attempt, per call.
- `extension/sidepanel.js` and `extension/lib/gptExport.js` are both loaded as plain `<script>` tags in
  `extension/sidepanel.html` (no ES modules), sharing one global scope — `gptExport.js` already calls
  `waitForContentScriptReady`, a function defined in `sidepanel.js`, using this exact convention. Script
  *load* order (`gptExport.js` loads before `sidepanel.js` in the HTML) does not matter here because
  `sendMessageWithRecovery` is only *called* later at runtime, after both scripts have fully executed and
  registered their top-level function declarations.
- Do not change any call sites explicitly listed as out-of-scope in the spec (batch/export loop internals,
  polling calls, post-selection-mode calls) — see the spec's "Call sites intentionally left unchanged"
  section for the full list and reasoning.
- No automated test suite exists for this extension — verification is manual, via `chrome://extensions`
  reload + live browser testing (per `CLAUDE.md`'s Testing Approach).

---

### Task 1: Add `scripting` permission and `sendMessageWithRecovery` helper

**Files:**
- Modify: `extension/manifest.json:6` (add `"scripting"` to `permissions`)
- Modify: `extension/sidepanel.js` (add `sendMessageWithRecovery` function near the top of the file)

**Interfaces:**
- Produces: `sendMessageWithRecovery(tabId, message, contentScriptFile)` — an async function returning
  whatever `chrome.tabs.sendMessage` would return, or throwing whatever it would throw if both the initial
  send and the post-injection retry fail. Consumed by Task 2 (4 call sites in `sidepanel.js`) and Task 3 (1
  call site in `gptExport.js`).

- [ ] **Step 1: Add the `scripting` permission to the manifest**

Find (`extension/manifest.json:6`):

```json
  "permissions": ["downloads", "activeTab", "cookies", "sidePanel", "tabs"],
```

Replace with:

```json
  "permissions": ["downloads", "activeTab", "cookies", "sidePanel", "tabs", "scripting"],
```

- [ ] **Step 2: Add the `sendMessageWithRecovery` helper**

In `extension/sidepanel.js`, immediately before the existing `function isProjectsListingUrl(url) {` (currently line 9), add:

```js
async function sendMessageWithRecovery(tabId, message, contentScriptFile) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [contentScriptFile] });
    } catch (injectError) {
      throw e; // Injection itself failed (e.g. tab navigated away) — surface the original error.
    }
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

```

- [ ] **Step 3: Manually verify**

Run:
```bash
cd "c:\Users\boome\Desktop\code\claude-project-conversations-exporter"
```
Reload the unpacked extension (`chrome://extensions` → reload icon). Open `chrome://extensions`, confirm
LLM Vault's permissions now list "Read and change your data on claude.ai and chatgpt.com" style entries
without a new warning dialog (the `scripting` permission does not require a separate user-facing grant
beyond what `host_permissions` + `activeTab` already cover — confirm no unexpected permission prompt
appears).

Open the side panel on any claude.ai page. Confirm no console errors (right-click inside panel → Inspect) —
`sendMessageWithRecovery` is defined but not yet called by anything, so this step only confirms the addition
didn't break existing behavior.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json extension/sidepanel.js
git commit -m "$(cat <<'EOF'
feat: add scripting permission and sendMessageWithRecovery helper

Lays the groundwork for auto-recovering from a missing content
script (e.g. after the extension is reloaded while a claude.ai/
chatgpt.com tab is already open) without requiring a manual page
refresh. Not yet wired into any call site.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Apply recovery to the 4 `sidepanel.js` entry points + fix `startGptSelection`

**Files:**
- Modify: `extension/sidepanel.js:368-380` (`enterSelectionMode`)
- Modify: `extension/sidepanel.js:434-445` (`enterRecentsSelectionMode`)
- Modify: `extension/sidepanel.js:805-816` (`runExport`, project-mode branch — `GET_PROJECT_METADATA`)
- Modify: `extension/sidepanel.js:879-891` (`runExport`, conversation-mode branch — `GET_CONVERSATION_ARTIFACTS`)
- Modify: `extension/sidepanel.js:962-965` (`startGptSelection`)

**Interfaces:**
- Consumes: `sendMessageWithRecovery(tabId, message, contentScriptFile)` from Task 1.

- [ ] **Step 1: `enterSelectionMode` — Claude project-list selection**

Find (currently lines 368-380):

```js
async function enterSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isGptHost(tab.url || '')) return; // GPT uses its own onclick handler
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
```

Replace the `sendMessage` line only:

```js
async function enterSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isGptHost(tab.url || '')) return; // GPT uses its own onclick handler
  try {
    const response = await sendMessageWithRecovery(tab.id, { type: 'START_SELECTION_MODE' }, 'content.js');
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the project list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }
```

- [ ] **Step 2: `enterRecentsSelectionMode` — Claude recents selection**

Find (currently lines 434-445):

```js
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
```

Replace the `sendMessage` line only:

```js
async function enterRecentsSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await sendMessageWithRecovery(tab.id, { type: 'START_RECENTS_SELECTION_MODE' }, 'content.js');
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the conversations list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }
```

- [ ] **Step 3: `runExport` — project-mode branch (`GET_PROJECT_METADATA`)**

Find (currently lines 805-816):

```js
      let projectMetadata = { memory: null, instructions: null };
      let contentScriptUnreachable = false;
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without memory/instructions.
        contentScriptUnreachable = true;
      }
```

Replace the `sendMessage` line only:

```js
      let projectMetadata = { memory: null, instructions: null };
      let contentScriptUnreachable = false;
      try {
        const response = await sendMessageWithRecovery(tabId, { type: 'GET_PROJECT_METADATA' }, 'content.js');
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded, and recovery via sendMessageWithRecovery
        // also failed) — proceed without memory/instructions.
        contentScriptUnreachable = true;
      }
```

- [ ] **Step 4: `runExport` — conversation-mode branch (`GET_CONVERSATION_ARTIFACTS`)**

Find (currently lines 879-891):

```js
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' });
        if (response) {
          // Image content files still come from the DOM (their /preview URL
          // isn't derivable from a /mnt/user-data path), merged alongside
          // the JSON-derived uploads.
          artifactsData.contentFiles = [...artifactsData.contentFiles, ...(response.contentFiles || [])];
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without image content files.
```

Replace the `sendMessage` line only:

```js
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await sendMessageWithRecovery(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' }, 'content.js');
        if (response) {
          // Image content files still come from the DOM (their /preview URL
          // isn't derivable from a /mnt/user-data path), merged alongside
          // the JSON-derived uploads.
          artifactsData.contentFiles = [...artifactsData.contentFiles, ...(response.contentFiles || [])];
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded, and recovery via sendMessageWithRecovery
        // also failed) — proceed without image content files.
```

- [ ] **Step 5: `startGptSelection` — fix the latent missing try/catch, then apply recovery**

Find (currently lines 962-965):

```js
async function startGptSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await chrome.tabs.sendMessage(tab.id, { type: 'START_GPT_SELECTION_MODE' });
  if (!resp || !resp.armed) return;
```

Replace with:

```js
async function startGptSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let resp;
  try {
    resp = await sendMessageWithRecovery(tab.id, { type: 'START_GPT_SELECTION_MODE' }, 'content-gpt.js');
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }
  if (!resp || !resp.armed) return;
```

This adds the previously-missing `try/catch` (an existing latent bug — an unhandled rejection if the
content script was unreachable) with the same error message convention already used by
`enterSelectionMode`/`enterRecentsSelectionMode`, in addition to wiring in recovery.

- [ ] **Step 6: Manually verify**

Reload the unpacked extension (`chrome://extensions` → reload icon). For each of the following, first
simulate the failure condition (open the relevant page, reload the extension without reloading the tab —
this detaches the tab's existing content script from the newly-reloaded extension), then click the button:

Test A: On a claude.ai project-listing page, click **Select Projects**. Confirm selection mode starts
successfully (no error message), with project-card selection styling working.

Test B: On `claude.ai/recents`, click **Select Conversations**. Confirm the same successful recovery.

Test C: On `chatgpt.com/projects`, click **Select GPT Projects**. Confirm the same successful recovery, and
confirm no unhandled-rejection console error appears if you additionally test the pre-existing failure mode
(e.g. by testing against a page where the projects grid genuinely isn't present) — the panel should now show
the "Could not start selection mode..." message instead of a silent console error.

Test D: On a claude.ai project page, click **Export Project**. Confirm the exported zip's `index.md` includes
Memory/Instructions content (previously would have been missing until a manual tab refresh).

Test E: On a claude.ai conversation page with image attachments, click **Export Conversation**. Confirm the
exported zip's `contenu/` folder includes the image content files.

- [ ] **Step 7: Commit**

```bash
git add extension/sidepanel.js
git commit -m "$(cat <<'EOF'
feat: auto-recover missing content script at 4 sidepanel.js entry points

Wires sendMessageWithRecovery into enterSelectionMode,
enterRecentsSelectionMode, runExport (both project- and
conversation-mode branches), and startGptSelection — the real
entry-point call sites where a tab opened before the extension was
last reloaded would otherwise require a manual page refresh. Also
fixes a latent bug in startGptSelection, which had no try/catch
around its sendMessage call at all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Apply recovery to `gptExport.js`'s entry point

**Files:**
- Modify: `extension/lib/gptExport.js:44` (`gptScrapeProject`)

**Interfaces:**
- Consumes: `sendMessageWithRecovery(tabId, message, contentScriptFile)` from Task 1 (called across the
  `sidepanel.js`/`gptExport.js` shared global scope, per the existing `waitForContentScriptReady` precedent
  noted in Global Constraints).

- [ ] **Step 1: Wrap `GET_GPT_PROJECT_METADATA` in recovery**

Find (currently in `gptScrapeProject`, lines 43-45):

```js
  // 2. Instructions + conversation list.
  const project = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_METADATA' });
  const listResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_CONVERSATIONS' });
```

Replace the first `sendMessage` line only:

```js
  // 2. Instructions + conversation list.
  const project = await sendMessageWithRecovery(tabId, { type: 'GET_GPT_PROJECT_METADATA' }, 'content-gpt.js');
  const listResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_CONVERSATIONS' });
```

(`GET_GPT_PROJECT_CONVERSATIONS` on the next line is intentionally left unchanged — if the content script was
missing, the first call's recovery already injected it, so the second call now succeeds against a script that
is confirmed present; per the spec, this task covers only the true entry point of this flow.)

- [ ] **Step 2: Manually verify**

Reload the unpacked extension. Simulate the failure condition: open a chatgpt.com project page, reload the
extension without reloading the tab, then click **Export GPT Project**. Confirm the export completes
successfully (the project's instructions and conversation list are captured) instead of failing with the
generic "Export failed" message that would have resulted from a missing content script today.

- [ ] **Step 3: Commit**

```bash
git add extension/lib/gptExport.js
git commit -m "$(cat <<'EOF'
feat: auto-recover missing content script in gptScrapeProject

Wires sendMessageWithRecovery into GET_GPT_PROJECT_METADATA, the
true entry point of GPT project export (startGptProjectExport
delegates here immediately) — the last of the 5 entry points
identified in the design spec.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
