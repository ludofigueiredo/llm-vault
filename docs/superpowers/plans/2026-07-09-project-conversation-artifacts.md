# Per-Conversation Artifacts & Content in Project Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `artefacts/` and `contenu/` for every conversation in a project export (single-project and multi-project batch alike), reusing the JSON-path-extraction approach from single-conversation export for artifacts/non-image files, and adding one navigation-per-conversation pass for image content files.

**Architecture:** Split conversation artifact data into two sources: (1) a pure, no-navigation JSON-path extraction (already proven in single-conversation export, moved to a shared location and reused for every conversation in a project) and (2) a navigation-based DOM scrape limited to image content files, run once per conversation after the existing batched conversation fetch. `buildProjectZip` gains a `Map<uuid, artifactsData>` parameter so each conversation's folder gets its real data instead of always being empty.

**Tech Stack:** Vanilla JavaScript, Chrome Extension Manifest V3, no build step (see project CLAUDE.md).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no ES modules, no dynamic `import()` (all files loaded via `<script>` tags in `sidepanel.html`).
- Every new/changed function must degrade gracefully: a failure at any step (navigation timeout, unresponsive content script, failed fetch) must never abort the overall project/batch export — it only leaves that one piece of data missing, consistent with every existing capture mechanism in this codebase.
- Status messages during the new navigation phase must read `"Capturing images N/Total: <conversation name>..."` (exact format, matching the existing `"Scraping project N/Total: <name>..."` pattern already used in `startBatchExport`).
- No user-facing toggle to skip the new navigation phase — it always runs.
- `extractFilePaths`'s existing regex/behavior (`USER_DATA_PATH_PATTERN`) must not change — only its file location changes.

---

### Task 1: Move `extractFilePaths` into `extension/lib/api.js`

**Files:**
- Modify: `extension/lib/api.js`
- Modify: `extension/sidepanel.js:1-32`
- Modify: `extension/sidepanel.html` (verify script load order — no change expected, but confirm `api.js` loads before `sidepanel.js`)

**Interfaces:**
- Produces: `extractFilePaths(conversationData)` → `{uploads: string[], outputs: string[]}`, now defined in `extension/lib/api.js`, available globally (no ES modules — all scripts share one global scope via `<script>` tags) to `sidepanel.js` and any other script loaded after it.

- [ ] **Step 1: Move the function and its regex into `lib/api.js`**

Append to the end of `extension/lib/api.js` (after `fetchAllConversations`):

```javascript
// Matches /mnt/user-data/uploads/<name> or /mnt/user-data/outputs/<name> as
// they appear inside the conversation JSON's string values (tool_use bash
// commands, tool_result output, chat_messages[].files[].path, etc.). Some of
// these strings are multi-line bash commands rather than a bare path, so the
// filename portion is restricted to characters plausible in a real
// filename (word chars, spaces, dots, hyphens, parens) rather than reading
// until the next quote — otherwise a `cp src dst\n...` command would swallow
// everything up to its own closing quote as part of the "path".
const USER_DATA_PATH_PATTERN = /\/mnt\/user-data\/(uploads|outputs)\/[\w .()-]+\.[\w]+/g;

function extractFilePaths(conversationData) {
  const json = JSON.stringify(conversationData);
  const uploads = new Set();
  const outputs = new Set();

  let match;
  while ((match = USER_DATA_PATH_PATTERN.exec(json)) !== null) {
    const bucket = match[1];
    const path = match[0];
    if (bucket === 'uploads') uploads.add(path);
    else outputs.add(path);
  }

  return { uploads: [...uploads], outputs: [...outputs] };
}
```

- [ ] **Step 2: Remove the moved code from `sidepanel.js`**

Delete lines 8-32 of `extension/sidepanel.js` (the `USER_DATA_PATH_PATTERN` constant and `extractFilePaths` function) — the file's top should go directly from the `let batchInProgress = false;` line to the `function isProjectsListingUrl(url) {` line.

- [ ] **Step 3: Verify script load order in `sidepanel.html`**

