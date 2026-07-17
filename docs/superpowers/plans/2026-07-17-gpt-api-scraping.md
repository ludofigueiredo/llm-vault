# GPT API-based Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DOM scraping of ChatGPT conversation content with `/backend-api` calls — full conversation JSON (`mapping`) parsed to markdown, plus authenticated download of all file types into `contenu-gpt/`.

**Architecture:** All API calls run in the content script (`content-gpt.js`, page context with session cookies). A pure `mappingToTurns` parser and `extractFileReferences` (both functions of the conversation JSON, unit-testable in Node) drive markdown + file lists. The panel receives turns + base64 file bytes via one message and builds the zip. DOM stays the source only for project-scoped data (convId list, instructions) and multi-project selection. Per-conversation navigation is kept.

**Tech Stack:** Vanilla JS, Chrome Manifest V3, vendored JSZip. No bundler, no ES modules, no CDN.

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no build step. No ES modules, no dynamic `import()`, no CDN (MV3 CSP).
- No automated test suite in this repo. "Tests" here are: (a) Node pure-function checks for `mappingToTurns` / `extractFileReferences` / `mappingToTurns` file-link building (functions of a plain JS object — no DOM, no chrome, no fetch); (b) `node --check` syntax validation for content-script/panel code; (c) explicit manual in-browser verification steps for the human (content scripts and API auth cannot run under Node).
- Never modify existing Claude files' behavior (`content.js`, `api.js`, `markdown.js`, `orgId.js`, `zipBuilder.js`). GPT changes stay in `content-gpt.js`, `lib/gptExport.js`, `lib/gptMarkdown.js`.
- API calls run in the content script only (page context). Panel receives results via `chrome.runtime.sendMessage`.
- Binary file bytes cross the message boundary as **base64 strings** (JSON-serializable), decoded to `Uint8Array` in the panel before `folder.file(...)`.
- API endpoints: token `GET /api/auth/session` → `accessToken`; conversation `GET /backend-api/conversation/{convId}`; file `GET /backend-api/files/download/{fileId}` → `download_url`. Headers on `/backend-api`: `Content-Type`, `Accept`, `Authorization: Bearer <token>`, `Oai-Device-Id: <uuid>`, `Oai-Language: en-US`.
- Output structure unchanged: `index.md`, `instructions.md` (if non-empty), per-conversation `<title>_<convId8>/` with `conversation.md` + `contenu-gpt/` (all file types; `.gitkeep` if none/all failed). French headings `## Vous` / `## ChatGPT`.
- Parser faithful to the console script: tree walk from root, emit user + text assistant, skip system/tool + non-text assistant, images/attachments/citations handled, `stripCitations` removes `【…】`.

---

## File Structure

- Modify: `extension/lib/gptMarkdown.js` — turns are now `{role, markdown}`; write markdown as-is; remove `gptHtmlToMarkdown` + its test.
- Modify: `extension/content-gpt.js` — add API access + `mappingToTurns` + `extractFileReferences` + `MIME_TO_EXT` + `deduplicateFilename` + `stripCitations` + `GET_GPT_CONVERSATION_VIA_API` handler; remove the DOM thread-scraping block + old `GET_GPT_CONVERSATION` handler.
- Modify: `extension/lib/gptExport.js` — send `GET_GPT_CONVERSATION_VIA_API`; decode base64 file bytes into `contenu-gpt/`.
- Modify: `test/gptMarkdown.test.js` — update for `{role, markdown}` turns; drop the HTML-converter assertions.
- Create: `test/gptMapping.test.js` — Node unit tests for `mappingToTurns` + `extractFileReferences`.
- Modify: `CLAUDE.md` — document the API-based approach.

---

## Task 1: Retarget markdown builder to `{role, markdown}` turns; remove HTML converter

**Files:**
- Modify: `extension/lib/gptMarkdown.js`
- Modify: `test/gptMarkdown.test.js`

**Interfaces:**
- Produces: `gptTurnsToMarkdown(project, turns) -> string` where `turns` is `[{role:'user'|'assistant', markdown:string}]`. User → `## Vous`, assistant → `## ChatGPT`, body is `turn.markdown` written as-is.
- Removes: `gptHtmlToMarkdown` (and its export) — dead now that content is markdown from JSON.
- Unchanged exports: `gptInstructionsMarkdown`, `gptIndexMarkdown`, `gptConvFolderName`, `gptSanitizeFilename`.

