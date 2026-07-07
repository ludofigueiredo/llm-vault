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
- `extension/content.js` - Content script injected on `claude.ai/project/*` and `claude.ai/chat/*`; scrapes the project's Memory/Instructions text (project pages) and orchestrates conversation artifact/content capture (chat pages) from the DOM on request (no REST API exposes this data).
- `extension/main-world-hook.js` - Content script injected on `claude.ai/chat/*` with `"world": "MAIN"`; hooks `URL.createObjectURL` to intercept the artifact zip Blob claude.ai generates client-side when "Download all" is clicked.

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
- Project export: `index.md` at the root, plus `memory.md`/`instructions.md` (only if found — see Project Metadata Scraping below), plus an empty `fichiers/` placeholder, plus one folder per conversation (`<title>_<uuid8>/`), each containing `conversation.md`, `artefacts/` (empty), `contenu/` (empty) — per-conversation artifact/content capture (below) is scoped to single-conversation export only, not project export.
- Single conversation export: one folder with `conversation.md`, `artefacts/` (populated with unzipped Claude-generated artifacts if any were captured, otherwise empty), `contenu/` (populated with fetched image attachments if any were found, otherwise empty). No index, no memory/instructions/fichiers (project-only concepts).

`fichiers/` (project knowledge files) remains a placeholder in the current version — populating it with real content is a planned future phase, not yet implemented. Project-mode `artefacts/`/`contenu/` are likewise still empty placeholders; only single-conversation exports populate them (see Conversation Artifact & Content Capture below).

### Project Metadata Scraping (Memory & Instructions)
Claude's Memory and Instructions text for a project is not exposed by any REST API the extension uses — it only exists rendered in the project page's DOM. `extension/content.js` is injected on `claude.ai/project/*` pages and, on request (`chrome.runtime.onMessage` with `{type: 'GET_PROJECT_METADATA'}`), scans for `<h3>` elements matching the exact label text `"Mémoire"`/`"Instructions"` (French UI only — no i18n support), then walks up to 5 ancestor levels looking for a sibling `<p>` with the section's text. During a project export, `popup.js` messages the active tab's content script and passes the result into `buildProjectZip`; if the content script isn't present/responsive (page not loaded, wrong page, or a UI change broke the selectors), the export proceeds without `memory.md`/`instructions.md` rather than failing — this is enrichment, not a required part of a successful export.

### Conversation Artifact & Content Capture
Neither a conversation's Claude-generated artifacts nor its individually-attached files are exposed by any REST API — both only exist behind UI interaction on the conversation's "Files" sidebar. This is the most fragile mechanism in the extension: it depends on exact button label text (`"Fichiers"`, `"Tout télécharger"`) and section heading text (`"Artéfacts"`, `"Contenu"`) matching claude.ai's current French-only UI, and on claude.ai using `URL.createObjectURL` internally for its own "download all" flow.

During single-conversation export, `popup.js` sends `{type: 'GET_CONVERSATION_ARTIFACTS'}` to `extension/content.js`, which:
1. Clicks the Files sidebar toggle (`[aria-label="Fichiers"]`), then polls (bounded, ~3s) for an "Artéfacts" heading to appear.
2. If found, locates and clicks its "Tout télécharger" button — but first arms `extension/main-world-hook.js` via `window.postMessage` (the hook runs in the page's MAIN JS world, necessary to intercept `URL.createObjectURL` calls made by claude.ai's own React code, which an isolated-world content script cannot observe).
3. Awaits the hook's captured Blob (as an ArrayBuffer, since raw Blobs aren't reliably structured-cloneable across the `chrome.runtime` messaging boundary) with a ~10s timeout, then closes the sidebar again regardless of outcome.
4. Separately (independent of the above), scrapes the "Contenu" section (distinct from the project-level "Contenu du projet") for `<img alt src>` thumbnails, returning `{filename, url}` pairs — only image attachments have a discoverable `/preview` URL this way; non-image files (e.g. `.pptx`) have no fetchable link in the DOM and are silently skipped.

`extension/lib/zipBuilder.js` then unzips the captured artifact Blob (via JSZip, preserving its internal folder structure) into `artefacts/`, and fetches each scraped content file (`credentials: 'include'`) into `contenu/`, skipping individual failures without aborting. Every step degrades gracefully — a missing button, missing section, capture timeout, or failed fetch never fails the overall export, it just leaves the corresponding folder (partially) empty. A real Chrome download is still triggered on disk when "Tout télécharger" is clicked (same as manual use) — this is an accepted side effect of using real UI interaction, not a bug.

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
