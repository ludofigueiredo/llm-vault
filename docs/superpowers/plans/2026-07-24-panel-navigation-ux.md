# Panel Navigation UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add active-site button highlighting, a visual separator, a permanent Project/Conversation navigation block, and Cancel buttons for the three existing selection-mode flows to the LLM Vault side panel.

**Architecture:** Pure HTML/CSS/JS changes inside the existing single-page side panel (`extension/sidepanel.html` + `extension/sidepanel.js`). No new files, no build step. Task 1 handles styling primitives (active-site class, separator) that Task 2 reuses. Task 2 adds the new Project/Conversation block. Task 3 (Cancel buttons) is independent of Tasks 1-2 and can be done in any order relative to them, but is sequenced last here since it's the most self-contained.

**Tech Stack:** Vanilla JS, Manifest V3 side panel, no frameworks/bundler (per `CLAUDE.md`).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no build step.
- No dark mode / `prefers-color-scheme` support — explicitly rejected by the user. The separator is a
  single more-contrasted rule within the existing light palette only.
- No new CSS color tokens beyond the one explicitly specified (`--separator: #D8D4C4`) — otherwise reuse
  existing `:root` variables (`--surface-inset`, `--text-primary`, `--border`, etc.).
- Copy is in English, matching the rest of `sidepanel.html`.
- No automated test suite exists for this extension — verification is manual, via `chrome://extensions`
  reload + live browser testing (per `CLAUDE.md`'s Testing Approach).
- Do not change the export pipelines or the `content.js`/`content-gpt.js` selection-mode click-capture
  logic — `STOP_SELECTION_MODE` / `STOP_RECENTS_SELECTION_MODE` / `STOP_GPT_SELECTION_MODE` messages already
  exist and are reused as-is.
- ChatGPT has no dedicated conversation-history URL; `https://chatgpt.com/` (root) is the accepted target
  for the "Conversation" button on GPT, per spec.

---

### Task 1: Active-site button styling + home/panel separator

**Files:**
- Modify: `extension/sidepanel.html` (CSS `:root` block, new `.is-active-site`/`.home-separator` rules,
  `.home-actions` → `.button-row` rename, new `<hr>` element)
- Modify: `extension/sidepanel.js:105-225` (`detectGptContext`, `detectContext`)

**Interfaces:**
- Consumes: existing `--surface-inset`, `--text-primary`, `--border` CSS variables; existing
  `detectContext()`/`detectGptContext()` functions.
- Produces: `.is-active-site` CSS class (consumed by Task 2 for the Project/Conversation buttons) and
  `.button-row` CSS class (consumed by Task 2 for the new block's button layout). `setHomeActiveButton(isGpt)`
  JS function.

- [ ] **Step 1: Add the `--separator` token to `:root`**

In `extension/sidepanel.html`, find the `:root` block:

```css
    :root {
      --bg: #F7F5EE;
      --surface: #FFFFFF;
      --surface-inset: #FAF9F5;
      --border: #ECE9DE;
```

Add `--separator` right after `--border`:

```css
    :root {
      --bg: #F7F5EE;
      --surface: #FFFFFF;
      --surface-inset: #FAF9F5;
      --border: #ECE9DE;
      --separator: #D8D4C4;
```

- [ ] **Step 2: Rename `.home-actions` to `.button-row`**

Find:

```css
    .home-actions {
      display: flex;
      gap: 8px;
    }

    .home-actions button {
      flex: 1;
      margin-top: 0;
    }
```

Replace with:

```css
    .button-row {
      display: flex;
      gap: 8px;
    }

    .button-row button {
      flex: 1;
      margin-top: 0;
    }
```

- [ ] **Step 3: Add `.is-active-site` and `.home-separator` CSS rules**

Immediately after the `.button-row button { ... }` rule from Step 2, add:

```css
    .is-active-site {
      background: var(--surface-inset);
      color: var(--text-primary);
      border-color: var(--border);
    }

    .is-active-site:hover:not(:disabled) {
      background: var(--surface-inset);
      opacity: 1;
    }

    .home-separator {
      border: none;
      border-top: 1px solid var(--separator);
      margin: 20px 0;
    }
```

- [ ] **Step 4: Update the HTML to use `.button-row` and add the separator**

Find:

```html
    <div class="home-actions">
      <button id="goto-claude-btn" type="button">Open Claude</button>
      <button id="goto-gpt-btn" type="button">Open ChatGPT</button>
    </div>
  </div>
  <div class="panel">
```

Replace with:

```html
    <div class="button-row">
      <button id="goto-claude-btn" type="button">Open Claude</button>
      <button id="goto-gpt-btn" type="button">Open ChatGPT</button>
    </div>
  </div>
  <hr class="home-separator">
  <div class="panel">
```

- [ ] **Step 5: Add the `setHomeActiveButton` helper to `sidepanel.js`**

In `extension/sidepanel.js`, immediately before the `function detectGptContext(url, tab) {` line (currently
line 105), add:

```js
function setHomeActiveButton(isGpt) {
  document.getElementById('goto-claude-btn').classList.toggle('is-active-site', !isGpt);
  document.getElementById('goto-gpt-btn').classList.toggle('is-active-site', isGpt);
}

```

- [ ] **Step 6: Call `setHomeActiveButton(true)` at the top of `detectGptContext`**

Find (currently lines 105-107):

```js
function detectGptContext(url, tab) {
  if (selectionMode || batchInProgress) return;

```

Replace with:

```js
function detectGptContext(url, tab) {
  if (selectionMode || batchInProgress) return;

  setHomeActiveButton(true);

```

- [ ] **Step 7: Call `setHomeActiveButton(false)` at the top of `detectContext`'s Claude branch**

Find (currently lines 147-153):

```js
async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }

```

Replace with:

```js
async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }

  setHomeActiveButton(false);

```

- [ ] **Step 8: Manually verify**

Run:
```bash
cd "c:\Users\boome\Desktop\code\claude-project-conversations-exporter"
```
Reload the unpacked extension (`chrome://extensions` → reload icon), open the side panel.

Test A: On any non-claude.ai/non-chatgpt.com page, confirm no JS errors in the panel's console (right-click
inside panel → Inspect) — `setHomeActiveButton` is not called in this case (acceptable, since neither button
should be marked active when on neither site), and both buttons keep their normal solid style.

Test B: Navigate to `https://claude.ai`. Confirm "Open Claude" now has a visibly lighter/muted background
(`--surface-inset`, `#FAF9F5`) while "Open ChatGPT" keeps the solid dark `--accent` background.

Test C: Navigate to `https://chatgpt.com`. Confirm the styles swap — "Open ChatGPT" is now muted, "Open
Claude" is solid.

Test D: Confirm the horizontal separator renders between the home block and the panel block, with visible
extra spacing (20px margin) and a more contrasted line than the panel's own border.

- [ ] **Step 9: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "$(cat <<'EOF'
redesign: highlight active-site button + add home/panel separator

Open Claude/Open ChatGPT now shows a muted background for whichever
site the active tab is currently on. A horizontal rule with extra
spacing now separates the home block from the contextual panel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Project / Conversation navigation block

**Files:**
- Modify: `extension/sidepanel.html` (new `.provider-nav`/`.provider-nav-actions` CSS, new
  `#provider-nav` HTML block)
- Modify: `extension/sidepanel.js:9-25` (add two new URL helpers near existing `isProjectsListingUrl`/
  `isRecentsUrl`), `extension/sidepanel.js:105-225` (`detectGptContext`, `detectContext` — call
  `updateProviderNav`), `extension/sidepanel.js:266-292` (`DOMContentLoaded` handler — register two new
  click listeners), plus one new `updateProviderNav` function.

**Interfaces:**
- Consumes: `.is-active-site` and `.button-row` CSS classes from Task 1; existing `gotoSite(url)` helper
  (`extension/sidepanel.js:233-236`); existing `isGptHost(url)` (from `extension/lib/gptDetect.js`);
  existing `isProjectsListingUrl(url)`/`isRecentsUrl(url)` (`extension/sidepanel.js:9-25`).
- Produces: `#goto-project-btn`/`#goto-conversation-btn` button IDs; `updateProviderNav(url, isGpt)`
  function (called only within this task and Task 1's `detectContext`/`detectGptContext`, no other task
  depends on it).

- [ ] **Step 1: Add CSS for the new block**

In `extension/sidepanel.html`, immediately after the `.home-separator { ... }` rule added in Task 1 Step 3,
add:

```css
    .provider-nav {
      padding: 0 4px 18px;
    }
```

- [ ] **Step 2: Add the HTML block**

Find (after Task 1's Step 4 changes):

```html
  <hr class="home-separator">
  <div class="panel">
```

Replace with:

```html
  <hr class="home-separator">
  <div class="provider-nav" id="provider-nav" style="display:none;">
    <div class="button-row">
      <button id="goto-project-btn" type="button">Project</button>
      <button id="goto-conversation-btn" type="button">Conversation</button>
    </div>
  </div>
  <div class="panel">
```

- [ ] **Step 3: Add the two new GPT URL-matching helpers**

In `extension/sidepanel.js`, immediately after the existing `isRecentsUrl` function (currently lines 18-25):

```js
function isRecentsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && (parsed.pathname === '/recents' || parsed.pathname === '/chats');
  } catch (e) {
    return false;
  }
}

function isGptProjectsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chatgpt.com' && parsed.pathname === '/projects';
  } catch (e) {
    return false;
  }
}

function isGptConversationsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chatgpt.com' && parsed.pathname === '/';
  } catch (e) {
    return false;
  }
}
```

- [ ] **Step 4: Add the four URL-builder helpers and `updateProviderNav`**

In `extension/sidepanel.js`, immediately after the `gotoSite` function (currently lines 233-236):

```js
async function gotoSite(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.update(tab.id, { url });
}

function claudeProjectsUrl() { return 'https://claude.ai/cowork/projects'; }
function claudeConversationsUrl() { return 'https://claude.ai/chats'; }
function gptProjectsUrl() { return 'https://chatgpt.com/projects'; }
function gptConversationsUrl() { return 'https://chatgpt.com/'; }

function updateProviderNav(url, isGpt) {
  const nav = document.getElementById('provider-nav');
  const projectBtn = document.getElementById('goto-project-btn');
  const conversationBtn = document.getElementById('goto-conversation-btn');
  nav.style.display = 'block';

  const onProjectsListing = isGpt ? isGptProjectsListingUrl(url) : isProjectsListingUrl(url);
  const onConversationsListing = isGpt ? isGptConversationsListingUrl(url) : isRecentsUrl(url);

  projectBtn.classList.toggle('is-active-site', onProjectsListing);
  conversationBtn.classList.toggle('is-active-site', onConversationsListing);
}
```

- [ ] **Step 5: Call `updateProviderNav(url, true)` from `detectGptContext`**

Find (after Task 1 Step 6's change):

```js
function detectGptContext(url, tab) {
  if (selectionMode || batchInProgress) return;

  setHomeActiveButton(true);

```

Replace with:

```js
function detectGptContext(url, tab) {
  if (selectionMode || batchInProgress) return;

  setHomeActiveButton(true);
  updateProviderNav(url, true);

```

- [ ] **Step 6: Call `updateProviderNav`/hide the block from `detectContext`**

Find (after Task 1 Step 7's change):

```js
  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }

  setHomeActiveButton(false);

```

Replace with:

```js
  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }

  setHomeActiveButton(false);

  let onClaudeHost = false;
  try {
    onClaudeHost = new URL(url).hostname === 'claude.ai';
  } catch (e) {
    onClaudeHost = false;
  }
  if (onClaudeHost) {
    updateProviderNav(url, false);
  } else {
    document.getElementById('provider-nav').style.display = 'none';
  }

```

- [ ] **Step 7: Register the two click listeners in `DOMContentLoaded`**

Find (currently lines 266-273):

```js
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('goto-claude-btn').addEventListener('click', () => {
    gotoSite('https://claude.ai');
  });
  document.getElementById('goto-gpt-btn').addEventListener('click', () => {
    gotoSite('https://chatgpt.com');
  });
```

Add two new listeners right after the `goto-gpt-btn` one:

```js
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('goto-claude-btn').addEventListener('click', () => {
    gotoSite('https://claude.ai');
  });
  document.getElementById('goto-gpt-btn').addEventListener('click', () => {
    gotoSite('https://chatgpt.com');
  });
  document.getElementById('goto-project-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = isGptHost(tab.url || '') ? gptProjectsUrl() : claudeProjectsUrl();
    gotoSite(target);
  });
  document.getElementById('goto-conversation-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = isGptHost(tab.url || '') ? gptConversationsUrl() : claudeConversationsUrl();
    gotoSite(target);
  });
```

- [ ] **Step 8: Manually verify**

Reload the unpacked extension, open the side panel.

Test A: On a non-claude.ai/non-chatgpt.com page, confirm the `#provider-nav` block is hidden (no "Project"/
"Conversation" buttons visible).

Test B: Navigate to `claude.ai` (any page — e.g. a project or conversation page). Confirm the
Project/Conversation block is visible, positioned between the separator and the existing contextual panel.

Test C: Click "Project". Confirm the active tab navigates to `https://claude.ai/cowork/projects`, and once
loaded, the "Project" button shows the `is-active-site` muted style (since the URL now matches
`isProjectsListingUrl`).

Test D: Click "Conversation". Confirm navigation to `https://claude.ai/chats`, and the "Conversation" button
shows the muted style once loaded (matches `isRecentsUrl`).

Test E: Navigate to `https://chatgpt.com/projects`. Confirm the "Project" button shows the muted style.
Navigate to `https://chatgpt.com/`. Confirm the "Conversation" button shows the muted style instead.

Test F: Confirm existing flows (Export Project/Conversation, Select Projects, Select Conversations) still
work unaffected by the new block's presence.

- [ ] **Step 9: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "$(cat <<'EOF'
feat: add permanent Project/Conversation navigation block

Adds a new block below the home separator, visible whenever the
active tab is on claude.ai or chatgpt.com, with Project and
Conversation buttons that navigate to each provider's projects
listing or conversation-history page. Buttons highlight when the
active tab is already on their target page.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Cancel buttons for selection-mode flows

**Files:**
- Modify: `extension/sidepanel.html` (new `#cancel-selection-btn`/`#cancel-recents-selection-btn` HTML +
  CSS)
- Modify: `extension/sidepanel.js:266-292` (`DOMContentLoaded` — register two new listeners),
  `extension/sidepanel.js:294-314` (`enterSelectionMode` — show cancel button),
  `extension/sidepanel.js:337-357` (`enterRecentsSelectionMode` — show cancel button), plus two new
  functions `cancelSelection`/`cancelRecentsSelection`.

**Interfaces:**
- Consumes: existing `STOP_SELECTION_MODE`/`STOP_GPT_SELECTION_MODE`/`STOP_RECENTS_SELECTION_MODE` chrome
  messages (already implemented in `content.js`/`content-gpt.js`); existing `selectionMode`/
  `recentsSelectionMode`/`selectionPollTimer`/`recentsSelectionPollTimer` globals; existing `isGptHost(url)`;
  existing `detectContext()`.
- Produces: `#cancel-selection-btn`/`#cancel-recents-selection-btn` button IDs (no other task depends on
  these).

- [ ] **Step 1: Add CSS for the Cancel buttons**

In `extension/sidepanel.html`, find the existing secondary-style comment block:

```css
    /* Secondary-style actions: outline instead of solid fill */
    #select-all-recents-btn {
      background: var(--surface);
      color: var(--text-primary);
      border-color: var(--border);
    }
```

Replace with (adding the two new button IDs to the same rule, since they share the identical outline
style):

```css
    /* Secondary-style actions: outline instead of solid fill */
    #select-all-recents-btn,
    #cancel-selection-btn,
    #cancel-recents-selection-btn {
      background: var(--surface);
      color: var(--text-primary);
      border-color: var(--border);
    }
```

- [ ] **Step 2: Add the two new buttons to the HTML**

Find:

```html
    <button id="select-projects-btn" style="display:none;">Select Projects</button>
    <button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
    <button id="select-recents-btn" style="display:none;">Select Conversations</button>
    <button id="select-all-recents-btn" style="display:none;">Select All</button>
    <button id="confirm-recents-selection-btn" style="display:none;">Confirm Selection (0)</button>
```

Replace with:

```html
    <button id="select-projects-btn" style="display:none;">Select Projects</button>
    <button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
    <button id="cancel-selection-btn" style="display:none;">Cancel</button>
    <button id="select-recents-btn" style="display:none;">Select Conversations</button>
    <button id="select-all-recents-btn" style="display:none;">Select All</button>
    <button id="confirm-recents-selection-btn" style="display:none;">Confirm Selection (0)</button>
    <button id="cancel-recents-selection-btn" style="display:none;">Cancel</button>
```

- [ ] **Step 3: Add `cancelSelection` and `cancelRecentsSelection` functions**

In `extension/sidepanel.js`, immediately after the `pollSelectionCount` function (currently lines 318-335,
ending with the closing `}` of the `setInterval` callback and the function itself), add:

```js
async function cancelSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (isGptHost(tab.url || '')) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_GPT_SELECTION_MODE' });
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SELECTION_MODE' });
    }
  } catch (e) {
    // Content script unreachable (e.g. navigated away) — still reset local
    // panel state below so the user isn't stuck in selection mode.
  }
  if (selectionPollTimer) {
    clearInterval(selectionPollTimer);
    selectionPollTimer = null;
  }
  selectionMode = false;
  document.getElementById('confirm-selection-btn').style.display = 'none';
  document.getElementById('cancel-selection-btn').style.display = 'none';
  detectContext();
}
```

Then, immediately after the `pollRecentsSelectionCount` function (currently lines 361-378), add:

```js
async function cancelRecentsSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECENTS_SELECTION_MODE' });
  } catch (e) {
    // Content script unreachable — still reset local panel state.
  }
  if (recentsSelectionPollTimer) {
    clearInterval(recentsSelectionPollTimer);
    recentsSelectionPollTimer = null;
  }
  recentsSelectionMode = false;
  document.getElementById('select-all-recents-btn').style.display = 'none';
  document.getElementById('confirm-recents-selection-btn').style.display = 'none';
  document.getElementById('cancel-recents-selection-btn').style.display = 'none';
  detectContext();
}
```

- [ ] **Step 4: Register the two new click listeners in `DOMContentLoaded`**

Find (after Task 2 Step 7's changes, the listeners block ends with):

```js
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

Replace with:

```js
  document.getElementById('confirm-selection-btn').addEventListener('click', () => {
    confirmSelection();
  });
  document.getElementById('cancel-selection-btn').addEventListener('click', () => {
    cancelSelection();
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
  document.getElementById('cancel-recents-selection-btn').addEventListener('click', () => {
    cancelRecentsSelection();
  });
});
```

- [ ] **Step 5: Show the Cancel button in `enterSelectionMode`**

Find (currently lines 294-314):

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

  selectionMode = true;
  document.getElementById('select-projects-btn').style.display = 'none';
  document.getElementById('confirm-selection-btn').style.display = 'block';
  document.getElementById('confirm-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click project cards to select them, then click Confirm.';
  pollSelectionCount();
}
```

Replace the last five lines (from `selectionMode = true;` to `pollSelectionCount();`) with:

```js
  selectionMode = true;
  document.getElementById('select-projects-btn').style.display = 'none';
  document.getElementById('confirm-selection-btn').style.display = 'block';
  document.getElementById('confirm-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('cancel-selection-btn').style.display = 'block';
  document.getElementById('context-message').textContent = 'Click project cards to select them, then click Confirm.';
  pollSelectionCount();
}
```

- [ ] **Step 6: Show the Cancel button in `startGptSelection`**

Find (currently lines 846-856):

```js
async function startGptSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await chrome.tabs.sendMessage(tab.id, { type: 'START_GPT_SELECTION_MODE' });
  if (!resp || !resp.armed) return;
  selectionMode = true;
  const selectBtn = document.getElementById('select-projects-btn');
  const confirmBtn = document.getElementById('confirm-selection-btn');
  selectBtn.style.display = 'none';
  confirmBtn.style.display = 'block';
  confirmBtn.textContent = 'Confirm Selection (0)';
  confirmBtn.onclick = () => confirmGptSelection(tab);
```

Add one line showing the cancel button, right after `confirmBtn.textContent = 'Confirm Selection (0)';`:

```js
async function startGptSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await chrome.tabs.sendMessage(tab.id, { type: 'START_GPT_SELECTION_MODE' });
  if (!resp || !resp.armed) return;
  selectionMode = true;
  const selectBtn = document.getElementById('select-projects-btn');
  const confirmBtn = document.getElementById('confirm-selection-btn');
  selectBtn.style.display = 'none';
  confirmBtn.style.display = 'block';
  confirmBtn.textContent = 'Confirm Selection (0)';
  document.getElementById('cancel-selection-btn').style.display = 'block';
  confirmBtn.onclick = () => confirmGptSelection(tab);
```

(The GPT flow reuses the same `#cancel-selection-btn`/`cancelSelection()` as Claude-projects selection —
`cancelSelection()` already branches on `isGptHost` to send the correct `STOP_*_SELECTION_MODE` message, so
no GPT-specific cancel function is needed.)

- [ ] **Step 7: Show the Cancel button in `enterRecentsSelectionMode`**

Find (currently lines 337-357):

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

  recentsSelectionMode = true;
  document.getElementById('select-recents-btn').style.display = 'none';
  document.getElementById('select-all-recents-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click conversation rows to select them, then click Confirm.';
  pollRecentsSelectionCount();
}
```

Replace the last six lines (from `recentsSelectionMode = true;` to `pollRecentsSelectionCount();`) with:

```js
  recentsSelectionMode = true;
  document.getElementById('select-recents-btn').style.display = 'none';
  document.getElementById('select-all-recents-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('cancel-recents-selection-btn').style.display = 'block';
  document.getElementById('context-message').textContent = 'Click conversation rows to select them, then click Confirm.';
  pollRecentsSelectionCount();
}
```

- [ ] **Step 8: Manually verify**

Reload the unpacked extension, open the side panel.

Test A: On `claude.ai/projects`, click "Select Projects". Confirm both "Confirm Selection (0)" and "Cancel"
appear. Click a project card to select it, confirm the count updates. Click "Cancel". Confirm: the red
border on the page's project card is removed, the panel returns to showing "Select Projects" (not stuck in
selection mode), and no export was triggered.

Test B: Repeat Test A on `claude.ai/recents` ("Select Conversations" flow) — confirm "Cancel" appears
alongside "Confirm Selection (0)" and "Select All", and clicking it cleanly exits back to "Select
Conversations".

Test C: Repeat Test A on `chatgpt.com/projects` (GPT project selection, via "Select GPT Projects") — confirm
"Cancel" appears and exits GPT selection mode cleanly (red borders removed on the page, panel returns to
showing "Select GPT Projects").

Test D: Confirm that actually confirming a selection (not cancelling) still works as before in all three
flows — no regression to the existing confirm/export path.

- [ ] **Step 9: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "$(cat <<'EOF'
feat: add Cancel button to all three selection-mode flows

Adds a Cancel button beneath each Confirm Selection button (Claude
projects, Claude recents, GPT projects — the latter two sharing
Claude-projects' button via existing onclick reassignment) that
exits selection mode without confirming or navigating away.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