Read `extension/sidepanel.html` and confirm `extension/lib/api.js` is loaded via `<script src="lib/api.js"></script>` (or similar) BEFORE `extension/sidepanel.js`. If `api.js` is not currently loaded before `sidepanel.js`, reorder the `<script>` tags so it is (all globals must be defined before the script that uses them runs, since there's no module system).

- [ ] **Step 4: Verify no syntax errors**

Run: `node -c extension/lib/api.js` and `node -c extension/sidepanel.js`
Expected: both exit with no output (success).

- [ ] **Step 5: Commit**

```bash
git add extension/lib/api.js extension/sidepanel.js extension/sidepanel.html
git commit -m "refactor: move extractFilePaths into lib/api.js for reuse by project export"
```

---

### Task 2: Add a shared JSON-only artifacts-data builder

**Files:**
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `extractFilePaths(conversationData)` from Task 1 (in `lib/api.js`, already global).
- Produces: `buildArtifactsDataFromConversationJson(orgId, conversationUuid, conversationData)` → `{artifactFiles: Array<{filename, url}>, contentFiles: Array<{filename, url}>}` — pure function, no navigation, no DOM access. Used by both the single-conversation export branch (Task 3) and the new project-export Phase 1.5 (Task 4).

- [ ] **Step 1: Add the helper function to `sidepanel.js`**

Add this function near the top of `extension/sidepanel.js`, right after the `isProjectsListingUrl` function (which now immediately follows the `let batchInProgress = false;` line after Task 1's Step 2):

```javascript
function buildArtifactsDataFromConversationJson(orgId, conversationUuid, conversationData) {
  const filePaths = extractFilePaths(conversationData);

  const artifactFiles = filePaths.outputs.map((path) => ({
    filename: path.split('/').pop(),
    url: `https://claude.ai/api/organizations/${orgId}/conversations/${conversationUuid}/wiggle/download-file?path=${encodeURIComponent(path)}`
  }));
  const uploadedFiles = filePaths.uploads.map((path) => ({
    filename: path.split('/').pop(),
    url: `https://claude.ai/api/organizations/${orgId}/conversations/${conversationUuid}/wiggle/download-file?path=${encodeURIComponent(path)}`
  }));

  return { artifactFiles, contentFiles: uploadedFiles };
}
```

- [ ] **Step 2: Replace the inline logic in `runExport()`'s single-conversation branch**

In `extension/sidepanel.js`, inside `runExport()`'s `else if (exportMode === 'conversation')` branch, find this block (currently around lines 403-419):

```javascript
      // The conversation JSON itself contains every /mnt/user-data/uploads/
      // and /mnt/user-data/outputs/ file path claude.ai's own UI uses to
      // build its download links (in chat_messages[].files[].path, tool_use
      // bash commands, tool_result output, etc.) — scanning the whole
      // response for these paths is far more reliable than guessing a
      // filename from a DOM card's "humanized" title.
      const filePaths = extractFilePaths(data);
      const artifactFiles = filePaths.outputs.map((path) => ({
        filename: path.split('/').pop(),
        url: `https://claude.ai/api/organizations/${orgId}/conversations/${exportConversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`
      }));
      const uploadedFiles = filePaths.uploads.map((path) => ({
        filename: path.split('/').pop(),
        url: `https://claude.ai/api/organizations/${orgId}/conversations/${exportConversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`
      }));

      let artifactsData = { artifactFiles, contentFiles: [...uploadedFiles] };
```

Replace it with:

```javascript
      // The conversation JSON itself contains every /mnt/user-data/uploads/
      // and /mnt/user-data/outputs/ file path claude.ai's own UI uses to
      // build its download links — see buildArtifactsDataFromConversationJson.
      let artifactsData = buildArtifactsDataFromConversationJson(orgId, exportConversationId, data);
```

- [ ] **Step 3: Verify no syntax errors**

Run: `node -c extension/sidepanel.js`
Expected: exits with no output.

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel.js
git commit -m "refactor: extract buildArtifactsDataFromConversationJson helper"
```

---

### Task 3: `buildProjectZip` accepts per-conversation artifacts data

**Files:**
- Modify: `extension/lib/zipBuilder.js:32-49`

