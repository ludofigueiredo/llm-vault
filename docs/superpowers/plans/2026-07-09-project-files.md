# Project Knowledge Files (fichiers/) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `fichiers/` in every project export (single-project and multi-project batch) with the project's image knowledge files, scraped from the project page's "Fichiers" section — the last unimplemented placeholder in the export structure.

**Architecture:** Extend `extension/content.js`'s existing `getProjectMetadata()` (already called once per project export via the `GET_PROJECT_METADATA` message) to also scrape the "Fichiers" section's image thumbnails, using the same `<img alt src>` scraping shape already proven for conversation content files. `extension/lib/zipBuilder.js`'s `buildProjectZip` fetches this data into `fichiers/` via the existing shared `fetchFilesInto()` helper. No new message type, no navigation, no `sidepanel.js` changes required.

**Tech Stack:** Vanilla JavaScript, Chrome Extension Manifest V3, no build step (see project CLAUDE.md).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no ES modules, no dynamic `import()` (all files loaded via `<script>` tags in `sidepanel.html`).
- Every new/changed function must degrade gracefully: a missing "Fichiers" section, a failed individual file fetch, or the content script being unreachable must never fail the overall export — `fichiers/` simply stays (partially) empty with its `.gitkeep` placeholder, consistent with every other capture mechanism in this codebase.
- Only image files in the project's "Fichiers" section are in scope — non-image files (`.docx`, `.pdf`, etc.) are explicitly out of scope for this plan (their download URL/mechanism is unconfirmed) and must be silently skipped, not treated as errors.
- No new `chrome.runtime` message type — reuse the existing `GET_PROJECT_METADATA` message/response shape, adding a `files` field alongside `memory`/`instructions`.

---

### Task 1: Scrape the project's "Fichiers" section in `content.js`

**Files:**
- Modify: `extension/content.js`

**Interfaces:**
- Consumes: nothing new — reuses `window.location.origin` and the DOM, same as the existing `scrapeImageContentFiles()`.
- Produces: `scrapeProjectFiles()` → `Array<{filename: string, url: string}>`. `getProjectMetadata()`'s return shape gains a `files` field: `{memory: string|null, instructions: string|null, files: Array<{filename, url}>}`.

- [ ] **Step 1: Add `findProjectFichiersSection()`**

In `extension/content.js`, add this function right after `findContenuSection` (which ends around line 63):

```javascript
function findProjectFichiersSection() {
  const headings = document.querySelectorAll('h3');
  for (const heading of headings) {
    if (heading.textContent.trim() !== 'Fichiers') continue;
    const container = heading.closest('.flex.flex-col.gap-2');
    if (container) return container;
  }
  return null;
}
```

This mirrors `findContenuSection()`'s exact pattern (exact-text `<h3>` match, `.closest()` up to the section's flex container) — the project page's "Fichiers" section wraps its heading in a `<div class="w-full px-[1.375rem] py-4 flex flex-col gap-2 mb-1">` (confirmed via a live DOM capture), so `.closest('.flex.flex-col.gap-2')` is the equivalent anchor to `findContenuSection`'s `.closest('.flex.flex-col.gap-3')` for a conversation's "Contenu" section. Note the different heading text ("Fichiers", not "Contenu") and different container class (`gap-2`, not `gap-3`) — these are two distinct sections on two distinct page types (project page vs. conversation page) that happen to share the same internal thumbnail-grid shape.

- [ ] **Step 2: Add `scrapeProjectFiles()`**

Add this function right after `findProjectFichiersSection()`:

```javascript
function scrapeProjectFiles() {
  const section = findProjectFichiersSection();
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
```