- [ ] **Step 1: Update the test**

Replace `test/gptMarkdown.test.js` entirely with:
```js
const assert = require('assert');

const {
  gptTurnsToMarkdown,
  gptInstructionsMarkdown,
  gptIndexMarkdown,
  gptConvFolderName,
} = require('../extension/lib/gptMarkdown.js');

// turns are now {role, markdown} — written as-is under the role heading
const md = gptTurnsToMarkdown(
  { name: 'CV 2026' },
  [
    { role: 'user', markdown: 'Salut GPT' },
    { role: 'assistant', markdown: '# Titre\n\n**gras** et `code`.' },
  ]
);
assert.ok(md.includes('## Vous'), 'has user heading');
assert.ok(md.includes('Salut GPT'), 'has user text');
assert.ok(md.includes('## ChatGPT'), 'has assistant heading');
assert.ok(md.includes('# Titre'), 'assistant markdown written as-is');
assert.ok(md.includes('**gras** et `code`.'), 'assistant markdown untouched');

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

// folder name
assert.strictEqual(
  gptConvFolderName({ title: 'Avis: CV/2026', convId: '692955e1-3d78-8325-b019-7a4326ada801' }),
  'Avis_ CV_2026_692955e1'
);

// gptHtmlToMarkdown must no longer be exported
const mod = require('../extension/lib/gptMarkdown.js');
assert.strictEqual(mod.gptHtmlToMarkdown, undefined, 'gptHtmlToMarkdown removed');

console.log('gptMarkdown: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/gptMarkdown.test.js`
Expected: FAIL — the current `gptTurnsToMarkdown` reads `turn.text`/`turn.html`, so the assistant-markdown assertions fail (and `gptHtmlToMarkdown` is still exported).

- [ ] **Step 3: Edit `gptMarkdown.js`**

Delete the entire self-contained HTML→Markdown block (the functions `gptDefaultParser`, `gptInlineToMd`, `gptBlockToMd`, `gptHtmlToMarkdown` and the two comment banner lines around them).

Replace `gptTurnsToMarkdown` with:
```js
function gptTurnsToMarkdown(project, turns) {
  const lines = [`# ${project.name || 'Conversation'}`, ''];
  for (const turn of turns) {
    const heading = turn.role === 'user' ? '## Vous' : '## ChatGPT';
    lines.push(heading, '', (turn.markdown || '').trim(), '');
  }
  return lines.join('\n');
}
```

Update the `module.exports` block to drop `gptHtmlToMarkdown`:
```js
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
git commit -m "refactor: GPT turns carry markdown directly; drop HTML converter"
```

---

## Task 2: Conversation JSON parser (`mappingToTurns` + `extractFileReferences`)

**Files:**
- Modify: `extension/content-gpt.js` (add pure functions near the top, before the message router)
- Create: `test/gptMapping.test.js`

**Interfaces:**
- Produces (must be Node-exportable for the test — see Step 3's export note):
  - `gptStripCitations(str) -> string` — removes `【…】` spans.
  - `gptExtractFileReferences(convo) -> [{fileId, filename, type}]` — de-duplicated by fileId; from `image_asset_pointer` parts (`file-service://`/`sediment://`), `metadata.attachments`, `metadata.citations`.
  - `gptMappingToTurns(convo, fileMap) -> [{role, markdown}]` — tree walk from root; emit user + text assistant; skip system/tool + non-text assistant; images → `![image](contenu-gpt/<file>)` when in `fileMap` else `[image]`; attachments → `📎 [name](contenu-gpt/<file>)`; citations stripped. `fileMap` is `{fileId: 'contenu-gpt/<filename>'}`.

- [ ] **Step 1: Write the test**