**Interfaces:**
- Consumes: nothing new from other tasks — this task only changes `buildProjectZip`'s own signature and body.
- Produces: `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata, artifactsDataByUuid)` — `artifactsDataByUuid` is a `Map<string, {artifactFiles, contentFiles}>` (or `undefined`/omitted, in which case behavior is identical to today: every conversation gets empty `artefacts/`/`contenu/`). Keyed by `conv.metadata.uuid` (every conversation object already has this shape — see `extension/lib/api.js`'s `fetchAllConversations`, which returns `{metadata: conv, data}` per conversation, where `conv` is the list-endpoint object containing `uuid`).

- [ ] **Step 1: Write the updated `buildProjectZip`**

In `extension/lib/zipBuilder.js`, replace the existing `buildProjectZip` function:

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

with:

```javascript
async function buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata, artifactsDataByUuid) {
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
    const artifactsData = (artifactsDataByUuid && artifactsDataByUuid.get(conv.metadata.uuid)) || { artifactFiles: [], contentFiles: [] };
    await buildConversationFolder(target, folderName, conv, artifactsData);
  }
}
```

Note: `buildConversationFolder` itself is NOT changed — it already accepts and correctly handles an `artifactsData` parameter (verify by reading `extension/lib/zipBuilder.js:19-30` — no code change needed there).

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c extension/lib/zipBuilder.js`
Expected: exits with no output.

- [ ] **Step 3: Verify the existing single-project export call site still works with no behavior change**

`extension/sidepanel.js`'s `runExport()` currently calls (around line 379):
```javascript
await buildProjectZip(projectZip, '', exportProjectId, conversations, projectMetadata);
```

This call omits the new 6th parameter, so `artifactsDataByUuid` is `undefined`, and every conversation falls back to `{artifactFiles: [], contentFiles: []}` — byte-identical to current behavior. This call site will be updated to pass real data in Task 4; this step is just confirming the fallback path itself doesn't break anything before Task 4 lands. No code change in this step — read the call site to confirm.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/zipBuilder.js
git commit -m "feat: buildProjectZip accepts per-conversation artifacts data"
```

---

### Task 4: Wire up Phase 1.5 (JSON extraction) and Phase 2 (image navigation) in `runExport()` and `startBatchExport()`

**Files:**
- Modify: `extension/sidepanel.js` (both `runExport()`'s project branch and `startBatchExport()`)

**Interfaces:**
- Consumes: `buildArtifactsDataFromConversationJson` (Task 2), `buildProjectZip(..., artifactsDataByUuid)` (Task 3), `waitForContentScriptReady` (existing, unchanged), `chrome.tabs.sendMessage(tabId, {type: 'GET_CONVERSATION_ARTIFACTS'})` (existing content script message, unchanged — already image-only per the prior fix).
- Produces: a new shared helper `captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, onProgress)` that mutates `artifactsDataByUuid` in place, appending image content files to each conversation's entry. Used identically by both `runExport()`'s project branch and `startBatchExport()`'s per-project loop.

- [ ] **Step 1: Add the shared Phase 1.5 + Phase 2 helper**

Add this function to `extension/sidepanel.js`, right after `buildArtifactsDataFromConversationJson` (added in Task 2):

```javascript
function buildArtifactsDataByUuid(orgId, conversations) {
  const artifactsDataByUuid = new Map();
  for (const conv of conversations) {
    const uuid = conv.metadata.uuid;
    artifactsDataByUuid.set(uuid, buildArtifactsDataFromConversationJson(orgId, uuid, conv.data));
  }
  return artifactsDataByUuid;
}

async function captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, onProgress) {
  const total = conversations.length;
  for (let i = 0; i < total; i++) {
    const conv = conversations[i];
    const uuid = conv.metadata.uuid;
    if (onProgress) onProgress(i + 1, total, conv.metadata.name);

    try {
      await chrome.tabs.update(tabId, { url: `https://claude.ai/chat/${uuid}` });
      const ready = await waitForContentScriptReady(tabId, 15000, `/chat/${uuid}`);
      if (!ready) continue;

      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CONVERSATION_ARTIFACTS' });
      const imageFiles = (response && response.contentFiles) || [];
      if (imageFiles.length === 0) continue;

      const existing = artifactsDataByUuid.get(uuid) || { artifactFiles: [], contentFiles: [] };
      existing.contentFiles = [...existing.contentFiles, ...imageFiles];
      artifactsDataByUuid.set(uuid, existing);
    } catch (e) {
      // This conversation's images are skipped; its text/artefacts/uploaded
      // files (already in artifactsDataByUuid from Phase 1.5) are kept.
      // Never aborts the project/batch export.
    }
  }
}
```

- [ ] **Step 2: Wire Phase 1.5 + Phase 2 into `runExport()`'s project branch**

In `extension/sidepanel.js`'s `runExport()`, find the project branch's existing code (around lines 347-393):

```javascript
    if (exportMode === 'project') {
      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, exportProjectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      let projectMetadata = { memory: null, instructions: null };
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without memory/instructions.
        contentScriptUnreachable = true;
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      const projectZip = new JSZip();
      await buildProjectZip(projectZip, '', exportProjectId, conversations, projectMetadata);
      blob = await projectZip.generateAsync({ type: 'blob' });
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

      let projectStatusMessage;
      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        projectStatusMessage = `✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`;
      } else {
        projectStatusMessage = `✅ Exported ${conversations.length} conversations.`;
      }
      if (contentScriptUnreachable) {
        projectStatusMessage += ' ⚠️ Could not capture memory/instructions — refresh the project page and try again to include them.';
      }
      setStatus(projectStatusMessage, 'success');
    } else if (exportMode === 'conversation') {
```

Replace it with (changes: capture `tab.id` once for reuse, insert Phase 1.5 + Phase 2 between the conversation fetch and the zip build, navigate back to the project page before generating the zip):

```javascript
    if (exportMode === 'project') {
      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, exportProjectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab.id;

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

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);
      await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
        setStatus(`Capturing images ${current}/${total}: ${name}...`, '');
      });

      try {
        await chrome.tabs.update(tabId, { url: `https://claude.ai/project/${exportProjectId}` });
      } catch (e) {
        // Best-effort return navigation — the export itself has already succeeded.
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      const projectZip = new JSZip();
      await buildProjectZip(projectZip, '', exportProjectId, conversations, projectMetadata, artifactsDataByUuid);
      blob = await projectZip.generateAsync({ type: 'blob' });
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

      let projectStatusMessage;
      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        projectStatusMessage = `✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`;
      } else {
        projectStatusMessage = `✅ Exported ${conversations.length} conversations.`;
      }
      if (contentScriptUnreachable) {
        projectStatusMessage += ' ⚠️ Could not capture memory/instructions — refresh the project page and try again to include them.';
      }
      setStatus(projectStatusMessage, 'success');
    } else if (exportMode === 'conversation') {
```

- [ ] **Step 3: Wire Phase 1.5 + Phase 2 into `startBatchExport()`'s per-project loop**

In `extension/sidepanel.js`'s `startBatchExport()`, find the per-project loop body (around lines 250-282):

```javascript
      try {
        await chrome.tabs.update(tabId, { url: `https://claude.ai/project/${project.uuid}` });

        const ready = await waitForContentScriptReady(tabId, 15000, `/project/${project.uuid}`);
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
```

Replace it with (changes: insert Phase 1.5 + Phase 2 between the conversation fetch and `buildProjectZip`, using the same `tabId` the batch loop already holds — no extra navigation needed to "return" between a project's own Phase 2 and the next project's Phase 1, since the next iteration's `chrome.tabs.update` to the next project's URL overwrites it anyway):

```javascript
      try {
        await chrome.tabs.update(tabId, { url: `https://claude.ai/project/${project.uuid}` });

        const ready = await waitForContentScriptReady(tabId, 15000, `/project/${project.uuid}`);
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

        const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);
        await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
          setStatus(`Capturing images ${current}/${total} in ${project.name}: ${name}...`, '');
        });

        const folderName = `${sanitizeFilename(project.name)}_${project.uuid.substring(0, 8)}`;
        await buildProjectZip(zip, folderName, project.uuid, conversations, projectMetadata, artifactsDataByUuid);

        succeeded.push(project.name);
      } catch (error) {
        failed.push({ name: project.name, reason: error.message });
      }
