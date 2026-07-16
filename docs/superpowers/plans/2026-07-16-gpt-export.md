# GPT Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated ChatGPT (chatgpt.com) export feature to the LLM Vault Chrome extension — instructions + full conversations per project — output as a `.zip` mirroring the Claude export's folder philosophy.

**Architecture:** GPT support is pure DOM scraping (no REST API), driven by the side panel navigating the active tab. It lives in its own `gpt*` modules and a separate content script (`content-gpt.js`); the existing Claude code is untouched except for minimal routing/manifest wiring. The provider-agnostic `fetchFilesInto()` and vendored JSZip are reused; a vendored Turndown converts assistant HTML to markdown.

**Tech Stack:** Vanilla JS, Chrome Manifest V3, vendored JSZip, vendored Turndown. No bundler, no ES modules, no CDN (MV3 CSP).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no build step.
- Manifest V3 — all panel scripts loaded via `<script>` tags in `sidepanel.html`, no ES modules, no dynamic `import()`.
- No CDN references — every dependency is vendored (MV3 CSP requirement).
- No automated test suite exists in this repo. "Tests" here are: (a) small pure-function checks runnable in Node for provider-agnostic logic (URL parsing, markdown building, HTML→MD), and (b) explicit manual verification steps against a live chatgpt.com session (load unpacked → navigate → inspect panel console / downloaded zip).
- Never modify the behavior of existing Claude files (`content.js`, `orgId.js`, `api.js`, `markdown.js`); only additive wiring in `manifest.json`, `sidepanel.html`, `sidepanel.js`, and reuse of `zipBuilder.js`'s `fetchFilesInto()`.
- French-only UI selectors (no i18n), matching the existing Claude scraping approach.
- Host: `chatgpt.com`. URL patterns — listing: `/projects`; project: `/g/g-p-<hex>/project`; conversation: `/g/g-p-<hex>-<slug>/c/<convId>`.
- GPT output folder names: attachments dir is `contenu-gpt/`; no `artefacts/`, no `memory.md`, no `fichiers/`.

---

## File Structure

- Create: `extension/lib/gptDetect.js` — URL context detection + ID extraction (pure functions).
- Create: `extension/lib/gptMarkdown.js` — conversation→markdown, `instructions.md`, `index.md`; wraps Turndown.
- Create: `extension/lib/gptExport.js` — GPT pipeline orchestration + GPT zip building (uses `fetchFilesInto`).
- Create: `extension/content-gpt.js` — GPT content script (selection, instructions, conversation list, thread scrape).
- Create: `extension/lib/turndown.min.js` — vendored Turndown.
- Create: `test/gptDetect.test.js`, `test/gptMarkdown.test.js` — Node-runnable pure-function checks.
- Modify: `extension/manifest.json` — add chatgpt.com host permission + content_scripts block.
- Modify: `extension/sidepanel.html` — load new scripts + Turndown.
- Modify: `extension/sidepanel.js` — host-based routing in `detectContext()` + `detectGptContext()` + GPT batch driver.

---

## Task 1: GPT URL detection & ID extraction

**Files:**
- Create: `extension/lib/gptDetect.js`
- Test: `test/gptDetect.test.js`

**Interfaces:**
- Produces:
  - `gptDetectContext(url) -> { kind: 'projects'|'project'|'conversation'|null, projectId?: string, convId?: string }`
  - `isGptHost(url) -> boolean`

- [ ] **Step 1: Write the failing test**

`test/gptDetect.test.js`:
```js
const assert = require('assert');
const { gptDetectContext, isGptHost } = require('../extension/lib/gptDetect.js');

// projects listing
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/projects'),
  { kind: 'projects' }
);

// project page
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/g/g-p-6921c94ec8fc8191b6224125ec8794c3/project'),
  { kind: 'project', projectId: 'g-p-6921c94ec8fc8191b6224125ec8794c3' }
);

// conversation page (project slug + convId)
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/g/g-p-6921c94ec8fc8191b6224125ec8794c3-cv-2026/c/692955e1-3d78-8325-b019-7a4326ada801'),
  { kind: 'conversation', projectId: 'g-p-6921c94ec8fc8191b6224125ec8794c3', convId: '692955e1-3d78-8325-b019-7a4326ada801' }
);

// unrelated
assert.deepStrictEqual(gptDetectContext('https://chatgpt.com/'), { kind: null });
assert.strictEqual(isGptHost('https://chatgpt.com/projects'), true);
assert.strictEqual(isGptHost('https://claude.ai/projects'), false);

console.log('gptDetect: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/gptDetect.test.js`
Expected: FAIL — `Cannot find module '../extension/lib/gptDetect.js'`.

- [ ] **Step 3: Write minimal implementation**