`test/gptMapping.test.js`:
```js
const assert = require('assert');
const {
  gptStripCitations,
  gptExtractFileReferences,
  gptMappingToTurns,
} = require('../extension/content-gpt.js');

// stripCitations removes 【...】 spans
assert.strictEqual(gptStripCitations('foo【12†bar】 baz'), 'foo baz');

// A small conversation tree: root -> user -> assistant.
const convo = {
  title: 'T',
  mapping: {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: {
      id: 'u1', parent: 'root', children: ['a1'],
      message: {
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['Bonjour GPT'] },
        metadata: {},
      },
    },
    a1: {
      id: 'a1', parent: 'u1', children: [],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['# Titre\n\nRéponse【1†src】.'] },
        metadata: {},
      },
    },
  },
};

const turns = gptMappingToTurns(convo, {});
assert.strictEqual(turns.length, 2, 'two turns');
assert.deepStrictEqual(turns[0], { role: 'user', markdown: 'Bonjour GPT' });
assert.strictEqual(turns[1].role, 'assistant');
assert.ok(turns[1].markdown.includes('# Titre'), 'assistant markdown preserved');
assert.ok(!turns[1].markdown.includes('【'), 'citations stripped');

// system/tool + non-text assistant are skipped
const convo2 = {
  mapping: {
    r: { parent: null, children: ['s', 't', 'x'], message: null },
    s: { parent: 'r', children: [], message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['sys'] }, metadata: {} } },
    t: { parent: 'r', children: [], message: { author: { role: 'tool' }, content: { content_type: 'text', parts: ['tool out'] }, metadata: {} } },
    x: { parent: 'r', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'code', parts: ['print(1)'] }, metadata: {} } },
  },
};
assert.strictEqual(gptMappingToTurns(convo2, {}).length, 0, 'system/tool/non-text skipped');

// image + attachment references, with fileMap producing contenu-gpt/ links
const convo3 = {
  mapping: {
    r: { parent: null, children: ['m'], message: null },
    m: {
      parent: 'r', children: [],
      message: {
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-ABC', metadata: {} },
            'un texte',
          ],
        },
        metadata: { attachments: [{ id: 'file-DOC', name: 'rapport.docx' }] },
      },
    },
  },
};
const refs = gptExtractFileReferences(convo3);
const ids = refs.map((r) => r.fileId).sort();
assert.deepStrictEqual(ids, ['file-ABC', 'file-DOC']);

const fileMap = { 'file-ABC': 'contenu-gpt/image.png', 'file-DOC': 'contenu-gpt/rapport.docx' };
const turns3 = gptMappingToTurns(convo3, fileMap);
assert.ok(turns3[0].markdown.includes('![image](contenu-gpt/image.png)'), 'image link');
assert.ok(turns3[0].markdown.includes('un texte'), 'text part kept');
assert.ok(turns3[0].markdown.includes('📎 [rapport.docx](contenu-gpt/rapport.docx)'), 'attachment link');

console.log('gptMapping: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/gptMapping.test.js`
Expected: FAIL — the functions aren't defined/exported yet.

- [ ] **Step 3: Add the parser to `content-gpt.js`**

Insert these functions near the top of `extension/content-gpt.js` (after the existing `gptWaitForCondition`, before the message router). They are pure (no DOM/chrome/fetch):
```js
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
```

- [ ] **Step 4: Add a Node-export shim at the very bottom of `content-gpt.js`**

Content scripts run in the browser (no `module`), but the test needs these three functions under Node. Append at the end of the file:
```js
// Node export for pure-function tests only (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptStripCitations, gptExtractFileReferences, gptMappingToTurns };
}
```
Note: requiring `content-gpt.js` under Node executes the whole file. The `chrome.runtime.onMessage.addListener(...)` call at the bottom would throw (`chrome` undefined). To keep the file requirable, guard the listener registration: wrap the existing `chrome.runtime.onMessage.addListener(...)` call in `if (typeof chrome !== 'undefined' && chrome.runtime) { ... }`. Make that guard change in this task so the test can require the module.

- [ ] **Step 5: Run test to verify it passes**

Run: `node test/gptMapping.test.js`
Expected: PASS — prints `gptMapping: all assertions passed`.

- [ ] **Step 6: Verify content-gpt.js still parses as a browser script**

Run: `node --check extension/content-gpt.js`
Expected: no output (syntax OK).

- [ ] **Step 7: Commit**

```bash
git add extension/content-gpt.js test/gptMapping.test.js
git commit -m "feat: add GPT conversation JSON parser (mappingToTurns, file refs)"
```

---

## Task 3: API access + `GET_GPT_CONVERSATION_VIA_API` handler; remove DOM thread scraping

**Files:**
- Modify: `extension/content-gpt.js`