```

Note: no explicit "return to project page" navigation is added at the end of each batch iteration — per the design spec, the next project's own `chrome.tabs.update` (top of the next loop iteration) or, for the last project, the batch's own existing end-of-loop behavior (no navigation back — batches don't currently return to any particular page) already handles this; only single-project export (Step 2) needs the explicit return-to-project-page navigation, matching its own existing "you end up back where you started" expectation for non-batch export.

- [ ] **Step 4: Verify no syntax errors**

Run: `node -c extension/sidepanel.js`
Expected: exits with no output.

- [ ] **Step 5: Manual verification checklist (no automated tests in this project)**

Document in the task report that the following must be manually verified against a live claude.ai session (cannot be verified in this sandboxed environment):
1. Single-project export on a project with 2-3 conversations, at least one with a Claude-generated artifact, one with an uploaded image, one with an uploaded non-image file — confirm all three end up in the right conversation's `artefacts/`/`contenu/`, and the tab visibly navigates through each conversation before returning to the project page.
2. A project with a conversation that has no artifacts/attachments — confirm its folders stay empty (`.gitkeep`) without errors.
3. Multi-project batch export with 2 selected projects — confirm every conversation across both projects gets its images, and status messages show correct progress.
4. A conversation whose page fails to load in time during Phase 2 — confirm the export still completes with that conversation's text/artefacts/non-image files present, only images missing.

- [ ] **Step 6: Commit**

```bash
git add extension/sidepanel.js
git commit -m "feat: capture per-conversation artifacts/content in project export"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing — pure documentation update reflecting Tasks 1-4's behavior change.
- Produces: nothing — no code.