`extension/lib/gptDetect.js`:
```js
function isGptHost(url) {
  try {
    return new URL(url).hostname === 'chatgpt.com';
  } catch (e) {
    return false;
  }
}

function gptDetectContext(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { kind: null };
  }
  if (parsed.hostname !== 'chatgpt.com') return { kind: null };

  const path = parsed.pathname;

  if (path === '/projects') return { kind: 'projects' };

  const conv = path.match(/^\/g\/(g-p-[a-f0-9]+)-[^/]*\/c\/([a-f0-9-]+)/);
  if (conv) return { kind: 'conversation', projectId: conv[1], convId: conv[2] };

  const proj = path.match(/^\/g\/(g-p-[a-f0-9]+)(?:-[^/]*)?\/project/);
  if (proj) return { kind: 'project', projectId: proj[1] };

  return { kind: null };
}

// Browser globals + Node export (for the pure-function test).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptDetectContext, isGptHost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/gptDetect.test.js`
Expected: PASS — prints `gptDetect: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/gptDetect.js test/gptDetect.test.js
git commit -m "feat: add GPT URL context detection"
```

---

## Task 2: Vendor Turndown

**Files:**
- Create: `extension/lib/turndown.min.js`

**Interfaces:**
- Produces: global `TurndownService` (browser), used by Task 3.

- [ ] **Step 1: Fetch the vendored library**

Download the UMD build of Turndown (v7.x) into the repo. Run:
```bash
curl -L -o extension/lib/turndown.min.js https://unpkg.com/turndown@7.2.0/dist/turndown.js
```

- [ ] **Step 2: Verify it loaded and is non-empty**

Run:
```bash
node -e "const t=require('./extension/lib/turndown.min.js'); const s=new t(); console.log(s.turndown('<p>hi <strong>there</strong></p>'))"
```
Expected: prints `hi **there**` (confirms the file is a working UMD Turndown build). If `require` fails because the build is browser-only UMD, instead verify size is > 10KB: `wc -c extension/lib/turndown.min.js` and eyeball the file starts with the Turndown header comment.

- [ ] **Step 3: Commit**

```bash
git add extension/lib/turndown.min.js
git commit -m "build: vendor Turndown for GPT HTML->markdown"
```

---

## Task 3: GPT markdown builders

**Files:**
- Create: `extension/lib/gptMarkdown.js`
- Test: `test/gptMarkdown.test.js`

**Interfaces:**
- Consumes: global `TurndownService` (Task 2).
- Produces:
  - `gptTurnsToMarkdown(project, turns) -> string` — `turns` is `[{ role: 'user'|'assistant', text?: string, html?: string }]`; assistant turns carry `html`, user turns carry `text`.
  - `gptInstructionsMarkdown(project) -> string` — `project` is `{ name, instructions }`.
  - `gptIndexMarkdown(project, conversations) -> string` — `conversations` is `[{ title, convId }]`.
  - `gptConvFolderName(conv) -> string` — `<sanitized-title>_<convId first 8>`.
- Note: `gptMarkdown.js` must work both in the browser (uses `new TurndownService()`) and under Node for the test. The test injects a fake `TurndownService` on `global` before requiring, so `gptMarkdown.js` must read `TurndownService` lazily (inside the function), not at module load.

- [ ] **Step 1: Write the failing test**

`test/gptMarkdown.test.js`:
```js
const assert = require('assert');

// Fake Turndown so the pure builder logic is testable in Node.
global.TurndownService = class {
  turndown(html) { return html.replace(/<[^>]+>/g, '').trim(); }
};

const {
  gptTurnsToMarkdown,
  gptInstructionsMarkdown,
  gptIndexMarkdown,
  gptConvFolderName,
} = require('../extension/lib/gptMarkdown.js');

// conversation markdown: user text verbatim, assistant html via turndown
const md = gptTurnsToMarkdown(
  { name: 'CV 2026' },
  [
    { role: 'user', text: 'Salut GPT' },
    { role: 'assistant', html: '<p>Bonjour</p>' },
  ]
);
assert.ok(md.includes('## Vous'), 'has user heading');
assert.ok(md.includes('Salut GPT'), 'has user text');
assert.ok(md.includes('## ChatGPT'), 'has assistant heading');
assert.ok(md.includes('Bonjour'), 'has assistant text');

// instructions
const instr = gptInstructionsMarkdown({ name: 'CV 2026', instructions: 'Réponds en FR.' });
assert.ok(instr.includes('CV 2026'));
assert.ok(instr.includes('Réponds en FR.'));

// index
const idx = gptIndexMarkdown(
  { name: 'CV 2026' },
  [{ title: 'Avis CV', convId: '692955e1-3d78-8325-b019-7a4326ada801' }]
);
assert.ok(idx.includes('Avis CV'));
assert.ok(idx.includes('692955e1'));

// folder name: sanitized title + 8-char id
assert.strictEqual(
  gptConvFolderName({ title: 'Avis: CV/2026', convId: '692955e1-3d78-8325-b019-7a4326ada801' }),
  'Avis_ CV_2026_692955e1'
);

console.log('gptMarkdown: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/gptMarkdown.test.js`
Expected: FAIL — `Cannot find module '../extension/lib/gptMarkdown.js'`.

