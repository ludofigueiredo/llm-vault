# Claude Conversations Exporter — Chrome Extension Redesign

**Date:** 2026-07-07
**Status:** Approved

## Context

The repo currently exports Claude Project conversations via three console-based methods: a bookmarklet (deprecated, no longer works due to CSP), a paste-into-console script, and a Tampermonkey userscript. None of these give a native browser experience, and CSP restrictions on claude.ai make the bookmarklet dead going forward.

This redesign replaces all three methods with a single Chrome extension (Manifest V3), installed in developer mode (unpacked). The extension becomes the only supported export method.

## Goals

1. Export an entire Claude Project (all conversations) as a structured `.zip`.
2. Export a single Claude conversation (outside a project) as a structured `.zip`.
3. Produce a folder structure (not flat files) inside the zip.
4. Clean up docs/files no longer relevant (GitHub Pages artifacts, deprecated scripts).

## Non-goals (explicitly out of scope for this phase)

- Extracting real Claude-generated artifacts (code/documents) into `artefacts/`.
- Downloading raw uploaded file attachments into `contenu/`.
  (Both folders are created but left empty in this phase — see Phase 2 below.)
- Publishing to the Chrome Web Store.
- Firefox/Edge/Safari support (Chrome only, MV3).

## Repo cleanup

Remove:
- `index.html` — was the GitHub Pages install guide; no longer needed once the README documents the extension directly.
- `.nojekyll` — only existed to support GitHub Pages.
- `claude_project_bookmarklet.js` — already deprecated/non-functional, no reason to keep as reference.
- `claude_project_export_script.js` — superseded by the extension.
- `claude_project_exporter.user.js` — superseded by the extension.

`README.md` and `CLAUDE.md` will be rewritten to describe the extension as the sole method (separate follow-up task after implementation, not part of this spec).

## Architecture

Plain vanilla JS Chrome extension, Manifest V3, no build step (matches the project's existing "no framework, no build" philosophy).

```
extension/
  manifest.json
  popup.html
  popup.js
  lib/
    api.js         # fetch project/conversation data from claude.ai API
    markdown.js     # JSON -> Markdown conversion (ported from existing script)
    zipBuilder.js    # builds the folder tree and hands it to JSZip
    jszip.min.js      # vendored library, no CDN (MV3 CSP disallows remote code)
  icons/
    icon16.png, icon48.png, icon128.png
```

No background service worker is needed — all logic runs in the popup when the user clicks export, reading the active tab's URL directly via `chrome.tabs.query`.

### Permissions (manifest.json)

- `"host_permissions": ["https://claude.ai/*"]` — for `fetch(..., {credentials: 'include'})` calls to claude.ai's API from the popup.
- `"permissions": ["downloads", "activeTab", "cookies"]` — `cookies` to read `lastActiveOrg` (org ID extraction, same approach as today); `downloads` to save the generated zip; `activeTab` to read the current URL.

### Flow

1. User opens a `claude.ai/project/[uuid]` or `claude.ai/chat/[uuid]` page.
2. User clicks the extension icon. `popup.js` reads the active tab URL and detects which case applies.
3. Popup shows a context-appropriate button: "Export Project" or "Export Conversation". If neither URL pattern matches, popup shows a message asking the user to navigate to a project or conversation page.
4. On click: `api.js` extracts project ID (from URL) and org ID (from `lastActiveOrg` cookie, same fallback chain as the current script), then fetches:
   - Project mode: the conversations list, then each conversation individually (same batched/rate-limited approach as today).
   - Conversation mode: the single conversation.
5. `zipBuilder.js` builds the in-memory folder structure (detailed below) and feeds it to vendored JSZip.
6. The resulting blob is turned into an object URL and downloaded via `chrome.downloads.download()` as a single `.zip` file.
7. Popup shows progress (batch X of Y) and a final success/error notification, mirroring today's console log / notification behavior but rendered in the popup UI.

### Output structure

**Project export** (`project-<name>-<uuid8>.zip`):
```
index.md                                   # project-level summary: title, export date, conversation count, list with links
conversation-title-<uuid8>/
  conversation.md                          # the full conversation content (same content as today's per-file markdown)
  artefacts/                               # empty in this phase
  contenu/                                 # empty in this phase
another-conversation-<uuid8>/
  conversation.md
  artefacts/
  contenu/
...
```

**Single conversation export** (`conversation-title-<uuid8>.zip`):
```
conversation-title-<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

Both `artefacts/` and `contenu/` are created via a placeholder (e.g. `.gitkeep`-equivalent isn't meaningful in a zip, so they're simply not created as empty dirs by JSZip unless a placeholder file is added — decision: add a `.gitkeep`-style empty text file so the folder is visible after unzip) so the structure is visible even though there's no content yet.

### Content ported as-is from the current script

- Project ID extraction from URL.
- Organization ID extraction (cookie-first, with existing fallback chain).
- Conversations list + individual conversation fetch, with existing batching (5 at a time) and rate-limit backoff.
- Markdown conversion logic (`convertToMarkdown`): messages, thinking blocks, tool use/result, attachment text extraction.
- Filename sanitization and UUID-suffixing for uniqueness.

### Error handling

Same categories as today, surfaced in the popup instead of `console.log`/browser notifications:
- Not on a project/conversation page → instructive message, no button shown.
- Auth failure (401/403) → "Please make sure you're logged into claude.ai".
- Rate limiting (429) → automatic backoff/retry (ported logic), progress indicator keeps user informed.
- Partial failure → completed export includes successfully-fetched conversations, with a warning listing which ones failed.

## Testing approach

Manual testing in Chrome (developer mode, unpacked extension), covering:
1. Empty project (0 conversations).
2. Small project (1-20 conversations).
3. Larger project (50+ conversations) — verify batching/rate-limit path still works.
4. Single conversation export outside a project.
5. Not-logged-in / auth failure state.
6. Popup shown on an unrelated claude.ai page (e.g. homepage) — should show the "navigate to a project/conversation" message.

No automated test suite — consistent with the project's existing approach (no build/test tooling, manual verification against real claude.ai).

## Phase 2 (future, not part of this implementation)

- Inspect real API responses to identify how Claude-generated artifacts and uploaded file attachments are represented, then populate `artefacts/` and `contenu/` with actual downloaded content.
