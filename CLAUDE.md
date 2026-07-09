# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Claude Conversations Exporter** - a Chrome extension (Manifest V3) that exports Claude Project conversations or single conversations as structured `.zip` files containing Markdown.

## Architecture

- `extension/manifest.json` - Manifest V3 config (permissions: `downloads`, `activeTab`, `cookies`, `sidePanel`, `tabs`; host permission: `https://claude.ai/*`).
- `extension/background.js` - Minimal service worker; its only job is calling `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})` so clicking the toolbar icon opens the side panel.
- `extension/sidepanel.html` / `extension/sidepanel.js` - Side panel UI (persistent, docked to the browser window — replaces the old popup): detects context (project vs conversation vs neither) from the active tab's URL, re-detects on tab switch/navigation (`chrome.tabs.onActivated`/`onUpdated`, since the panel doesn't reload like a popup did), orchestrates the export pipeline, shows progress/status.
- `extension/lib/orgId.js` - Project/conversation ID extraction from URLs; organization ID lookup via `chrome.cookies.get` on the `lastActiveOrg` cookie.
- `extension/lib/api.js` - Fetches the conversations list and individual conversations from claude.ai's internal API, with batching (5 at a time) and exponential-backoff retry on rate limiting (429).
- `extension/lib/markdown.js` - Converts conversation JSON to Markdown; builds the project index; sanitizes filenames.
- `extension/lib/zipBuilder.js` - Builds the in-memory folder tree and generates the zip Blob via vendored JSZip.
- `extension/lib/jszip.min.js` - Vendored JSZip (no CDN — Manifest V3 CSP disallows remote code).
- `extension/content.js` - Content script injected on `claude.ai/project/*` and `claude.ai/chat/*`; scrapes the project's Memory/Instructions text (project pages) and scrapes artifact/content filenames (chat pages) from the DOM on request (no REST API exposes this data). Also injected on `claude.ai/projects` (exact path, no wildcard) to power multi-project selection — see Multi-Project Batch Export below.

## Key Technical Details

### ID Extraction
- Project ID: parsed from the active tab's URL, pattern `/project/[uuid]`.
- Conversation ID: parsed from the active tab's URL, pattern `/chat/[uuid]`.
- Organization ID: read from the `lastActiveOrg` cookie via `chrome.cookies.get({url: 'https://claude.ai', name: 'lastActiveOrg'})`. Unlike the old console-script approach, the side panel has no access to the page's `localStorage`/`sessionStorage`/JS globals, so there is no fallback chain beyond the cookie — if it's missing, export fails with an explicit error asking the user to confirm they're logged in.

### API Flow
1. **Conversations List** (project mode only): `GET /api/organizations/[org]/projects/[project]/conversations_v2`
2. **Individual Conversations**: `GET /api/organizations/[org]/chat_conversations/[conv]?tree=True&rendering_mode=messages&render_all_tools=true`
3. All fetches use `credentials: 'include'` to leverage the existing claude.ai browser session.

### Output Structure
Every export is a single `.zip` download (built with vendored JSZip, never written to disk as loose files):
- Project export: `index.md` at the root, plus `memory.md`/`instructions.md` (only if found — see Project Metadata Scraping below), plus `fichiers/` (populated with the project's image knowledge files — see Project Knowledge Files Capture below), plus one folder per conversation (`<title>_<uuid8>/`), each containing `conversation.md`, `artefacts/` (populated the same way as single-conversation export), `contenu/` (populated the same way as single-conversation export, including image attachments — see Conversation Artifact & Content Capture below for how project export captures these for every conversation).
- Single conversation export: one folder with `conversation.md`, `artefacts/` (populated with unzipped Claude-generated artifacts if any were captured, otherwise empty), `contenu/` (populated with fetched image attachments if any were found, otherwise empty). No index, no memory/instructions/fichiers (project-only concepts).

`fichiers/` (project knowledge files) is populated with the project's image knowledge files — see Project Knowledge Files Capture below. Non-image knowledge files (e.g. `.docx`, `.pdf`) are not yet covered.

### Project Metadata Scraping (Memory & Instructions)
Claude's Memory and Instructions text for a project is not exposed by any REST API the extension uses — it only exists rendered in the project page's DOM. `extension/content.js` is injected on `claude.ai/project/*` pages and, on request (`chrome.runtime.onMessage` with `{type: 'GET_PROJECT_METADATA'}`), scans for `<h3>` elements matching the exact label text `"Mémoire"`/`"Instructions"` (French UI only — no i18n support), then walks up to 5 ancestor levels looking for a sibling `<p>` with the section's text. During a project export, `sidepanel.js` messages the active tab's content script and passes the result into `buildProjectZip`; if the content script isn't present/responsive (page not loaded, wrong page, or a UI change broke the selectors), the export proceeds without `memory.md`/`instructions.md` rather than failing — this is enrichment, not a required part of a successful export.

### Project Knowledge Files Capture
The project's "Fichiers" section (project-level knowledge files, distinct from a conversation's own attachments) lives directly on the project page, structured identically to a conversation's "Contenu" section: a `<h3>Fichiers</h3>` heading followed by a thumbnail grid. `getProjectMetadata()` in `extension/content.js` scrapes this section's `<img alt src>` thumbnails the same way `scrapeImageContentFiles()` already does for conversation content files, returning `{filename, url}` pairs as a `files` field alongside `memory`/`instructions` — reusing the existing `GET_PROJECT_METADATA` message rather than adding a new one, since it's already sent once per project export and already degrades gracefully if the content script is unreachable. Only image files are captured this way; non-image files in this section (e.g. `.docx`) render with no `<img>` and are silently skipped — their download mechanism is unconfirmed and not yet implemented. `extension/lib/zipBuilder.js`'s `buildProjectZip` fetches every scraped file into `fichiers/` via the same `fetchFilesInto()` helper already shared by `artefacts/`/`contenu/`, falling back to an empty `.gitkeep` placeholder if the section was empty/absent or every fetch failed.