- [ ] **Step 3: Write minimal implementation**

`extension/lib/gptMarkdown.js`:
```js
function gptSanitizeFilename(name) {
  return (name || 'sans-titre')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function gptConvFolderName(conv) {
  const title = gptSanitizeFilename(conv.title);
  const short = (conv.convId || '').slice(0, 8);
  return `${title}_${short}`;
}

function gptTurnsToMarkdown(project, turns) {
  const td = new TurndownService();
  const lines = [`# ${project.name || 'Conversation'}`, ''];
  for (const turn of turns) {
    if (turn.role === 'user') {
      lines.push('## Vous', '', (turn.text || '').trim(), '');
    } else {
      const body = turn.html ? td.turndown(turn.html) : (turn.text || '');
      lines.push('## ChatGPT', '', body.trim(), '');
    }
  }
  return lines.join('\n');
}

function gptInstructionsMarkdown(project) {
  return [
    `# ${project.name || 'Projet'}`,
    '',
    '## Instructions',
    '',
    (project.instructions || '').trim(),
    '',
  ].join('\n');
}

function gptIndexMarkdown(project, conversations) {
  const lines = [`# ${project.name || 'Projet'}`, '', '## Conversations', ''];
  for (const conv of conversations) {
    const folder = gptConvFolderName(conv);
    lines.push(`- [${conv.title || 'sans-titre'}](${folder}/conversation.md)`);
  }
  lines.push('');
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gptTurnsToMarkdown,
    gptInstructionsMarkdown,
    gptIndexMarkdown,
    gptConvFolderName,
    gptSanitizeFilename,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/gptMarkdown.test.js`
Expected: PASS — prints `gptMarkdown: all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/gptMarkdown.js test/gptMarkdown.test.js
git commit -m "feat: add GPT markdown builders"
```

---

## Task 4: GPT content script — instructions & conversation list scraping

**Files:**
- Create: `extension/content-gpt.js`

**Interfaces:**
- Produces (via `chrome.runtime.onMessage`):
  - `PING` → `{ pong: true, pathname }`
  - `GET_GPT_PROJECT_METADATA` → `{ name, instructions }` (async — opens/closes settings popover)
  - `GET_GPT_PROJECT_CONVERSATIONS` → `{ conversations: [{ title, convId }] }` (async — auto-scrolls list)
- Consumes: nothing from other tasks (self-contained DOM code).

**Manual verification only** (content scripts need a live page — no Node test).

- [ ] **Step 1: Write the content script**

`extension/content-gpt.js`:
```js
// GPT content script — pure DOM scraping (no REST API). Injected on
// chatgpt.com. Fully independent of the Claude content.js.

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

function gptGetProjectTitle() {
  const h1Btn = document.querySelector('button[name="project-title"]');
  if (h1Btn) return h1Btn.textContent.trim();
  const h1 = document.querySelector('h1');
  return h1 ? h1.textContent.trim() : '';
}

async function gptGetProjectMetadata() {
  const fallback = { name: gptGetProjectTitle(), instructions: '' };

  const detailsBtn = document.querySelector('button[aria-label="Afficher les détails du projet"]');
  if (!detailsBtn) return fallback;
  detailsBtn.click();

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
    conversations.push({ title, convId });
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
  return false;
});
```

- [ ] **Step 2: Wire manifest so the script injects (needed to verify)**

Modify `extension/manifest.json`: add `"https://chatgpt.com/*"` to `host_permissions`, and add a second entry to `content_scripts`:
```json
{
  "matches": ["https://chatgpt.com/*"],
  "js": ["content-gpt.js"],
  "run_at": "document_idle"
}
```

- [ ] **Step 3: Manual verification**

1. `chrome://extensions` → reload the unpacked extension.
2. Open a GPT project page (`chatgpt.com/g/g-p-.../project`).
3. Open DevTools console **on the page** (not the panel) and run:
   ```js
   chrome.runtime.sendMessage // (only in panel) — instead test via panel later
   ```
   Since content scripts can't be messaged from the page console, verify injection by checking the page console shows no errors and, in the **panel** console (right-click panel → Inspect), run:
   ```js
   const [t] = await chrome.tabs.query({active:true,currentWindow:true});
   await chrome.tabs.sendMessage(t.id, {type:'GET_GPT_PROJECT_METADATA'});
   ```
   Expected: returns `{ name: 'CV 2026', instructions: '...' }` and you briefly see the settings popover open and close.
4. Then run:
   ```js
   await chrome.tabs.sendMessage(t.id, {type:'GET_GPT_PROJECT_CONVERSATIONS'});
   ```
   Expected: `{ conversations: [{title, convId}, ...] }` listing the project's chats.

- [ ] **Step 4: Commit**