- [ ] **Step 1: Update `CLAUDE.md`'s Output Structure section**

In `CLAUDE.md`, find this line (in the `### Output Structure` section):

```markdown
- Project export: `index.md` at the root, plus `memory.md`/`instructions.md` (only if found — see Project Metadata Scraping below), plus an empty `fichiers/` placeholder, plus one folder per conversation (`<title>_<uuid8>/`), each containing `conversation.md`, `artefacts/` (empty), `contenu/` (empty) — per-conversation artifact/content capture (below) is scoped to single-conversation export only, not project export.
```

Replace with:

```markdown
- Project export: `index.md` at the root, plus `memory.md`/`instructions.md` (only if found — see Project Metadata Scraping below), plus an empty `fichiers/` placeholder, plus one folder per conversation (`<title>_<uuid8>/`), each containing `conversation.md`, `artefacts/` (populated the same way as single-conversation export), `contenu/` (populated the same way as single-conversation export, including image attachments — see Conversation Artifact & Content Capture below for how project export captures these for every conversation).
```

Find and update the paragraph right after it:

```markdown
`fichiers/` (project knowledge files) remains a placeholder in the current version — populating it with real content is a planned future phase, not yet implemented. Project-mode `artefacts/`/`contenu/` are likewise still empty placeholders; only single-conversation exports populate them (see Conversation Artifact & Content Capture below).
```

Replace with:

```markdown
`fichiers/` (project knowledge files) remains a placeholder in the current version — populating it with real content is a planned future phase, not yet implemented.
```

- [ ] **Step 2: Add a subsection to `CLAUDE.md`'s Conversation Artifact & Content Capture section**

At the end of the existing `### Conversation Artifact & Content Capture` section in `CLAUDE.md` (after the paragraph ending in "...only if every fetch in it failed."), add:

```markdown
**Project export** (single-project and multi-project batch alike) now captures the same data for every conversation in the project, in two phases: a JSON-only phase (`buildArtifactsDataFromConversationJson`, shared with single-conversation export) that runs immediately after the existing batched `fetchAllConversations` call — no navigation needed, since artifact/uploaded-file paths come from each conversation's own JSON — followed by a sequential per-conversation navigation phase (`captureProjectConversationImages`) that visits each conversation's page in the active tab (status: `"Capturing images N/Total: <name>..."`) purely to scrape image content files' `/preview` URLs, the one piece of data that requires the DOM. A conversation whose navigation fails keeps its JSON-derived data; only its images are skipped. `buildProjectZip` takes an optional `artifactsDataByUuid` map (keyed by each conversation's `metadata.uuid`) to thread this per-conversation data through — omitting it (as no call site now does) falls back to the original always-empty behavior.
```

- [ ] **Step 3: Update `README.md`'s Output Structure examples**

In `README.md`, find the **Project export** and **Multi-project batch export** code block examples showing `artefacts/`/`contenu/` as bare empty lines under each conversation folder — no code change needed to the tree structure itself (it already just shows `artefacts/` and `contenu/` as folder names without annotation), but update the prose paragraph below them:

Find:
```markdown
For **project exports**, `artefacts/` and `contenu/` are still created empty for every conversation — this per-conversation capture mechanism is scoped to single-conversation export only for now (a future update may extend it to project exports). `fichiers/` is likewise an empty placeholder, reserved for a future update that will download the project's uploaded knowledge files. `memory.md`/`instructions.md` are only added when the project page has that section populated — they're scraped from the currently open project tab's page content, so the project's tab must be open in the browser when you export.
```

Replace with:
```markdown
For **project exports** (including multi-project batch export), `artefacts/` and `contenu/` are populated for every conversation the same way as a single-conversation export — this does mean project export now takes noticeably longer, since the extension briefly visits each conversation's page to capture its image attachments. `fichiers/` is still an empty placeholder, reserved for a future update that will download the project's uploaded knowledge files. `memory.md`/`instructions.md` are only added when the project page has that section populated — they're scraped from the currently open project tab's page content, so the project's tab must be open in the browser when you export.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document per-conversation artifacts/content in project export"
```