This is byte-for-byte the same body as the existing `scrapeImageContentFiles()` (lines 65-79) — only the section-finder it calls differs (`findProjectFichiersSection()` instead of `findContenuSection()`). Non-image entries in the "Fichiers" section (e.g. a `.docx` thumbnail, which per the live DOM capture renders as a `<div data-testid="{filename}"><button>...</button></div>` with no `<img>` inside, same shape as a conversation's non-image content thumbnails) are naturally skipped by the `img[src]` selector — no explicit filtering needed.

- [ ] **Step 3: Wire `files` into `getProjectMetadata()`**

In `extension/content.js`, find:

```javascript
function getProjectMetadata() {
  return {
    memory: extractSectionText('Mémoire'),
    instructions: extractSectionText('Instructions')
  };
}
```

Replace with:

```javascript
function getProjectMetadata() {
  return {
    memory: extractSectionText('Mémoire'),
    instructions: extractSectionText('Instructions'),
    files: scrapeProjectFiles()
  };
}
```

- [ ] **Step 4: Verify no syntax errors**

Run: `node -c extension/content.js`
Expected: exits with no output.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js
git commit -m "feat: scrape project knowledge files' image thumbnails for fichiers/"
```

---

### Task 2: Populate `fichiers/` in `buildProjectZip`

**Files:**
- Modify: `extension/lib/zipBuilder.js`

**Interfaces:**
- Consumes: `projectMetadata.files` (Task 1's new field, `Array<{filename, url}>` — may be `undefined` if the content script was unreachable, or `[]` if the section was empty/absent).
- Consumes: `fetchFilesInto(folder, files)` — already defined in this file (lines 1-17), unchanged.
- Produces: no new exports — `buildProjectZip`'s behavior changes (fichiers/ populated instead of always-`.gitkeep`), its signature does not.

- [ ] **Step 1: Replace the `fichiers/` placeholder line**

In `extension/lib/zipBuilder.js`, inside `buildProjectZip`, find:

```javascript
  target.folder('fichiers').file('.gitkeep', '');
```

Replace with:

```javascript
  const fichiersFolder = target.folder('fichiers');
  const projectFiles = (projectMetadata && projectMetadata.files) || [];
  await fetchFilesInto(fichiersFolder, projectFiles);
```

`fetchFilesInto` already handles the empty-array case (falls back to `.gitkeep`) and individual fetch failures (skips them, continues) — no other changes needed in this file. The full `buildProjectZip` function after this change reads:

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
  const fichiersFolder = target.folder('fichiers');
  const projectFiles = (projectMetadata && projectMetadata.files) || [];
  await fetchFilesInto(fichiersFolder, projectFiles);

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    const artifactsData = (artifactsDataByUuid && artifactsDataByUuid.get(conv.metadata.uuid)) || { artifactFiles: [], contentFiles: [] };
    await buildConversationFolder(target, folderName, conv, artifactsData);
  }
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c extension/lib/zipBuilder.js`
Expected: exits with no output.

- [ ] **Step 3: Verify no other call site needs changes**

`sidepanel.js`'s two call sites (`runExport()`'s project branch, `startBatchExport()`'s per-project loop) both already pass their fetched `projectMetadata` object straight into `buildProjectZip` unmodified — since `files` is just a new field Task 1 added to that same object, no `sidepanel.js` changes are needed. Read both call sites to confirm this (no code change in this step):
- `extension/sidepanel.js`'s `runExport()`, the line calling `buildProjectZip(projectZip, '', projectId, conversations, projectMetadata, artifactsDataByUuid)`.
- `extension/sidepanel.js`'s `startBatchExport()`, the line calling `buildProjectZip(zip, folderName, project.uuid, conversations, projectMetadata, artifactsDataByUuid)`.

- [ ] **Step 4: Commit**

```bash
git add extension/lib/zipBuilder.js
git commit -m "feat: populate fichiers/ with project knowledge files in buildProjectZip"
```

---

### Task 3: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing — pure documentation update reflecting Tasks 1-2's behavior change.
- Produces: nothing — no code.

- [ ] **Step 1: Update `CLAUDE.md`'s Output Structure section**

In `CLAUDE.md`, find this sentence (in the `### Output Structure` section):

```markdown
`fichiers/` (project knowledge files) remains a placeholder in the current version — populating it with real content is a planned future phase, not yet implemented.
```

Replace with:

```markdown
`fichiers/` (project knowledge files) is populated with the project's image knowledge files — see Project Knowledge Files Capture below. Non-image knowledge files (e.g. `.docx`, `.pdf`) are not yet covered.
```

- [ ] **Step 2: Add a new subsection to `CLAUDE.md`**

Immediately after the existing `### Project Metadata Scraping (Memory & Instructions)` section (right before `### Conversation Artifact & Content Capture` begins), insert:

```markdown
### Project Knowledge Files Capture
The project's "Fichiers" section (project-level knowledge files, distinct from a conversation's own attachments) lives directly on the project page, structured identically to a conversation's "Contenu" section: a `<h3>Fichiers</h3>` heading followed by a thumbnail grid. `getProjectMetadata()` in `extension/content.js` scrapes this section's `<img alt src>` thumbnails the same way `scrapeImageContentFiles()` already does for conversation content files, returning `{filename, url}` pairs as a `files` field alongside `memory`/`instructions` — reusing the existing `GET_PROJECT_METADATA` message rather than adding a new one, since it's already sent once per project export and already degrades gracefully if the content script is unreachable. Only image files are captured this way; non-image files in this section (e.g. `.docx`) render with no `<img>` and are silently skipped — their download mechanism is unconfirmed and not yet implemented. `extension/lib/zipBuilder.js`'s `buildProjectZip` fetches every scraped file into `fichiers/` via the same `fetchFilesInto()` helper already shared by `artefacts/`/`contenu/`, falling back to an empty `.gitkeep` placeholder if the section was empty/absent or every fetch failed.
```

- [ ] **Step 3: Update `README.md`**

In `README.md`, find this sentence (in the Output structure section, describing project exports):

```markdown
`fichiers/` is still an empty placeholder, reserved for a future update that will download the project's uploaded knowledge files.
```

Replace with:

```markdown
`fichiers/` contains the project's image knowledge files (non-image knowledge files aren't captured yet).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document fichiers/ population from project knowledge files"
```