```bash
git add extension/content-gpt.js extension/manifest.json
git commit -m "feat: GPT content script — instructions & conversation list scraping"
```

---

## Task 5: GPT content script — thread scraping (messages, images, files)

**Files:**
- Modify: `extension/content-gpt.js`

**Interfaces:**
- Produces (new message handler):
  - `GET_GPT_CONVERSATION` → `{ turns: [{ role, text?, html? }], contentFiles: [{ filename, url }] }` (async — auto-scrolls thread then scrapes)
- Consumes: `gptWaitForCondition` (Task 4, same file).

- [ ] **Step 1: Add thread-scraping functions**

Add to `extension/content-gpt.js` (above the message listener):
```js
function gptFindTurns() {
  return [...document.querySelectorAll('section[data-turn-id]')];
}

function gptWaitForThreadToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;
    // Scroll the thread's scroll container. ChatGPT threads live in a
    // scrollable main; scrolling window + the main covers both layouts.
    const poll = () => {
      window.scrollTo(0, 0); // load earliest turns first
      const count = gptFindTurns().length;
      if (count === lastCount) { stableChecks++; }
      else { stableChecks = 0; lastCount = count; }
      if (stableChecks >= stableChecksRequired || Date.now() - start >= timeoutMs) {
        resolve(count); return;
      }
      window.scrollTo(0, document.body.scrollHeight);
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function gptScrapeTurn(section) {
  const roleEl = section.querySelector('[data-message-author-role]');
  if (!roleEl) return null;
  const role = roleEl.getAttribute('data-message-author-role');
  if (role === 'user') {
    const bubble = roleEl.querySelector('.whitespace-pre-wrap');
    return { role: 'user', text: bubble ? bubble.textContent : roleEl.textContent };
  }
  const md = roleEl.querySelector('.markdown');
  return { role: 'assistant', html: md ? md.innerHTML : roleEl.innerHTML };
}

function gptScrapeThreadImages() {
  const files = [];
  const seen = new Set();
  const imgs = document.querySelectorAll('section[data-turn-id] img[src*="backend-api"]');
  imgs.forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || seen.has(src)) return;
    seen.add(src);
    const alt = img.getAttribute('alt') || `image_${files.length + 1}`;
    const url = new URL(src, window.location.origin).href;
    files.push({ filename: alt, url });
  });
  return files;
}

async function gptGetConversation() {
  await gptWaitForThreadToStabilize(30000, 3, 500);
  const turns = [];
  for (const section of gptFindTurns()) {
    const turn = gptScrapeTurn(section);
    if (turn) turns.push(turn);
  }
  return { turns, contentFiles: gptScrapeThreadImages() };
}
```

- [ ] **Step 2: Register the handler**

Add to the `onMessage` listener in `content-gpt.js`, before `return false;`:
```js
  if (message && message.type === 'GET_GPT_CONVERSATION') {
    gptGetConversation().then(sendResponse);
    return true;
  }
```

- [ ] **Step 3: Manual verification**

1. Reload the unpacked extension.
2. Open a GPT conversation URL (`chatgpt.com/g/g-p-.../c/<convId>`).
3. In the **panel** console:
   ```js
   const [t] = await chrome.tabs.query({active:true,currentWindow:true});
   const r = await chrome.tabs.sendMessage(t.id, {type:'GET_GPT_CONVERSATION'});
   console.log(r.turns.length, r.turns[0], r.contentFiles);
   ```
   Expected: `turns` contains alternating `{role:'user',text}` / `{role:'assistant',html}` covering the whole thread (scroll happens automatically first); `contentFiles` lists any image attachments with `backend-api/estuary/content` URLs.

- [ ] **Step 4: Commit**

```bash
git add extension/content-gpt.js
git commit -m "feat: GPT content script — thread message & image scraping"
```

---

## Task 6: GPT content script — multi-project selection

**Files:**
- Modify: `extension/content-gpt.js`

**Interfaces:**
- Produces (new handlers):
  - `START_GPT_SELECTION_MODE` → `{ armed: boolean }`
  - `GET_GPT_SELECTED_PROJECTS` → `[{ index, name }]` (GPT rows have NO uuid in DOM — keyed by row index + name captured at click)
  - `STOP_GPT_SELECTION_MODE` → `{ stopped: true }`
  - `NAVIGATE_GPT_PROJECT` (`{ index }`) → `{ navigated: boolean, name }` — clicks the row at `index` to trigger React navigation; the panel then reads the tab URL after it changes.
- Consumes: nothing new.

**Rationale:** Unlike Claude, GPT projects-list rows (`role="row"` in `role="grid" aria-label="Projets"`) carry no href/uuid. Selection is keyed by the row's ordinal position; navigation is done by clicking the row (the panel captures the resulting URL from the tab).

- [ ] **Step 1: Add selection functions**