### Conversation Artifact & Content Capture
Neither a conversation's Claude-generated artifacts nor its individually-attached files are exposed by a REST API endpoint that returns their content directly — both are downloaded via `GET /api/organizations/{org}/conversations/{conv}/wiggle/download-file?path=<url-encoded /mnt/user-data/... path>` (confirmed via live Network captures — a real navigation with `Content-Disposition: attachment`, not a client-side-generated Blob, so there is nothing to intercept).

The real on-disk path for each file is not exposed by any dedicated field, but it turns out to already be present as plain text inside the conversation JSON that `sidepanel.js` fetches for every export anyway (via `fetchConversation`) — in `chat_messages[].files[].path` for uploads, and inside `tool_use`/`tool_result` content (bash commands, command output) for files Claude writes to `/mnt/user-data/outputs/`. `extractFilePaths()` in `extension/lib/api.js` regex-scans the whole `JSON.stringify()`-ed response for `/mnt/user-data/(uploads|outputs)/...` occurrences — restricting the filename portion to characters plausible in a real filename (word chars, spaces, dots, hyphens, parens) rather than reading until the next quote, since some matches sit inside multi-line bash command strings where a naive "up to the next quote" read would swallow the rest of the command as part of the "path". This replaced an earlier DOM-scraping approach that guessed each artifact's on-disk filename from its card's "humanized" title (e.g. "Keensight slide library v2" → guessed `keensight_slide_library_v2.zip`) — confirmed via a live test to guess wrong roughly half the time (a hyphenated real filename, and one with different casing/underscores than its title, both silently dropped).

`sidepanel.js` builds a `download-file?path=...` URL for every extracted path — outputs paths become `artefacts/` entries, uploads paths become `contenu/` entries — plus image attachments, which still need one DOM scrape: `extension/content.js`'s `getConversationArtifacts()` opens the Files sidebar (`[aria-label="Fichiers"]`, skipped if `aria-pressed="true"` already — clicking an already-open toggle would close it) to reach the "Contenu" section (distinct from the project-level "Contenu du projet") and scrape `<img alt src>` thumbnails for their `/preview` URLs, since those aren't derivable from a `/mnt/user-data` path. `extension/lib/zipBuilder.js`'s `fetchFilesInto()` helper then fetches every URL in a list (`credentials: 'include'`) directly into its target folder, skipping individual failures without aborting the export — a folder falls back to an empty `.gitkeep` placeholder only if every fetch in it failed.

**Project export** (single-project and multi-project batch alike) now captures the same data for every conversation in the project, in two phases: a JSON-only phase (`buildArtifactsDataFromConversationJson`, shared with single-conversation export) that runs immediately after the existing batched `fetchAllConversations` call — no navigation needed, since artifact/uploaded-file paths come from each conversation's own JSON — followed by a sequential per-conversation navigation phase (`captureProjectConversationImages`) that visits each conversation's page in the active tab (status: `"Capturing images N/Total: <name>..."`) purely to scrape image content files' `/preview` URLs, the one piece of data that requires the DOM. A conversation whose navigation fails keeps its JSON-derived data; only its images are skipped. `buildProjectZip` takes an optional `artifactsDataByUuid` map (keyed by each conversation's `metadata.uuid`) to thread this per-conversation data through — omitting it (as no call site now does) falls back to the original always-empty behavior.