**Interfaces:**
- Consumes: `gptExtractFileReferences`, `gptMappingToTurns` (Task 2).
- Produces (message handler): `GET_GPT_CONVERSATION_VIA_API` (`{convId}`) → `{title, createTime, turns:[{role,markdown}], files:[{filename, bytesBase64}]}`. Async (`return true`).
- Removes: `gptFindTurns`, `gptWaitForThreadToStabilize`, `gptScrapeTurn`, `gptScrapeThreadImages`, `gptGetConversation`, and the `GET_GPT_CONVERSATION` handler.

**Manual verification only** (API auth + content-script — cannot run under Node).

- [ ] **Step 1: Remove the DOM thread-scraping block**

In `extension/content-gpt.js`, delete the five functions `gptFindTurns`, `gptWaitForThreadToStabilize`, `gptScrapeTurn`, `gptScrapeThreadImages`, `gptGetConversation` (the contiguous block that currently sits between `gptGetProjectConversations` and the `GPT_SELECTED_CLASS` selection block).

- [ ] **Step 2: Add API access + conversation fetch**

Add these functions to `content-gpt.js` (near the other GPT helpers, before the message router). They use `fetch` (browser only):
```js
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
```

- [ ] **Step 3: Swap the message handler**

In the `chrome.runtime.onMessage.addListener(...)` router, remove the `GET_GPT_CONVERSATION` handler and add:
```js
  if (message && message.type === 'GET_GPT_CONVERSATION_VIA_API') {
    gptGetConversationViaApi(message.convId).then(sendResponse).catch(() => sendResponse({ error: true }));
    return true;
  }
```

- [ ] **Step 4: Verify syntax + module still requires**

Run: `node --check extension/content-gpt.js`
Expected: no output.
Run: `node -e "require('./extension/content-gpt.js'); console.log('requires OK')"`
Expected: `requires OK` (the chrome-guard from Task 2 keeps the listener from throwing; the new fetch code is inside functions, not executed at load).

- [ ] **Step 5: Manual verification (human)**

1. Reload the unpacked extension.
2. Open a GPT conversation page (`/g/g-p-.../c/<convId>`).
3. In the panel console:
   ```js
   const [t] = await chrome.tabs.query({active:true,currentWindow:true});
   const r = await chrome.tabs.sendMessage(t.id, {type:'GET_GPT_CONVERSATION_VIA_API', convId: '<convId from the URL>'});
   console.log(r.turns.length, r.turns[0], r.files.map(f=>f.filename));
   ```
   Expected: `turns` covers the whole thread (user/assistant, markdown bodies); `files` lists any attachments/images with real filenames+extensions. If `r.error` is set, check you're logged in (token) and the convId is correct.

- [ ] **Step 6: Commit**

```bash
git add extension/content-gpt.js
git commit -m "feat: fetch GPT conversation via /backend-api; drop DOM thread scraping"
```

---

## Task 4: Panel consumes API turns + base64 files

**Files:**
- Modify: `extension/lib/gptExport.js`

**Interfaces:**
- Consumes: `GET_GPT_CONVERSATION_VIA_API` → `{title, createTime, turns, files:[{filename, bytesBase64}]}`.
- Produces: `gptScrapeProject` result conversations now carry `{...conv, turns, files}`; `gptBuildConversationFolder` writes `conversation.md` from `turns` and decodes each `file.bytesBase64` into `contenu-gpt/`.

**Manual verification** (panel + chrome APIs).

- [ ] **Step 1: Update `gptScrapeProject` to send the API message**

In `extension/lib/gptExport.js`, replace the conversation fetch inside the loop (the `GET_GPT_CONVERSATION` block) so it sends the API message and stores `turns`/`files`:
```js
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_CONVERSATION_VIA_API', convId: conv.convId });
      result.conversations.push({
        ...conv,
        turns: (data && data.turns) || [],
        files: (data && data.files) || [],
      });
```
And update the two failure fallbacks in that loop (the `!convReady` branch and the `catch`) to push `{ ...conv, turns: [], files: [] }` instead of the old `turns/contentFiles` shape.

- [ ] **Step 2: Update the zip builder to decode base64 files**