Add to `extension/content-gpt.js`:
```js
const GPT_SELECTED_CLASS = 'llmvault-gpt-selected';
let gptSelectedIndices = new Set();
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
  if (gptSelectedIndices.has(index)) {
    gptSelectedIndices.delete(index);
    row.classList.remove(GPT_SELECTED_CLASS);
  } else {
    gptSelectedIndices.add(index);
    row.classList.add(GPT_SELECTED_CLASS);
  }
}

function gptStartSelectionMode() {
  const grid = gptFindProjectGrid();
  if (!grid) return false;
  gptEnsureSelectionStyle();
  gptSelectedIndices = new Set();
  gptSelectionClickListener = gptHandleSelectionClick;
  grid.addEventListener('click', gptSelectionClickListener, true);
  return true;
}

function gptGetSelectedProjects() {
  const rows = gptFindProjectRows();
  const results = [];
  for (const index of gptSelectedIndices) {
    if (rows[index]) results.push({ index, name: gptRowName(rows[index]) });
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
  gptSelectedIndices = new Set();
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
```

- [ ] **Step 2: Register the handlers**

Add to the `onMessage` listener:
```js
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
```

- [ ] **Step 3: Manual verification**

1. Reload the unpacked extension. Open `chatgpt.com/projects`.
2. In the **panel** console:
   ```js
   const [t] = await chrome.tabs.query({active:true,currentWindow:true});
   await chrome.tabs.sendMessage(t.id, {type:'START_GPT_SELECTION_MODE'}); // {armed:true}
   ```
3. Click two project rows on the page — each should get a red outline and normal navigation should be blocked.
4. In the panel console:
   ```js
   await chrome.tabs.sendMessage(t.id, {type:'GET_GPT_SELECTED_PROJECTS'});
   ```
   Expected: `[{index, name:'CV 2026'}, {index, name:'APS'}]`.
5. Test navigation:
   ```js
   await chrome.tabs.sendMessage(t.id, {type:'NAVIGATE_GPT_PROJECT', index: 0});
   ```
   Expected: the tab navigates to that project's `/g/g-p-.../project` URL.

- [ ] **Step 4: Commit**

```bash
git add extension/content-gpt.js
git commit -m "feat: GPT content script — multi-project selection & navigation"
```

---

## Task 7: GPT export pipeline & zip builder

**Files:**
- Create: `extension/lib/gptExport.js`

**Interfaces:**
- Consumes: `fetchFilesInto` (from `zipBuilder.js`), `gptTurnsToMarkdown`/`gptInstructionsMarkdown`/`gptIndexMarkdown`/`gptConvFolderName` (Task 3), `gptSanitizeFilename` (Task 3), `waitForContentScriptReady` (existing `sidepanel.js` — Task 8 exposes it before this runs; both are panel globals so ordering by `<script>` tags suffices).
- Produces:
  - `gptBuildProjectInto(zip, folderPath, project, conversationsWithData)` — writes `index.md`, `instructions.md`, and one folder per conversation (`conversation.md` + `contenu-gpt/`) into `zip` at `folderPath` (or root if falsy). `conversationsWithData` is `[{ title, convId, turns, contentFiles }]`.
  - `gptScrapeProject(tabId, projectUrl, onProgress)` — navigates the tab to the project, scrapes metadata + conversation list, then visits each conversation to scrape its thread; returns `{ project: {name, instructions}, conversations: [{title, convId, turns, contentFiles}] }`.

- [ ] **Step 1: Write the pipeline module**

`extension/lib/gptExport.js`:
```js
async function gptBuildConversationFolder(target, conv) {
  const folder = target.folder(gptConvFolderName(conv));
  folder.file('conversation.md', gptTurnsToMarkdown({ name: conv.title }, conv.turns || []));
  const contenu = folder.folder('contenu-gpt');
  await fetchFilesInto(contenu, conv.contentFiles || []);
}

async function gptBuildProjectInto(zip, folderPath, project, conversationsWithData) {
  const target = folderPath ? zip.folder(folderPath) : zip;
  target.file('index.md', gptIndexMarkdown(project, conversationsWithData));
  if (project.instructions) {
    target.file('instructions.md', gptInstructionsMarkdown(project));
  }
  for (const conv of conversationsWithData) {
    await gptBuildConversationFolder(target, conv);
  }
}

async function gptScrapeProject(tabId, projectUrl, onProgress) {
  // 1. Navigate to the project page and wait for the content script.
  await chrome.tabs.update(tabId, { url: projectUrl });
  const projectPath = new URL(projectUrl).pathname;
  const ready = await waitForContentScriptReady(tabId, 15000, projectPath);
  if (!ready) throw new Error('project page not ready');

  // 2. Instructions + conversation list.
  const project = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_METADATA' });
  const listResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_CONVERSATIONS' });
  const conversations = (listResp && listResp.conversations) || [];
  if (conversations.length === 0) throw new Error('no conversations');

  // 3. Visit each conversation and scrape its thread.
  const base = projectUrl.replace(/\/project$/, ''); // /g/g-p-<id>-<slug>
  // conversation URL shape: /g/g-p-<id>-<slug>/c/<convId>; but the project
  // URL may lack the slug. Build from the same origin + the href pattern
  // the list scrape gave us is safest: reconstruct via /c/<convId>.
  const origin = new URL(projectUrl).origin;
  const result = { project, conversations: [] };
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (onProgress) onProgress(i + 1, conversations.length, conv.title);
    const convUrl = `${origin}${base.replace(origin, '')}/c/${conv.convId}`;
    try {
      await chrome.tabs.update(tabId, { url: convUrl });
      const convReady = await waitForContentScriptReady(tabId, 15000, `/c/${conv.convId}`);
      if (!convReady) { result.conversations.push({ ...conv, turns: [], contentFiles: [] }); continue; }
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_CONVERSATION' });
      result.conversations.push({
        ...conv,
        turns: (data && data.turns) || [],
        contentFiles: (data && data.contentFiles) || [],
      });
    } catch (e) {
      result.conversations.push({ ...conv, turns: [], contentFiles: [] });
    }
  }
  return result;
}
```