### Multi-Project Batch Export
On `claude.ai/projects`, `extension/content.js` gains a "selection mode": on `{type: 'START_SELECTION_MODE'}`, it attaches a capture-phase click listener to the `<ul aria-label="Projets">` project list that intercepts clicks (`preventDefault`/`stopPropagation`, blocking normal navigation) and toggles a red CSS outline plus an in-memory `Set` of selected UUIDs. `{type: 'GET_SELECTED_PROJECTS'}` returns the current selection as `{uuid, name}` pairs; `{type: 'STOP_SELECTION_MODE'}` tears the listener/borders down. `sidepanel.js` shows a "Select Projects" button on the listing page, polls the selection every 500ms to keep a live "Confirm Selection (N)" count, then on confirm drives a sequential batch: for each selected project it navigates the SAME active tab (`chrome.tabs.update`), waits for the freshly-injected content script to respond to `{type: 'PING'}` (checked against the content script's own `window.location.pathname` in the response, not just any `{pong: true}` — a stale content script on the previous page can otherwise still answer PING for a brief window after `chrome.tabs.update()` resolves, since that call resolves once navigation is *initiated*, not once it *completes*), then runs the same fetch/scrape pipeline as single-project export against one shared `JSZip` instance (via `buildProjectZip(zip, folderPath, ...)` — refactored to accept a caller-supplied zip/folder rather than always creating and generating its own, so multiple projects can be nested into one combined zip). A `batchInProgress` flag (checked by the same `detectContext()` early-return guard used for `selectionMode`) plus disabling `#export-btn` for the batch's duration prevent the pre-existing `chrome.tabs.onUpdated`-triggered `detectContext()` calls (fired by the batch's own navigation) from re-enabling single-project export against the tab the batch is actively driving. A project that fails at any step (navigation timeout, empty conversation list, fetch failure) is recorded and skipped — the batch continues with the rest, and no zip is generated at all if every project fails. One combined `.zip` (`projects_batch_<count>.zip`) downloads once, after the loop.

### Rate Limiting & Batching
- Conversations fetched in batches of 5, with a 500-750ms delay between batches (750ms above 50 conversations).
- Individual conversation fetch retries up to 3 times on failure, with exponential backoff starting at 1000ms (capped at 10000ms) on HTTP 429.
- Partial failures are tolerated: if some conversations fail to fetch, the export still completes with the successful ones, and the status message reports how many failed.

## Development Guidelines

### Code Standards
- Pure vanilla JavaScript - no frameworks, no bundler, no build step.
- Manifest V3 - all scripts loaded via `<script>` tags in `sidepanel.html`, no ES modules, no dynamic `import()`.
- The only external dependency is the vendored `jszip.min.js` - do not add a CDN reference (blocked by MV3 CSP).

### Testing Approach
No automated test suite. Manual verification against a live claude.ai session, covering:
1. Empty project (0 conversations).
2. Small project (1-20 conversations).
3. Larger project (50+ conversations) - verify batching/delay behavior.
4. Single conversation export outside a project.
5. Logged-out / auth failure state.
6. Side panel opened on an unrelated claude.ai page or a different site - should show the "navigate to a project/conversation" message, no button.
7. Side panel context updates correctly when switching tabs or navigating within the same tab, without needing to close/reopen the panel.

### Testing New Changes
1. Open `chrome://extensions`, enable Developer mode.
2. Click "Load unpacked" (first time) or the refresh icon on the extension card (after edits) and select/reload the `extension/` folder.
3. Navigate to a Claude project or conversation page and use the side panel (click the toolbar icon to open it if not already open).
4. Inspect the panel's console via right-click inside the panel → Inspect for `console.log`/error output.

## Security Considerations

- Client-side only - no data sent anywhere except claude.ai's own API.
- Uses the browser's existing claude.ai session (cookies) - no credential storage by the extension.
- No external dependencies loaded at runtime - JSZip is vendored, not fetched from a CDN (MV3 CSP requirement).

## Distribution

This extension is developer-mode only (unpacked) - it is not published to the Chrome Web Store. There is no `key` field in the manifest and no store-review-oriented permission minimization beyond what's functionally required.