Replace `gptBuildConversationFolder` in `gptExport.js` with:
```js
function gptBase64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gptBuildConversationFolder(target, conv) {
  const folder = target.folder(gptConvFolderName(conv));
  folder.file('conversation.md', gptTurnsToMarkdown({ name: conv.title }, conv.turns || []));
  const contenu = folder.folder('contenu-gpt');
  const files = conv.files || [];
  let any = false;
  for (const f of files) {
    try {
      contenu.file(f.filename, gptBase64ToBytes(f.bytesBase64));
      any = true;
    } catch (e) {
      // Skip a corrupt entry; keep going.
    }
  }
  if (!any) contenu.file('.gitkeep', '');
}
```
Note: this no longer calls `fetchFilesInto` (bytes arrive decoded from the content script). `gptBuildProjectInto` is unchanged (it still calls `gptBuildConversationFolder`).

- [ ] **Step 3: Verify syntax**

Run: `node --check extension/lib/gptExport.js`
Expected: no output. (`atob`/`chrome`/`JSZip` are browser/panel globals; `--check` only parses.)

- [ ] **Step 4: Manual verification (human) — full single-project export**

1. Reload unpacked. Open a GPT project page. Click "Export GPT Project".
2. A `gpt_project_<name>.zip` downloads.
3. Unzip and verify: `index.md`, `instructions.md` (if any), one folder per conversation with `conversation.md` (user/assistant turns, markdown intact) and `contenu-gpt/` containing the real files (images AND docx/pdf/xlsx if the conversation had them), each opening correctly. Empty `contenu-gpt/` has only `.gitkeep`.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/gptExport.js
git commit -m "feat: panel writes GPT conversation from API turns + decoded files"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the ChatGPT Export section**

In `CLAUDE.md`'s `## ChatGPT Export` section, revise to reflect the API-based approach: conversation content and file downloads now come from `/backend-api` (`conversation/{id}` JSON `mapping` parsed by `gptMappingToTurns`; files via `files/download/{id}`, all types, into `contenu-gpt/`), with the session token from `/api/auth/session`; API calls run in the content script; turns cross to the panel as `{role, markdown}` and file bytes as base64. Note that DOM scraping is now used ONLY for project-scoped data (the project's convId list and instructions) and multi-project selection. Remove the now-inaccurate description of DOM thread scraping (auto-scroll/virtualization) and of the in-house HTML→markdown converter (deleted). Update Known Limitations: non-image files ARE now downloaded; long-thread virtualization is no longer a concern (API returns the full thread). Keep the standalone-conversation limitation.

- [ ] **Step 2: Verify against code**

Re-read the revised section against `content-gpt.js`/`gptExport.js`/`gptMarkdown.js`; fix any statement that doesn't match (function names, message type `GET_GPT_CONVERSATION_VIA_API`, `contenu-gpt/`, base64 transfer).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document API-based GPT conversation scraping"
```

---

## Self-Review Notes

- **Spec coverage:** §4 API access → Task 3 (`gptGetSessionToken`/`gptApiGet`). §5 conversation flow → Task 3 (`gptGetConversationViaApi`) + Task 2 (refs/parser). §6 mapping→markdown → Task 2 (`gptMappingToTurns`) + Task 1 (`gptTurnsToMarkdown` writes markdown as-is). §7 output structure → Task 4 (`contenu-gpt/`, decoded files). §8 delta: `gptMarkdown` → Task 1; `content-gpt` add/remove → Tasks 2–3; `gptExport` → Task 4. §9 error handling → Task 3 (token throw, per-file skip) + Task 4 (per-file skip, `.gitkeep`) + existing `gptScrapeProject` per-conversation try/catch (kept). §5 base64 transfer → Task 3 (`gptBytesToBase64`) + Task 4 (`gptBase64ToBytes`). Remove `gptHtmlToMarkdown` → Task 1.
- **Placeholder scan:** No TBD/TODO. Rate-limit delay is concrete (300ms between files; per-conversation navigation already paces the loop).
- **Type consistency:** turns are `{role, markdown}` produced by `gptMappingToTurns` (Task 2), consumed by `gptTurnsToMarkdown` (Task 1) and threaded through `gptScrapeProject` (Task 4). Files are `{filename, bytesBase64}` produced by `gptDownloadFile` (Task 3), decoded by `gptBase64ToBytes` (Task 4). `fileMap[fileId] = 'contenu-gpt/<filename>'` set in Task 3, consumed by `gptMappingToTurns` (Task 2). Message type `GET_GPT_CONVERSATION_VIA_API` consistent across Tasks 3–4.