Note on `waitForContentScriptReady`'s `expectedPathname`: the existing implementation (Task 8, unchanged) checks the content script's `pathname` *contains/matches* the expected value. For conversations we pass `/c/<convId>` which the real path contains. Confirm in Task 8 the check is a substring/`endsWith`, not strict equality; if it is strict equality, Task 8 relaxes it to `pathname.includes(expected)` for GPT calls (see Task 8 Step 2).

- [ ] **Step 2: Manual verification**

Deferred to Task 9 (needs the panel wiring). For now just confirm the file loads without syntax errors:
Run: `node -e "require('./extension/lib/gptExport.js')" 2>&1 | head -1`
Expected: either no output, or a `ReferenceError` about `fetchFilesInto`/`chrome` (acceptable — those are browser/panel globals; a *SyntaxError* is NOT acceptable and must be fixed).

- [ ] **Step 3: Commit**

```bash
git add extension/lib/gptExport.js
git commit -m "feat: add GPT export pipeline & zip builder"
```

---

## Task 8: Panel wiring — script loading & host-based routing

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js:187-235` (relax `waitForContentScriptReady`, add host routing)

**Interfaces:**
- Consumes: `gptDetectContext`/`isGptHost` (Task 1), `gptScrapeProject`/`gptBuildProjectInto` (Task 7).
- Produces: `detectGptContext()` in `sidepanel.js`; routing in `detectContext()`.

- [ ] **Step 1: Load the GPT scripts in the panel**

Modify `extension/sidepanel.html` — add before `<script src="sidepanel.js"></script>`:
```html
  <script src="lib/turndown.min.js"></script>
  <script src="lib/gptDetect.js"></script>
  <script src="lib/gptMarkdown.js"></script>
  <script src="lib/gptExport.js"></script>
```

- [ ] **Step 2: Relax `waitForContentScriptReady` to substring match**

Read `extension/sidepanel.js:187-210`. Confirm how it compares the returned pathname to `expectedPathname`. If it uses strict `===`, change the comparison to `response.pathname.includes(expectedPathname)` so `/c/<convId>` matches a full `/g/.../c/<convId>` path. If it already uses `includes`/`endsWith`, leave it. Verify the existing Claude callers still pass full paths that `includes` satisfies (`/chat/<uuid>`, `/project/<uuid>` — all substrings of themselves, so still true).

- [ ] **Step 3: Add host-based routing in `detectContext()`**

At the very top of `detectContext()` in `sidepanel.js` (right after `const url = tab.url || '';`), add:
```js
  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }
```

- [ ] **Step 4: Add `detectGptContext()`**

Add to `sidepanel.js` (near `detectContext`):
```js
function detectGptContext(url, tab) {
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');
  const selectRecentsBtn = document.getElementById('select-recents-btn');
  const selectAllRecentsBtn = document.getElementById('select-all-recents-btn');
  const confirmRecentsSelectionBtn = document.getElementById('confirm-recents-selection-btn');
  const contextMessage = document.getElementById('context-message');

  // Hide all Claude-specific controls we won't use.
  [selectRecentsBtn, selectAllRecentsBtn, confirmRecentsSelectionBtn].forEach((b) => { if (b) b.style.display = 'none'; });

  const ctx = gptDetectContext(url);

  if (ctx.kind === 'projects') {
    contextMessage.textContent = 'ChatGPT — select projects to export.';
    exportBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    selectProjectsBtn.textContent = 'Select GPT Projects';
    selectProjectsBtn.onclick = startGptSelection;
    return;
  }
  if (ctx.kind === 'project') {
    contextMessage.textContent = 'ChatGPT project detected.';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    exportBtn.style.display = 'block';
    exportBtn.textContent = 'Export GPT Project';
    exportBtn.disabled = false;
    exportBtn.onclick = () => startGptProjectExport(url, tab);
    return;
  }
  // conversation or unrelated GPT page
  contextMessage.textContent = 'Navigate to a ChatGPT project or the projects list to export.';
  exportBtn.style.display = 'none';
  selectProjectsBtn.style.display = 'none';
  confirmSelectionBtn.style.display = 'none';
}
```

- [ ] **Step 5: Manual verification**

1. Reload the unpacked extension.
2. On `chatgpt.com/projects` the panel shows "Select GPT Projects".
3. On a `/g/g-p-.../project` page the panel shows "Export GPT Project".
4. On a `/c/<convId>` page or `chatgpt.com/` the panel shows the "Navigate to..." message.
5. No console errors in the panel. (Buttons don't do anything useful yet — Task 9 wires the handlers `startGptSelection`, `startGptProjectExport`.)

- [ ] **Step 6: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js
git commit -m "feat: panel host-based routing for GPT + script loading"
```

