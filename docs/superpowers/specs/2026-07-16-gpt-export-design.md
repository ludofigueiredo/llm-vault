# GPT Export — Design Spec

**Date:** 2026-07-16
**Status:** Approved for planning
**Scope:** Add a ChatGPT (chatgpt.com) export feature to the existing "LLM Vault" Chrome extension, fully isolated from the existing Claude export logic.

## 1. Goal

Let the user export ChatGPT project data through the same side-panel extension that already exports Claude projects. For the first iteration the target is: **instructions + full conversations per project**, output as a `.zip` with the same folder-tree philosophy as the Claude export.

The user can:
- Select multiple GPT projects from the projects listing page and batch-export them.
- Export a single GPT project directly from a project page.

Detection is automatic by host: when the active tab is on `chatgpt.com`, the panel shows the GPT UI; when on `claude.ai`, the existing Claude behavior is unchanged.

## 2. Guiding principle: Claude and GPT are isolated

Claude and GPT share almost nothing:
- **Claude** = internal REST API + session cookies; project list rows carry real `href`s.
- **GPT** = pure DOM scraping, different host, React routing with **no hrefs** on the projects-listing rows.

Therefore GPT gets its own files (prefix `gpt`), and the existing Claude code is **not** modified in its logic — only minimally wired for routing/manifest.

### New files

| File | Role |
|---|---|
| `extension/lib/gptDetect.js` | Detect GPT context from URL + extract IDs. Mirror of `orgId.js`. |
| `extension/content-gpt.js` | Content script on `chatgpt.com/*`: multi-project selection (row click), scrape instructions (settings popover), scrape conversation list (hrefs), scrape a thread's messages (auto-scroll + `data-message-author-role`), scrape images/files. Fully distinct from `content.js`. |
| `extension/lib/gptMarkdown.js` | GPT messages → markdown, `instructions.md`, `index.md`. Mirror of `markdown.js`. Includes a small self-contained HTML→markdown converter for assistant content (no external dependency). |
| `extension/lib/gptExport.js` | Orchestrates the GPT pipeline (navigation, scrape, build zip), called by the side panel. |

### Modified files (minimal wiring only)

- `manifest.json`: add `https://chatgpt.com/*` host permission + a new `content_scripts` block for `content-gpt.js`.
- `sidepanel.js`: `detectContext()` inspects the active tab's `hostname` first. `chatgpt.com` → delegate to `detectGptContext()` (GPT UI). `claude.ai` → existing behavior unchanged.
- `sidepanel.html`: reuse the same buttons/status area (GPT UI is near-identical: "Select projects" → "Confirm (N)" → progress bar); load the new GPT scripts.

### Reused as-is (no duplication)

`jszip.min.js`, `zipBuilder.js` (`fetchFilesInto()`, folder-tree building — provider-agnostic), and the overall zip/folder output philosophy.

## 3. Context detection & URL structures

`gptDetect.js` detects 3 contexts from the active tab URL:

| Context | URL pattern | Extracted ID |
|---|---|---|
| **Projects listing** | `chatgpt.com/projects` | — (triggers multi-project selection) |
| **Project** | `chatgpt.com/g/g-p-<projectId>/project` | `projectId` = `g-p-<hex>` |
| **Conversation** | `chatgpt.com/g/g-p-<projectId>-<slug>/c/<convId>` | `projectId` + `convId` |

**Parsing regexes:**
- Project: `/\/g\/(g-p-[a-f0-9]+)(?:-[^/]*)?\/project/` — capture `g-p-<hex>`, ignore optional slug.
- Conversation: `/\/g\/(g-p-[a-f0-9]+)-[^/]*\/c\/([a-f0-9-]+)/` — capture project + convId.

**Confirmed from snippets:**
- **Projects listing** rows (`role="row"` inside `role="grid" aria-label="Projets"`) have **no href / no UUID** in the DOM. → selection is by **row click** (capture-phase, like the Claude multi-project selection); navigation to a selected project is done by **actually clicking the row** and then reading `window.location` after React routing updates the URL. This is the only way to obtain a project's URL.
- **Project page** conversations **do** have a real href (`<a class="block min-w-0 grow" href="/g/g-p-<id>-<slug>/c/<convId>">`). → the conversation list is scraped directly from hrefs (title = `.text-sm.font-medium`, `convId` from href). No need to click each conversation to discover its URL.

**Side-panel detection:** `detectContext()` checks `hostname`. `chatgpt.com` → `detectGptContext()`. `claude.ai` → unchanged. Shared state vars (`selectionMode`, `batchInProgress`, …) are reused since only one export runs at a time, but the *pipelines* are distinct.

## 4. Project scraping flow

`gptExport.js` orchestrates these phases in the active tab, per project:

### Phase 1 — Project instructions (`GET_GPT_PROJECT_METADATA`)
Content script clicks *"Afficher les détails du projet"* (`aria-label="Afficher les détails du projet"`), waits for the `role="dialog"` "Paramètres du projet" popover, reads:
- **Name**: `input#project-name` (`value` attribute)
- **Instructions**: `textarea#instructions` (content)

Then closes the popover (`data-testid="close-button"`). Graceful degradation: if the button/popover is missing (UI change), return `{name: <h1 title>, instructions: ''}` without failing the export.

### Phase 2 — Conversation list (`GET_GPT_PROJECT_CONVERSATIONS`)
"Chats" tab active by default. Scrape each `<a href="/g/.../c/<convId>">`: title (`.text-sm.font-medium`) + `convId` from href. Auto-scroll the list (same `waitForRowCountToStabilize` pattern as Claude's Select-All recents) if it's long/lazy-loaded.

### Phase 3 — Scrape each conversation (sequential navigation)
For each `convId`: `chrome.tabs.update` to the conversation URL → wait for content script → `GET_GPT_CONVERSATION`. The content script:
1. **Full auto-scroll** of the thread (top→bottom, until the count of `section[data-turn-id]` stabilizes) to de-virtualize all turns.
2. **Extract each turn**: `data-message-author-role` (`user`/`assistant`); text from `.markdown` (assistant, rendered HTML) or the user bubble (`.whitespace-pre-wrap`).
3. **Images**: `<img src="...backend-api/estuary/content...">` → `{filename: alt, url}`.
4. **Uploaded files (best-effort)**: detect non-image file cards; if a usable download URL is found, capture it, otherwise list the name only in markdown. To be refined once real snippets of a non-image attachment are provided.

Status shown: `"Projet X — conversation N/Total : <titre>..."`.

### Assistant HTML→Markdown
Assistant content is rendered HTML (`.markdown.prose`). Converted with a **small self-contained HTML→markdown converter** inside `gptMarkdown.js` (no external dependency, consistent with the "vanilla JS, no CDN" project philosophy), covering the tags actually seen in GPT threads: `p`, `strong`/`b`, `em`/`i`, `h1`–`h6`, `hr`, `ul`/`ol`/`li`, `code`, `pre`, `blockquote`, `a`, `br`. It walks the DOM of the HTML string (parsed via `DOMParser` in the panel) and emits markdown. User messages are plain text (`whitespace-pre-wrap`), used as-is.

## 5. Output structure (mirrors Claude, adapted for GPT)

Single project → `gpt_project_<name>.zip`:
```
index.md                      (conversation list + link to each folder)
instructions.md               (name + instructions; omitted if empty)
<conv-title>_<convId8>/
    conversation.md           (user/assistant thread in markdown)
    contenu-gpt/              (images + uploaded files; .gitkeep if empty)
<conv-title2>_<convId8>/
    ...
```

Multi-project batch → `gpt_projects_batch_<count>.zip`, one folder per project at the root:
```
<project-name>/
    index.md
    instructions.md
    <conv>_<id8>/conversation.md + contenu-gpt/
<project-name2>/
    ...
```

**Differences vs Claude output (intentional):**
- Attachments folder is named **`contenu-gpt/`** (GPT-specific, per user preference), holding both images and uploaded files.
- **No `artefacts/`** — GPT has no separate "artifacts" concept; everything non-text goes in `contenu-gpt/`.
- **No `memory.md` / `fichiers/`** — Claude-only concepts.

## 6. Error handling (mirrors Claude)

- A project that fails (navigation timeout, empty list, scrape failure) is recorded and **skipped** — the batch continues. No zip is generated if *every* project fails.
- A conversation that fails within a project → skipped; the project export continues with the rest.
- Images/files: individual fetch failure ignored; a `contenu-gpt/` folder falls back to `.gitkeep` if every fetch failed.
- Instructions missing → export without `instructions.md`, no failure.
- `batchInProgress` flag + disabled `#export-btn` during export prevent the extension's own navigations from triggering a stray re-detection (same guard as Claude).

## 7. Rate limiting

Sequential navigation (one conversation at a time) with a small delay between conversations, like Claude's `captureProjectConversationImages`. No parallel batching — DOM scraping requires the active tab and is single-threaded by nature.

## 8. Out of scope (future iterations)

- Non-image uploaded files: download URL not yet confirmed from snippets; best-effort now, refined later with real snippets.
- Exporting a single standalone GPT conversation outside a project (not requested for this iteration; the conversation-context detection is prepared but the single-conversation export UI/pipeline can be added next).
- Non-project GPT chats (the general recents/history).
- ChatGPT-generated non-text artifacts beyond images.
