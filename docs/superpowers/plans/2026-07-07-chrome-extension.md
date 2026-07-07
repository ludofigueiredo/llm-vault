# Chrome Extension Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bookmarklet/console-script/Tampermonkey trio with a single Manifest V3 Chrome extension that exports a Claude Project (all conversations) or a single Claude conversation as a structured `.zip`.

**Architecture:** Vanilla JS, no build step. A popup (opened from the toolbar icon) reads the active tab's URL, fetches data from claude.ai's existing API endpoints using the same auth/extraction approach as the current script, builds an in-memory folder tree, zips it with a vendored copy of JSZip, and triggers a single `chrome.downloads.download()`.

**Tech Stack:** Manifest V3, vanilla JS (ES2020+, no transpilation), vendored JSZip (no CDN — MV3 CSP disallows remote code execution).

## Global Constraints

- No build process, no npm dependencies beyond the vendored JSZip file — matches the project's existing "no framework, no build" philosophy (per CLAUDE.md).
- All fetches to claude.ai use `credentials: 'include'` (per CLAUDE.md Authentication Requirements).
- Batch size for conversation fetching: 5 at a time, ported from the current script.
- Rate limit backoff: exponential on 429, starting at 1000ms, capped at 10000ms, 3 retries — ported from the current script.
- Filenames sanitized with the existing `sanitizeFilename` logic (strip `<>:"/\|?*`, collapse whitespace/underscores, cap at 100 chars).
- Extension is developer-mode only (unpacked) — no Chrome Web Store packaging concerns (no `key` field, no store-review-oriented permission minimization beyond what's functionally needed).
- Manifest omits `icons` entirely (explicit decision — Chrome shows a default generic icon).

---

## File Structure

```
extension/
  manifest.json          # MV3 manifest: permissions, popup entry point
  popup.html              # Popup UI markup (button, progress, status)
  popup.js                 # Popup logic: detect context, orchestrate export, render progress
  lib/
    orgId.js                # Organization ID extraction (cookie + fallback chain)
    api.js                   # Fetch conversations list / individual conversations from claude.ai
    markdown.js               # JSON -> Markdown conversion + filename sanitization
    zipBuilder.js              # Builds the folder tree, feeds JSZip, returns a Blob
    jszip.min.js                # Vendored JSZip library (downloaded once, committed)
```

Each `lib/*.js` file is loaded into the popup via `<script>` tags in `popup.html` (no module bundler — matches existing no-build-step approach) and exposes functions on `window` for `popup.js` to call.

Repo root cleanup (files removed, not modified):
- `index.html`
- `.nojekyll`
- `claude_project_bookmarklet.js`
- `claude_project_export_script.js`
- `claude_project_exporter.user.js`

---

## Task 1: Vendor JSZip and scaffold the extension skeleton

**Files:**
- Create: `extension/lib/jszip.min.js`
- Create: `extension/manifest.json`
- Create: `extension/popup.html`
- Create: `extension/popup.js`

**Interfaces:**
- Produces: a loadable unpacked extension with an empty-but-functional popup, and a global `JSZip` class available once `jszip.min.js` is loaded (used by Task 5).

- [ ] **Step 1: Download and vendor JSZip**

Run:
```bash
curl -L -o extension/lib/jszip.min.js https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
```

Verify the file was downloaded and is non-trivial in size:
```bash
wc -c extension/lib/jszip.min.js
```
Expected: file size > 50000 bytes (JSZip 3.10.1 minified is ~95KB).

- [ ] **Step 2: Write manifest.json**

Create `extension/manifest.json`:
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
  }
}
```

- [ ] **Step 3: Write a minimal popup.html**

Create `extension/popup.html`:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Conversations Exporter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; width: 320px; padding: 16px; }
    h1 { font-size: 15px; margin: 0 0 12px; }
    button { width: 100%; padding: 10px; font-size: 14px; border: none; border-radius: 6px; background: #3498db; color: white; cursor: pointer; }
    button:disabled { background: #95a5a6; cursor: not-allowed; }
    #status { margin-top: 12px; font-size: 13px; color: #333; white-space: pre-wrap; }
    #status.error { color: #e74c3c; }
    #status.success { color: #27ae60; }
  </style>
</head>
<body>
  <h1>Claude Conversations Exporter</h1>
  <div id="context-message"></div>
  <button id="export-btn" style="display:none;"></button>
  <div id="status"></div>

  <script src="lib/jszip.min.js"></script>
  <script src="lib/orgId.js"></script>
  <script src="lib/api.js"></script>
  <script src="lib/markdown.js"></script>
  <script src="lib/zipBuilder.js"></script>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write a placeholder popup.js**

Create `extension/popup.js`:
```javascript
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('context-message').textContent = 'Extension loaded. Detection logic pending.';
});
```

- [ ] **Step 5: Load the unpacked extension in Chrome and verify it installs**

Manual verification (document in the task, no automated check possible):
1. Open `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked", select the `extension/` folder
4. Confirm the extension appears with no errors, and clicking its toolbar icon opens the popup showing "Extension loaded. Detection logic pending."