---

## Task 9: Panel wiring — single-project export & multi-project batch

**Files:**
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `gptScrapeProject`, `gptBuildProjectInto` (Task 7); `gptSanitizeFilename` (Task 3); content-script messages from Task 6.
- Produces: `startGptProjectExport(url, tab)`, `startGptSelection()`, `confirmGptSelection()`, `runGptBatch(selected, tab)`, `downloadBlob(blob, filename)` (reuse existing download helper if present).

- [ ] **Step 1: Find the existing download helper**

Read `sidepanel.js` and locate how Claude exports trigger the download (search for `chrome.downloads.download` or `URL.createObjectURL`). Reuse that exact helper. Call it `triggerDownload(blob, filename)` in the code below — rename to match whatever the file already defines.

- [ ] **Step 2: Add single-project export**

Add to `sidepanel.js`:
```js
async function startGptProjectExport(url, tab) {
  const exportBtn = document.getElementById('export-btn');
  const status = document.getElementById('status');
  exportBtn.disabled = true;
  batchInProgress = true;
  status.className = '';
  status.textContent = 'Scraping GPT project...';
  try {
    const scraped = await gptScrapeProject(tab.id, url, (n, total, name) => {
      status.textContent = `Conversation ${n}/${total}: ${name}...`;
    });
    status.textContent = 'Building zip...';
    const zip = new JSZip();
    await gptBuildProjectInto(zip, null, scraped.project, scraped.conversations);
    const blob = await zip.generateAsync({ type: 'blob' });
    const safeName = gptSanitizeFilename(scraped.project.name || 'projet');
    triggerDownload(blob, `gpt_project_${safeName}.zip`);
    status.className = 'success';
    status.textContent = 'Export complete.';
  } catch (e) {
    status.className = 'error';
    status.textContent = 'Export failed: ' + e.message;
  } finally {
    batchInProgress = false;
    exportBtn.disabled = false;
  }
}
```

- [ ] **Step 3: Add multi-project selection + batch**

Add to `sidepanel.js`:
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

  const poll = setInterval(async () => {
    if (!selectionMode) { clearInterval(poll); return; }
    try {
      const sel = await chrome.tabs.sendMessage(tab.id, { type: 'GET_GPT_SELECTED_PROJECTS' });
      confirmBtn.textContent = `Confirm Selection (${(sel || []).length})`;
    } catch (e) { /* tab navigated away; ignore */ }
  }, 500);
}

async function confirmGptSelection(tab) {
  const selected = await chrome.tabs.sendMessage(tab.id, { type: 'GET_GPT_SELECTED_PROJECTS' });
  await chrome.tabs.sendMessage(tab.id, { type: 'STOP_GPT_SELECTION_MODE' });
  selectionMode = false;
  if (!selected || selected.length === 0) return;
  await runGptBatch(selected, tab);
}

async function runGptBatch(selected, tab) {
  const status = document.getElementById('status');
  const confirmBtn = document.getElementById('confirm-selection-btn');
  confirmBtn.style.display = 'none';
  batchInProgress = true;
  status.className = '';
  const zip = new JSZip();
  const failed = [];
  let succeeded = 0;

  for (let i = 0; i < selected.length; i++) {
    const proj = selected[i];
    status.textContent = `Project ${i + 1}/${selected.length}: ${proj.name}...`;
    try {
      // Navigate by clicking the row (GPT rows have no href). We must be
      // back on the projects listing for the index to be valid.
      await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/projects' });
      await waitForContentScriptReady(tab.id, 15000, '/projects');
      const nav = await chrome.tabs.sendMessage(tab.id, { type: 'NAVIGATE_GPT_PROJECT', index: proj.index });
      if (!nav || !nav.navigated) { failed.push(proj.name); continue; }
      // Wait for the project URL to appear, then scrape from it.
      const projectUrl = await waitForGptProjectUrl(tab.id, 15000);
      if (!projectUrl) { failed.push(proj.name); continue; }
      const scraped = await gptScrapeProject(tab.id, projectUrl, (n, total, name) => {
        status.textContent = `Project ${i + 1}/${selected.length} — conv ${n}/${total}: ${name}...`;
      });
      const folderName = gptSanitizeFilename(scraped.project.name || proj.name);
      await gptBuildProjectInto(zip, folderName, scraped.project, scraped.conversations);
      succeeded++;
    } catch (e) {
      failed.push(proj.name);
    }
  }

  batchInProgress = false;
  if (succeeded === 0) {
    status.className = 'error';
    status.textContent = 'All projects failed: ' + failed.join(', ');
    return;
  }
  status.textContent = 'Building zip...';
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `gpt_projects_batch_${succeeded}.zip`);
  status.className = 'success';
  status.textContent = `Exported ${succeeded} project(s).` + (failed.length ? ` Failed: ${failed.join(', ')}` : '');
}