- [ ] **Step 6: Commit**

```bash
git add extension/
git commit -m "feat: scaffold Chrome extension skeleton with vendored JSZip"
```

---

## Task 2: Organization ID and Project ID extraction

**Files:**
- Create: `extension/lib/orgId.js`
- Test: manual (see Step 4 below — no test framework in this project, ported logic verified by console execution against a live claude.ai tab)

**Interfaces:**
- Consumes: nothing (reads `document.cookie`, `window.localStorage`, `window.sessionStorage` — but since this runs in the extension popup, not injected into the page, see note in Step 1).
- Produces:
  - `getProjectIdFromUrl(url: string): string | null` — extracts the project UUID from a `claude.ai/project/[uuid]` URL.
  - `getConversationIdFromUrl(url: string): string | null` — extracts the conversation UUID from a `claude.ai/chat/[uuid]` URL.
  - `getOrganizationId(): Promise<string | null>` — resolves the org ID using `chrome.cookies.get`.

**Design note:** The current script runs injected into the claude.ai page, so it can read `document.cookie`/`localStorage` directly. The extension's popup is a separate context — it does NOT have direct access to the page's cookies via `document.cookie`. Instead, use `chrome.cookies.get({url: 'https://claude.ai', name: 'lastActiveOrg'})`, which the `cookies` permission (declared in Task 1) grants access to. This replaces the cookie-reading part of the original `getOrgIdFromCookies`. The localStorage/sessionStorage/global-variable fallback methods from the original script are NOT portable to the popup context (popup has no access to the page's JS globals or storage) — they are dropped. If the cookie lookup fails, fall back to prompting the user via an input field in the popup (Task 3 wires this up).

- [ ] **Step 1: Write orgId.js with URL parsing functions**

Create `extension/lib/orgId.js`:
```javascript
function getProjectIdFromUrl(url) {
  const match = url.match(/\/project\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return match ? match[1] : null;
}

function getConversationIdFromUrl(url) {
  const match = url.match(/\/chat\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return match ? match[1] : null;
}

function getOrganizationId() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' }, (cookie) => {
      resolve(cookie ? cookie.value : null);
    });
  });
}
```

- [ ] **Step 2: Add the script tag to popup.html (already present from Task 1 — verify)**

Confirm `extension/popup.html` already includes `<script src="lib/orgId.js"></script>` before `popup.js` (added in Task 1 Step 3). No change needed if present.

- [ ] **Step 3: Manually verify URL parsing in the Chrome DevTools console**

With the extension loaded (from Task 1), open the popup, right-click inside it, choose "Inspect", and in the popup's DevTools console run:
```javascript
getProjectIdFromUrl('https://claude.ai/project/a1b2c3d4-e5f6-7890-abcd-ef1234567890')
```
Expected: `"a1b2c3d4-e5f6-7890-abcd-ef1234567890"`

```javascript
getConversationIdFromUrl('https://claude.ai/chat/a1b2c3d4-e5f6-7890-abcd-ef1234567890')
```
Expected: `"a1b2c3d4-e5f6-7890-abcd-ef1234567890"`

```javascript
getProjectIdFromUrl('https://claude.ai/recents')
```
Expected: `null`

- [ ] **Step 4: Manually verify org ID cookie lookup**

While logged into claude.ai in the same Chrome profile, in the popup's DevTools console run:
```javascript
getOrganizationId().then(id => console.log('org id:', id))
```
Expected: logs a UUID string (not `null`). If `null`, confirm you're logged into claude.ai in this Chrome profile.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/orgId.js
git commit -m "feat: add project/conversation URL parsing and org ID cookie lookup"
```

---

## Task 3: Context detection and popup UI wiring

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`

**Interfaces:**
- Consumes: `getProjectIdFromUrl`, `getConversationIdFromUrl` from `lib/orgId.js` (Task 2).
- Produces: a popup that shows "Export Project" or "Export Conversation" button based on the active tab's URL, or an instructive message if neither matches. Wires the button's click handler to a stub `runExport()` function (implemented fully in Task 6) so later tasks can fill it in without touching this file again.

- [ ] **Step 1: Update popup.html status/context elements (already scaffolded in Task 1 — verify structure)**

Confirm `extension/popup.html` has `#context-message`, `#export-btn`, and `#status` elements (added in Task 1). No change needed if present.

- [ ] **Step 2: Rewrite popup.js to detect context and toggle the button**

Replace the contents of `extension/popup.js`:
```javascript
let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;

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

function setStatus(message, kind) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind || '';
}

document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
});

async function runExport() {
  setStatus('Export logic not yet implemented.', 'error');
}
```

- [ ] **Step 3: Manually verify context detection**

Reload the extension (`chrome://extensions` → click the refresh icon on the extension card). Test three scenarios:
1. Navigate a tab to any `claude.ai/project/[uuid]` page, open the popup → expect "Claude Project detected." and an "Export Project" button.
2. Navigate a tab to any `claude.ai/chat/[uuid]` page, open the popup → expect "Claude Conversation detected." and an "Export Conversation" button.
3. Navigate a tab to `claude.ai` (homepage) or any other site, open the popup → expect the instructive message and no button.

- [ ] **Step 4: Commit**

```bash
git add extension/popup.js extension/popup.html
git commit -m "feat: detect project/conversation context and toggle export button"
```

---

## Task 4: API fetching (conversations list, individual conversations, batching, retry)

**Files:**
- Create: `extension/lib/api.js`
- Modify: `extension/popup.html` (add script tag — already present from Task 1, verify)

**Interfaces:**
- Consumes: `getOrganizationId()` from `lib/orgId.js` (Task 2).
- Produces:
  - `fetchConversationsList(orgId: string, projectId: string): Promise<Array<object>>` — returns the raw conversation metadata list.
  - `fetchConversation(orgId: string, conversationId: string, retries?: number): Promise<object | null>` — returns the full conversation JSON (with retry/backoff), or `null` on exhausted retries.
  - `fetchAllConversations(orgId: string, conversationsList: Array<object>, onProgress: (fetched: number, total: number) => void): Promise<Array<{metadata: object, data: object}>>` — batched fetch of every conversation in the list, reporting progress via callback.

This is a direct port of `fetchConversationsList`, `fetchConversation`, and `fetchAllConversations`/`processLargeProject` from `claude_project_export_script.js:211-397`, with `showNotification()` calls replaced by an `onProgress` callback (popup.js will use it to update the status div) and the `>100` chunking split removed in favor of a single uniform batching loop (large-project chunking was purely a memory-management artifact of the console context; simplify since the acceptance criteria don't require replicating that split).

- [ ] **Step 1: Write api.js**

Create `extension/lib/api.js`:
```javascript
function buildConversationsListUrl(orgId, projectId, limit = 1000, offset = 0) {
  return `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/conversations_v2?limit=${limit}&offset=${offset}`;
}

async function fetchConversationsList(orgId, projectId) {
  const url = buildConversationsListUrl(orgId, projectId);
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Authentication failed. Please log in to Claude and try again.');
    if (response.status === 403) throw new Error('Access denied. Make sure you have access to this project.');
    if (response.status === 404) throw new Error('Project not found. Check the project ID.');
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.data && Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  throw new Error('Invalid response structure - expected data.data array');
}

async function fetchConversation(orgId, conversationId, retries = 3) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'include' });

      if (response.status === 429) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}

async function fetchAllConversations(orgId, conversationsList, onProgress) {
  const conversations = [];
  const total = conversationsList.length;
  const batchSize = 5;

  for (let i = 0; i < total; i += batchSize) {
    const batch = conversationsList.slice(i, Math.min(i + batchSize, total));

    const batchPromises = batch.map(conv =>
      fetchConversation(orgId, conv.uuid).then(data => ({ metadata: conv, data }))
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value.data) {
        conversations.push(result.value);
      }
    }

    const fetched = Math.min(i + batchSize, total);
    if (onProgress) onProgress(fetched, total);

    if (i + batchSize < total) {
      const delay = total > 50 ? 750 : 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return conversations;
}
```

- [ ] **Step 2: Confirm popup.html loads api.js**

Confirm `extension/popup.html` includes `<script src="lib/api.js"></script>` before `popup.js` (added in Task 1 Step 3). No change needed if present.

- [ ] **Step 3: Manually verify fetchConversationsList against a live project**

With the extension loaded and a tab open on a real `claude.ai/project/[uuid]` page, in the popup's DevTools console run:
```javascript
getOrganizationId().then(orgId => {
  const projectId = getProjectIdFromUrl(location.href); // won't work in popup context, see note below
});
```
Note: the popup's `location.href` is the popup's own URL, not the tab's. Instead, manually supply a known project UUID from the active tab's address bar:
```javascript
getOrganizationId().then(orgId =>
  fetchConversationsList(orgId, 'PASTE-YOUR-PROJECT-UUID-HERE').then(list => console.log('conversations:', list.length, list[0]))
);
```
Expected: logs a count > 0 (for a non-empty project) and the first conversation's metadata object (with `uuid`, `name`, `created_at`, `updated_at`, `model` fields).

- [ ] **Step 4: Manually verify fetchConversation for a single conversation**

Using a `uuid` from the previous step's list output:
```javascript
getOrganizationId().then(orgId =>
  fetchConversation(orgId, 'PASTE-A-CONVERSATION-UUID-HERE').then(data => console.log('conversation:', data.name, data.chat_messages.length))
);
```
Expected: logs the conversation name and a `chat_messages` array with length > 0.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/api.js
git commit -m "feat: port conversation list/fetch API calls with batching and retry"
```

---

## Task 5: Markdown conversion and filename sanitization

**Files:**
- Create: `extension/lib/markdown.js`

**Interfaces:**
- Consumes: `{metadata: object, data: object}` conversation objects as produced by `fetchAllConversations` (Task 4).
- Produces:
  - `sanitizeFilename(filename: string): string` — same sanitization rules as the current script.
  - `convertToMarkdown(conversation: {metadata: object, data: object}): string` — full conversation markdown (messages, thinking, tool use/result, attachment text).
  - `createIndexMarkdown(projectId: string, conversations: Array<{metadata: object, data: object}>): string` — project-level index listing all conversations with links to their per-conversation folder.

This is a direct port of `sanitizeFilename`, `convertToMarkdown`, and `createIndexMarkdown` from `claude_project_export_script.js:455-561`, with one change to `createIndexMarkdown`: links point to `./<folder-name>/conversation.md` (folder-per-conversation) instead of `./<filename>.md` (flat file), to match the new zip structure from the design spec.

- [ ] **Step 1: Write markdown.js**

Create `extension/lib/markdown.js`:
```javascript
function sanitizeFilename(filename) {
  if (!filename) return 'untitled_conversation';

  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100)
    || 'untitled_conversation';
}

function conversationFolderName(conversation) {
  const uuid = conversation.metadata.uuid || conversation.data?.uuid || '';
  const uuidSuffix = uuid ? `_${uuid.substring(0, 8)}` : '';
  return `${sanitizeFilename(conversation.metadata.name)}${uuidSuffix}`;
}

function convertToMarkdown(conversation) {
  const { metadata, data } = conversation;

  if (!data || !data.chat_messages) {
    return `# ${metadata.name}\n\n*Failed to load conversation data*\n\n---\n\n`;
  }

  let markdown = `# ${data.name || metadata.name}\n\n`;

  if (data.summary) {
    markdown += `## Summary\n${data.summary}\n\n`;
  }

  markdown += `*Created: ${new Date(data.created_at || metadata.created_at).toLocaleString()}*\n`;
  markdown += `*Updated: ${new Date(data.updated_at || metadata.updated_at).toLocaleString()}*\n`;
  markdown += `*Model: ${metadata.model}*\n\n`;
  markdown += `---\n\n`;

  data.chat_messages.forEach(message => {
    const sender = message.sender === 'human' ? '👤 **Human**' : '🤖 **Claude**';
    markdown += `## ${sender}\n\n`;

    if (message.content && message.content.length > 0) {
      message.content.forEach(content => {
        if (content.type === 'thinking' && content.thinking) {
          const thinkingText = content.thinking.includes('characters truncated')
            ? '**Note:** Full thinking content is truncated in the export.\n\n'
            : content.thinking;
          markdown += `**Thinking:**\n\`\`\`\n${thinkingText}\n\`\`\`\n\n`;
        } else if (content.type === 'text' && content.text) {
          markdown += `${content.text}\n\n`;
        } else if (content.type === 'tool_use' && content.input) {
          markdown += `**Tool Use:**\n\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
        } else if (content.type === 'tool_result' && content.content) {
          markdown += `**Tool Result:**\n\`\`\`\n`;
          if (Array.isArray(content.content)) {
            content.content.forEach(item => {
              if (item.type === 'text') markdown += item.text;
            });
          } else {
            markdown += JSON.stringify(content.content, null, 2);
          }
          markdown += `\n\`\`\`\n\n`;
        }
      });
    }

    if (message.attachments && message.attachments.length > 0) {
      markdown += `### Attachments:\n`;
      message.attachments.forEach(attachment => {
        markdown += `- **${attachment.file_name || 'Attachment'}** (${attachment.file_type || 'file'})\n`;
        if (attachment.extracted_content && !attachment.extracted_content.includes('truncated')) {
          markdown += `  \`\`\`\n${attachment.extracted_content.substring(0, 500)}...\n  \`\`\`\n`;
        }
      });
      markdown += `\n`;
    }

    markdown += `*${new Date(message.created_at).toLocaleString()}*\n\n`;
    markdown += `---\n\n`;
  });

  return markdown;
}

function createIndexMarkdown(projectId, conversations) {
  let markdown = `# Claude Project Export\n\n`;
  markdown += `*Project ID: ${projectId}*\n`;
  markdown += `*Export Date: ${new Date().toLocaleString()}*\n`;
  markdown += `*Total Conversations: ${conversations.length}*\n\n`;
  markdown += `---\n\n`;
  markdown += `## Conversations\n\n`;

  const sorted = [...conversations].sort((a, b) =>
    new Date(b.metadata.updated_at) - new Date(a.metadata.updated_at)
  );

  sorted.forEach((conv, index) => {
    const folderName = conversationFolderName(conv);
    markdown += `${index + 1}. [${conv.metadata.name}](./${folderName}/conversation.md)\n`;
    markdown += `   - Created: ${new Date(conv.metadata.created_at).toLocaleDateString()}\n`;
    markdown += `   - Updated: ${new Date(conv.metadata.updated_at).toLocaleDateString()}\n`;
    markdown += `   - Model: ${conv.metadata.model}\n\n`;
  });

  return markdown;
}
```

- [ ] **Step 2: Confirm popup.html loads markdown.js**

Confirm `extension/popup.html` includes `<script src="lib/markdown.js"></script>` before `popup.js` (added in Task 1 Step 3). No change needed if present.

- [ ] **Step 3: Manually verify markdown conversion in the popup DevTools console**

Using conversation data fetched in Task 4 Step 4 (or a synthetic object), run:
```javascript
const sample = {
  metadata: { name: 'Test Conv', uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', model: 'claude-x' },
  data: {
    name: 'Test Conv',
    chat_messages: [
      { sender: 'human', content: [{ type: 'text', text: 'Hello' }], created_at: '2026-01-01T00:00:00Z' },
      { sender: 'assistant', content: [{ type: 'text', text: 'Hi there' }], created_at: '2026-01-01T00:01:00Z' }
    ]
  }
};
console.log(convertToMarkdown(sample));
console.log(conversationFolderName(sample));
console.log(createIndexMarkdown('proj-uuid', [sample]));
```
Expected: `convertToMarkdown` output contains `# Test Conv`, `👤 **Human**`, `Hello`, `🤖 **Claude**`, `Hi there`. `conversationFolderName` output is `Test_Conv_a1b2c3d4`. `createIndexMarkdown` output contains a link `[Test Conv](./Test_Conv_a1b2c3d4/conversation.md)`.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/markdown.js
git commit -m "feat: port markdown conversion with folder-based index links"
```

---

## Task 6: Zip building and download orchestration

**Files:**
- Create: `extension/lib/zipBuilder.js`
- Modify: `extension/popup.js`

**Interfaces:**
- Consumes:
  - `JSZip` global (from vendored `lib/jszip.min.js`, Task 1).
  - `convertToMarkdown`, `createIndexMarkdown`, `conversationFolderName` from `lib/markdown.js` (Task 5).
  - `getOrganizationId`, `getProjectIdFromUrl`, `getConversationIdFromUrl` from `lib/orgId.js` (Task 2).
  - `fetchConversationsList`, `fetchConversation`, `fetchAllConversations` from `lib/api.js` (Task 4).
- Produces:
  - `buildConversationFolder(zip: JSZip, folderName: string, conversation: {metadata: object, data: object}): void` — adds `conversation.md`, an `artefacts/.gitkeep` placeholder, and a `contenu/.gitkeep` placeholder under `folderName/` in the given zip.
  - `buildProjectZip(projectId: string, conversations: Array<{metadata: object, data: object}>): Promise<Blob>` — builds the full project zip (index.md + one folder per conversation).
  - `buildConversationZip(conversation: {metadata: object, data: object}): Promise<Blob>` — builds a single-conversation zip (one folder, no index).
  - Rewires `runExport()` in `popup.js` (stubbed in Task 3) to call the full pipeline: fetch → build zip → download via `chrome.downloads.download()`.

- [ ] **Step 1: Write zipBuilder.js**

Create `extension/lib/zipBuilder.js`:
```javascript
function buildConversationFolder(zip, folderName, conversation) {
  const folder = zip.folder(folderName);
  folder.file('conversation.md', convertToMarkdown(conversation));
  folder.folder('artefacts').file('.gitkeep', '');
  folder.folder('contenu').file('.gitkeep', '');
}

async function buildProjectZip(projectId, conversations) {
  const zip = new JSZip();
  zip.file('index.md', createIndexMarkdown(projectId, conversations));

  conversations.forEach(conv => {
    const folderName = conversationFolderName(conv);
    buildConversationFolder(zip, folderName, conv);
  });

  return zip.generateAsync({ type: 'blob' });
}

async function buildConversationZip(conversation) {
  const zip = new JSZip();
  const folderName = conversationFolderName(conversation);
  buildConversationFolder(zip, folderName, conversation);
  return zip.generateAsync({ type: 'blob' });
}
```

- [ ] **Step 2: Confirm popup.html loads zipBuilder.js**

Confirm `extension/popup.html` includes `<script src="lib/zipBuilder.js"></script>` before `popup.js` (added in Task 1 Step 3). No change needed if present.

- [ ] **Step 3: Replace the `runExport` stub in popup.js with the full pipeline**

In `extension/popup.js`, replace the stub `runExport` function (from Task 3 Step 2) with:
```javascript
async function runExport() {
  const exportBtn = document.getElementById('export-btn');
  exportBtn.disabled = true;

  try {
    setStatus('Resolving organization ID...', '');
    const orgId = await getOrganizationId();
    if (!orgId) {
      throw new Error('Could not find your organization ID. Make sure you are logged into claude.ai.');
    }

    let blob, downloadFilename;

    if (exportMode === 'project') {
      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, exportProjectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      blob = await buildProjectZip(exportProjectId, conversations);
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        setStatus(`✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`, 'success');
      } else {
        setStatus(`✅ Exported ${conversations.length} conversations.`, 'success');
      }
    } else if (exportMode === 'conversation') {
      setStatus('Fetching conversation...', '');
      const data = await fetchConversation(orgId, exportConversationId);
      if (!data) {
        throw new Error('Failed to fetch this conversation.');
      }

      const conversation = { metadata: { name: data.name, uuid: data.uuid, created_at: data.created_at, updated_at: data.updated_at, model: data.model }, data };

      setStatus('Building zip...', '');
      blob = await buildConversationZip(conversation);
      downloadFilename = `${conversationFolderName(conversation)}.zip`;
      setStatus('✅ Exported conversation.', 'success');
    } else {
      throw new Error('No project or conversation detected.');
    }

    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    exportBtn.disabled = false;
  }
}
```

- [ ] **Step 4: Manually verify end-to-end project export**

Reload the extension. Navigate to a real, small (1-5 conversation) `claude.ai/project/[uuid]` page. Open the popup, click "Export Project". Expected:
- Status text progresses through "Resolving organization ID...", "Fetching conversations list...", "Fetched N/N conversations...", "Building zip...", ending in "✅ Exported N conversations."
- Chrome downloads a file named `project_<8-char-id>.zip`.
- Unzip it: verify `index.md` exists at the root and links to each `<folder>/conversation.md`; verify each conversation folder contains `conversation.md`, `artefacts/.gitkeep`, `contenu/.gitkeep`.

- [ ] **Step 5: Manually verify end-to-end single conversation export**

Navigate to a real `claude.ai/chat/[uuid]` page (a conversation not inside a project view). Open the popup, click "Export Conversation". Expected:
- Status ends in "✅ Exported conversation."
- Chrome downloads a `.zip` named after the sanitized conversation title + short UUID.
- Unzip it: verify one folder containing `conversation.md`, `artefacts/.gitkeep`, `contenu/.gitkeep`.

- [ ] **Step 6: Manually verify auth failure handling**

Log out of claude.ai (or open the popup in a Chrome profile without a claude.ai session) and click export. Expected: status shows an "Export failed: ..." error message, button re-enables, no zip downloaded.

- [ ] **Step 7: Commit**

```bash
git add extension/lib/zipBuilder.js extension/popup.js
git commit -m "feat: wire full export pipeline with zip download"
```

---

## Task 7: Repo cleanup and documentation update

**Files:**
- Delete: `index.html`
- Delete: `.nojekyll`
- Delete: `claude_project_bookmarklet.js`
- Delete: `claude_project_export_script.js`
- Delete: `claude_project_exporter.user.js`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing (pure cleanup/doc task, no code dependency on other tasks — can run any time after Task 6 since it references the extension in docs).

- [ ] **Step 1: Delete obsolete files**

```bash
git rm index.html .nojekyll claude_project_bookmarklet.js claude_project_export_script.js claude_project_exporter.user.js
```

- [ ] **Step 2: Rewrite README.md**

Replace the full contents of `README.md`:
```markdown
# Claude Conversations Exporter

A Chrome extension that exports Claude conversations to structured Markdown.

- **Project export**: exports every conversation in a Claude Project as a `.zip` containing an `index.md` summary plus one folder per conversation.
- **Single conversation export**: exports one conversation as a `.zip` with the same per-conversation folder structure.

## Installation (developer mode)

This extension is not published to the Chrome Web Store. Install it manually:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder from this repository.
5. Pin the extension to your toolbar for easy access.

## Usage

1. Log into [claude.ai](https://claude.ai).
2. Navigate to a Claude Project page (`claude.ai/project/[uuid]`) or a conversation page (`claude.ai/chat/[uuid]`).
3. Click the extension icon in your Chrome toolbar.
4. Click **Export Project** or **Export Conversation** (the button label depends on which page you're on).
5. Wait for the export to complete — a `.zip` file will download automatically.

## Output structure

**Project export** (`project_<id>.zip`):
```
index.md
conversation-title_<uuid8>/
  conversation.md
  artefacts/
  contenu/
another-conversation_<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

**Single conversation export** (`conversation-title_<uuid8>.zip`):
```
conversation-title_<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

`artefacts/` and `contenu/` are currently created empty — they're reserved for a future update that will populate them with Claude-generated artifacts and uploaded file attachments respectively.

## How it works

The extension reads your `claude.ai` session cookie (`lastActiveOrg`) to identify your organization, then calls the same internal APIs the claude.ai web app uses to list and fetch conversations. All processing happens locally in your browser — no data is sent anywhere except to claude.ai itself.

## Related Tools

- **[Claude Project Knowledge Exporter](https://github.com/withLinda/claude-project-knowledge-exporter)** - Export project knowledge documentations from Claude Projects
- **[Claude Conversation Exporter](https://github.com/withLinda/claude-conversation-exporter)** - Export individual Claude conversations to Markdown

## License

This tool is provided as-is for personal use. Please respect Claude AI's terms of service and rate limits.
```

- [ ] **Step 3: Rewrite CLAUDE.md**

Replace the full contents of `CLAUDE.md`:
```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Claude Conversations Exporter** - a Chrome extension (Manifest V3) that exports Claude Project conversations or single conversations as structured `.zip` files containing Markdown.

## Architecture

- `extension/manifest.json` - Manifest V3 config (permissions: `downloads`, `activeTab`, `cookies`; host permission: `https://claude.ai/*`).
- `extension/popup.html` / `extension/popup.js` - Popup UI: detects context (project vs conversation vs neither) from the active tab's URL, orchestrates the export pipeline, shows progress/status.
- `extension/lib/orgId.js` - Project/conversation ID extraction from URLs; organization ID lookup via `chrome.cookies.get` on the `lastActiveOrg` cookie.
- `extension/lib/api.js` - Fetches the conversations list and individual conversations from claude.ai's internal API, with batching (5 at a time) and exponential-backoff retry on rate limiting (429).
- `extension/lib/markdown.js` - Converts conversation JSON to Markdown; builds the project index; sanitizes filenames.
- `extension/lib/zipBuilder.js` - Builds the in-memory folder tree and generates the zip Blob via vendored JSZip.
- `extension/lib/jszip.min.js` - Vendored JSZip (no CDN — Manifest V3 CSP disallows remote code).

## Key Technical Details

### ID Extraction
- Project ID: parsed from the active tab's URL, pattern `/project/[uuid]`.
- Conversation ID: parsed from the active tab's URL, pattern `/chat/[uuid]`.
- Organization ID: read from the `lastActiveOrg` cookie via `chrome.cookies.get({url: 'https://claude.ai', name: 'lastActiveOrg'})`. Unlike the old console-script approach, the popup has no access to the page's `localStorage`/`sessionStorage`/JS globals, so there is no fallback chain beyond the cookie — if it's missing, export fails with an explicit error asking the user to confirm they're logged in.

### API Flow
1. **Conversations List** (project mode only): `GET /api/organizations/[org]/projects/[project]/conversations_v2`
2. **Individual Conversations**: `GET /api/organizations/[org]/chat_conversations/[conv]?tree=True&rendering_mode=messages&render_all_tools=true`
3. All fetches use `credentials: 'include'` to leverage the existing claude.ai browser session.

### Output Structure
Every export is a single `.zip` download (built with vendored JSZip, never written to disk as loose files):
- Project export: `index.md` at the root + one folder per conversation (`<title>_<uuid8>/`), each containing `conversation.md`, `artefacts/` (empty), `contenu/` (empty).
- Single conversation export: one folder with the same `conversation.md` + `artefacts/` + `contenu/` structure, no index.

`artefacts/` (Claude-generated artifacts) and `contenu/` (uploaded file attachments) are placeholders in the current version — populating them with real content is a planned future phase, not yet implemented.

### Rate Limiting & Batching
- Conversations fetched in batches of 5, with a 500-750ms delay between batches (750ms above 50 conversations).
- Individual conversation fetch retries up to 3 times on failure, with exponential backoff starting at 1000ms (capped at 10000ms) on HTTP 429.
- Partial failures are tolerated: if some conversations fail to fetch, the export still completes with the successful ones, and the status message reports how many failed.

## Development Guidelines

### Code Standards
- Pure vanilla JavaScript - no frameworks, no bundler, no build step.
- Manifest V3 - all scripts loaded via `<script>` tags in `popup.html`, no ES modules, no dynamic `import()`.
- The only external dependency is the vendored `jszip.min.js` - do not add a CDN reference (blocked by MV3 CSP).

### Testing Approach
No automated test suite. Manual verification against a live claude.ai session, covering:
1. Empty project (0 conversations).
2. Small project (1-20 conversations).
3. Larger project (50+ conversations) - verify batching/delay behavior.
4. Single conversation export outside a project.
5. Logged-out / auth failure state.
6. Popup opened on an unrelated claude.ai page or a different site - should show the "navigate to a project/conversation" message, no button.

### Testing New Changes
1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked" (first time) or the refresh icon on the extension card (after edits) and select/reload the `extension/` folder.
3. Navigate to a Claude project or conversation page and use the popup.
4. Inspect the popup's console via right-click → Inspect for `console.log`/error output.

## Security Considerations

- Client-side only - no data sent anywhere except claude.ai's own API.
- Uses the browser's existing claude.ai session (cookies) - no credential storage by the extension.
- No external dependencies loaded at runtime - JSZip is vendored, not fetched from a CDN (MV3 CSP requirement).

## Distribution

This extension is developer-mode only (unpacked) - it is not published to the Chrome Web Store. There is no `key` field in the manifest and no store-review-oriented permission minimization beyond what's functionally required.
```

- [ ] **Step 4: Verify no dangling references to deleted files**

Run:
```bash
grep -rn "claude_project_export_script\|claude_project_exporter\.user\|claude_project_bookmarklet\|index\.html\|\.nojekyll" --include="*.md" --include="*.json" .
```
Expected: no matches (empty output). If any appear (e.g. in `docs/superpowers/specs/`), leave spec files untouched (they're historical records) but confirm `README.md` and `CLAUDE.md` are clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated export scripts and GitHub Pages artifacts, rewrite docs for the Chrome extension"
```

---

## Self-Review Notes

- **Spec coverage:** Manifest V3 popup-triggered export (Task 3/6), project + conversation modes (Task 3/6), zip-based folder output with `index.md` + per-conversation `conversation.md`/`artefacts/`/`contenu/` (Task 6), vendored JSZip / no CDN (Task 1), repo cleanup of `index.html`/`.nojekyll`/three legacy scripts (Task 7), developer-mode-only distribution and no-icons decision (reflected in Task 1's manifest, no separate task needed) — all covered.
- **Placeholder scan:** all code blocks are complete, runnable; no TBD/TODO left.
- **Type consistency:** `conversationFolderName`, `convertToMarkdown`, `createIndexMarkdown` (Task 5) match the calls made in `zipBuilder.js` (Task 6) and `popup.js`. `fetchAllConversations(orgId, conversationsList, onProgress)` signature in Task 4 matches its call site in Task 6 Step 3. `getOrganizationId()` returns `Promise<string|null>` consistently between Task 2's definition and Task 6's `await` usage.