// After NAVIGATE_GPT_PROJECT, the React app changes the tab URL to the
// project page. Poll the tab URL until it matches /g/g-p-.../project.
function waitForGptProjectUrl(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        const ctx = gptDetectContext(tab.url || '');
        if (ctx.kind === 'project') { resolve(tab.url); return; }
      } catch (e) { /* ignore */ }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(poll, 300);
    };
    poll();
  });
}
```

- [ ] **Step 4: Guard `detectContext` re-entry during GPT batch**

Confirm the existing early-return guard at the top of `detectContext()` (`if (selectionMode || batchInProgress || recentsSelectionMode) return;`) still fires for GPT — it does, since `startGptSelection`/`runGptBatch` set those same flags. No change needed unless the guard was moved; verify it runs before the `isGptHost` branch OR that the `isGptHost` branch itself early-returns when `batchInProgress`. If the `isGptHost` check precedes the guard, add at the top of `detectGptContext`:
```js
  if (selectionMode || batchInProgress) return;
```

- [ ] **Step 5: Manual verification — single project**

1. Reload unpacked. Open a GPT project page. Click "Export GPT Project".
2. Watch the status cycle through conversations; a `gpt_project_<name>.zip` downloads.
3. Unzip and verify: `index.md`, `instructions.md` (if the project had instructions), one folder per conversation with `conversation.md` (user/assistant turns in markdown) and `contenu-gpt/` (images if any, else `.gitkeep`).

- [ ] **Step 6: Manual verification — batch**

1. Open `chatgpt.com/projects`. Click "Select GPT Projects". Select CV 2026 + APS. Confirm.
2. Watch the status navigate project-by-project; a `gpt_projects_batch_2.zip` downloads.
3. Unzip and verify one top-level folder per project, each with `index.md` + `instructions.md` + conversation folders.

- [ ] **Step 7: Commit**

```bash
git add extension/sidepanel.js
git commit -m "feat: GPT single-project export & multi-project batch in panel"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Document the GPT feature**

Add a new section to `CLAUDE.md` after the Architecture section, describing the GPT modules (`gptDetect.js`, `content-gpt.js`, `gptMarkdown.js`, `gptExport.js`, vendored `turndown.min.js`), the DOM-scraping approach (no REST API), the URL patterns, the `contenu-gpt/` output structure, and the fact that GPT and Claude pipelines are isolated. Mirror the writing style/depth of the existing Claude sections. Update the manifest description of `content_scripts` and `host_permissions` to mention chatgpt.com.

- [ ] **Step 2: Manual verification**

Re-read the new section; confirm it names every new file and matches the actual code (folder names `contenu-gpt/`, message types, URL patterns).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document GPT export feature"
```

---

## Self-Review Notes

- **Spec coverage:** §2 isolation → Tasks 1–7 (all `gpt*` files) + Global Constraints. §3 detection/URLs → Task 1 + Task 8. §4 Phase 1 instructions → Task 4; Phase 2 list → Task 4; Phase 3 threads → Task 5; HTML→MD → Tasks 2–3. §5 output structure → Tasks 3 (`index`/`instructions`/folder name) + 7 (`contenu-gpt/`, no `artefacts/`). §6 error handling → Task 7 (per-conversation try/catch keeps empty turns) + Task 9 (per-project skip, all-fail no-zip). §7 rate limiting → Task 7 (sequential navigation). Multi-project selection (no href/uuid) → Task 6 + Task 9 click-to-navigate.
- **Placeholder scan:** No TBD/TODO. Best-effort non-image files (spec §8) intentionally deferred — Task 5 scrapes images only; documented as out-of-scope, not a placeholder.
- **Type consistency:** `turns: [{role, text?, html?}]` produced by Task 5, consumed by Task 3 (`gptTurnsToMarkdown`) and Task 7. `contentFiles: [{filename, url}]` produced by Task 5, consumed by `fetchFilesInto` (existing signature). Selection `[{index, name}]` produced by Task 6, consumed by Task 9. `gptConvFolderName`/`gptSanitizeFilename` names consistent across Tasks 3, 7, 9.
