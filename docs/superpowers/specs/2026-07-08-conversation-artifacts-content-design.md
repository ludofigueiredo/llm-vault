# Conversation Artifacts & Content Export — Design

**Date:** 2026-07-08
**Status:** Approved

## Context

Some Claude conversations have a "Files" sidebar (opened via an icon button, `aria-label="Fichiers"`) with two relevant sections:

- **Artéfacts** — Claude-generated artifacts (code, documents) attached to the conversation. The sidebar offers a "Tout télécharger" (Download all) button that bundles every artifact into a single zip, generated client-side by claude.ai's own JS and downloaded via a browser download — there is no REST endpoint for this; the zip only exists as an in-browser `Blob`.
- **Contenu** — individual files attached to the conversation (as opposed to "Contenu du projet", which is the project's knowledge base — already handled by prior phases and explicitly out of scope here). Each file renders as a thumbnail with an `/api/[org]/files/[uuid]/preview` image URL.

The existing extension (built in prior phases) already creates empty `artefacts/` and `contenu/` placeholder folders per conversation in the exported zip, reserved for exactly this data. This phase populates them with real content, for single-conversation exports only.

## Goals

1. When exporting a single conversation (`/chat/[uuid]` mode only — see Non-goals), automatically:
   - Open the Files sidebar, trigger "Tout télécharger" for Artéfacts if present, capture the resulting zip Blob (intercepted before it hits disk), unzip it in-memory, and place its contents into the export zip's `artefacts/` folder.
   - Read the "Contenu" section's file thumbnails, fetch each file via its `/preview` URL, and place successfully-fetched files into the export zip's `contenu/` folder.
2. Every step degrades gracefully: a conversation with no Files sidebar, no Artéfacts, no "Tout télécharger" button, a capture timeout, or an individual file fetch failure must never fail the overall export — the corresponding folder simply stays empty (or partially populated), exactly like today's placeholder behavior.

## Non-goals (explicitly out of scope for this phase)

- **Project-mode export.** This mechanism only works on the conversation page that's currently open in the active tab (the DOM must exist to click on). A project export covers many conversations, which would require navigating the tab to each one, waiting for load, running this whole capture sequence, then moving to the next — a slow (potentially 15-30+ minutes for a large project) and fragile approach (one broken page load ruins that conversation's artifacts). This is deferred to a future phase; for now, project exports continue to produce empty `artefacts/`/`contenu/` per conversation exactly as before.
- **"Contenu du projet" section.** Project-level knowledge files were already addressed in a prior phase (as the project-level `fichiers/` placeholder); this phase's "Contenu" only refers to conversation-level attached files, a visually and structurally distinct section in the sidebar.
- **Verifying against a live claude.ai session during implementation.** The implementer works in a sandboxed environment with no real Chrome browser. This is the most fragile mechanism built into this extension so far (DOM click simulation + a MAIN-world JS hook + timing-dependent capture) — live verification by the user after implementation is essential and explicitly expected, not just a nice-to-have.

## Known risk: high fragility

This feature is meaningfully more fragile than anything built in prior phases:
- It depends on exact button `aria-label` text (`"Fichiers"`) and button text content (`"Tout télécharger"`) matching claude.ai's current UI — any rename breaks detection silently (degrades to empty `artefacts/`, per the graceful-degradation goal — not a crash, but a silent feature loss).
- It depends on `window.URL.createObjectURL` being the mechanism claude.ai uses to hand the generated zip to the browser's download flow — if claude.ai changes its download implementation (e.g., navigates to a data: URL instead, or streams differently), the hook simply never fires and, again, degrades to empty `artefacts/`.
- Timing-dependent: the sidebar's open animation and the zip generation itself both take an unknown, non-instant amount of time. The implementation uses generous timeouts and explicit wait-for-element polling rather than fixed delays, but there is inherent risk of either false-negative timeouts (capture aborts even though it would have succeeded a moment later) or, if a user's browser is unusually slow, needing a longer timeout than provided.
- Clicking "Tout télécharger" triggers a real, individual Chrome download (visible in the downloads bar/shelf) each time — same as it would if the user clicked it manually. This is expected and not a bug; it's an accepted side effect of using real UI interaction. The download completing on disk (in the user's normal Downloads folder) happens in parallel with the extension's in-memory Blob capture — the extension does not need or attempt to delete this on-disk copy.

This is accepted as a deliberate trade-off: the alternative (finding and reverse-engineering claude.ai's actual internal artifact-bundling logic or a hidden API) is out of scope for this project's approach of using only public-surface DOM/download mechanisms.

## Architecture

### New file: `extension/main-world-hook.js`

Injected via `manifest.json`'s `content_scripts` with `"world": "MAIN"` — this runs in the actual page's JS context (not the isolated content-script world), which is necessary because `window.URL.createObjectURL` must be intercepted at the same object identity the page's own React code calls it on.

Responsibilities:
- On load, wraps `window.URL.createObjectURL` so that any call with a `Blob` whose `type` is `application/zip` (or empty/octet-stream — claude.ai's exact MIME type is unconfirmed, so the hook should be lenient and capture any Blob-based call that occurs while "armed," not filter strictly by MIME type) is captured: the Blob is read via `blob.arrayBuffer()` and posted to the isolated-world content script via `window.postMessage` with a distinguishing message shape, then the original `createObjectURL` call proceeds normally (so claude.ai's own download flow is undisturbed — the hook observes, it does not block).
- The hook is "armed" only between an explicit start signal and either a successful capture or a timeout — it does not unconditionally intercept every `createObjectURL` call for the page's entire lifetime, to minimize interference with any other feature of claude.ai that might use blob URLs (e.g. the file preview thumbnails likely already use blob/data URLs internally for rendering). Arming/disarming is itself driven by `window.postMessage` from the isolated-world content script (which is the only actor with enough context to know when a capture is in progress).

### Modified: `extension/content.js`

Two new capabilities, both reachable via a new message type `GET_CONVERSATION_ARTIFACTS` alongside the existing `GET_PROJECT_METADATA`:

**`captureArtifactsZip()`** — an async function returning a `Blob | null`:
1. Finds the Files sidebar toggle button (`[aria-label="Fichiers"]`); if absent, returns `null` immediately (no artifacts sidebar exists for this conversation).
2. Clicks it, then polls (bounded, e.g. up to ~3s) for the sidebar's "Artéfacts" heading to appear in the DOM — this confirms the sidebar opened AND that this conversation has artifacts (a conversation with a Files button but zero artifacts may only show a "Contenu" section, or no Artéfacts heading at all).
3. If found, locates the "Tout télécharger" button within that section; if absent, no artifacts to download — proceeds to step 6 without attempting a capture.
4. Arms the MAIN-world hook (via `postMessage`), clicks "Tout télécharger", then awaits a capture message from the hook with a bounded timeout (e.g. ~10s, generous since zip generation time is unknown and may scale with artifact count/size).
5. Disarms the hook regardless of outcome (success or timeout) so it doesn't leak an armed listener.
6. Closes the sidebar (clicks the same Files toggle button again, or a close control if one exists) to restore the page to its original state.
7. Returns the captured Blob, or `null` if any step didn't find what it needed or the capture timed out.

**`scrapeContentFiles()`** — a synchronous function returning `Array<{filename: string, url: string}>`:
- Finds the "Contenu" section specifically (distinguished from "Contenu du projet" by being a sibling `<h3>Contenu</h3>` container, not the one containing a `/project/[uuid]` link — reuse the same kind of label-matching approach as the existing Memory/Instructions extraction, adapted for this section's structure).
- Within it, collects each file thumbnail's `alt` attribute (filename, e.g. `"thumbnails-1.jpg"`) and `src` attribute (the `/preview` URL) from `<img>` elements, resolving relative URLs against `location.origin`.
- Returns an empty array if the section isn't found or has no files — never throws.

The message handler for `GET_CONVERSATION_ARTIFACTS` calls both functions (capture is awaited; scrape is synchronous) and responds with `{artifactsZip: ArrayBuffer | null, contentFiles: Array<{filename, url}>}`. The Blob is transferred as an `ArrayBuffer` because `chrome.runtime.sendMessage`/`sendResponse` payloads must be structured-cloneable JSON-like data — raw `Blob` objects do not reliably survive this boundary in all Chrome versions, whereas `ArrayBuffer` is explicitly supported by the structured clone algorithm used for extension messaging.

### Modified: `extension/manifest.json`

The existing `content_scripts` array gains a second entry:
```json
{
  "matches": ["https://claude.ai/chat/*"],
  "js": ["main-world-hook.js"],
  "world": "MAIN",
  "run_at": "document_idle"
}
```

Note the `matches` pattern here is `https://claude.ai/chat/*` (conversation pages), distinct from the existing Memory/Instructions content script's `https://claude.ai/project/*` — this feature only operates in conversation-page context per the Non-goals section. The existing `extension/content.js` (isolated world) also needs a matching entry for `https://claude.ai/chat/*` if it doesn't already have one broad enough to cover it — the implementation plan will confirm and adjust the existing project-scoped entry vs. adding a new conversation-scoped one.

### Modified: `extension/popup.js`

In the `conversation` branch of `runExport()`, before building the zip: message the content script with `GET_CONVERSATION_ARTIFACTS` (same try/catch-and-degrade pattern as the existing Memory/Instructions call), obtaining `{artifactsZip, contentFiles}`. Pass this into `buildConversationZip` alongside the existing `conversation` object.

### Modified: `extension/lib/zipBuilder.js`

`buildConversationFolder(zip, folderName, conversation, artifactsData)` gains a parameter (shape `{artifactsZip: ArrayBuffer|null, contentFiles: Array<{filename, url}>}`, optional — safe defaults if omitted, same pattern as the existing `projectMetadata` parameter on `buildProjectZip`):

- If `artifactsData.artifactsZip` is present: load it with JSZip (`JSZip.loadAsync(arrayBuffer)`), then iterate its entries and re-add each one into this conversation's `artefacts/` folder in the export zip, preserving the captured zip's internal file/folder structure. If absent, `artefacts/` keeps its current `.gitkeep` placeholder-only behavior.
- If `artifactsData.contentFiles` is non-empty: for each `{filename, url}`, `fetch(url, {credentials: 'include'})` and, on success, write the resulting blob's bytes into `contenu/<filename>`; on failure (network error, non-ok response), skip that file silently (log-worthy but not user-facing-error-worthy) and continue with the rest. If the array is empty or fetches all fail, `contenu/` keeps its `.gitkeep` placeholder-only behavior (or ends up with only whichever files succeeded).

`buildProjectZip`'s per-conversation calls to `buildConversationFolder` continue to omit the new 4th parameter (project-mode conversations get empty `artefacts/`/`contenu/`, per Non-goals) — only `buildConversationZip` (single-conversation export) passes real `artifactsData`.

## Error handling

Consistent with the rest of this extension's established pattern: enrichment steps must never fail the overall export.
- No Files sidebar button → `artefacts/` and `contenu/` (from the artifacts capture path) get nothing; `contenu/` may still get content from the separate content-scraping path if that section exists independent of the sidebar's Files toggle (needs confirming during implementation whether "Contenu" is only visible inside the same sidebar as "Artéfacts," or exists separately — see plan for the concrete DOM check).
- Sidebar opens but no Artéfacts section / no "Tout télécharger" button → `artefacts/` stays empty, no error.
- Hook never fires within timeout → `artefacts/` stays empty, no error, sidebar is still closed to restore page state.
- Individual `contenu/` file fetch fails → that file is skipped, others still attempted.
- The overall export's success/failure status message is unaffected by any of the above — same principle as the Memory/Instructions feature from the prior phase.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification against a live claude.ai session is essential here more than in any prior phase, covering:
1. A conversation with both Artéfacts (multiple) and Contenu files — confirm `artefacts/` contains the unzipped artifact files with correct structure, and `contenu/` contains the fetched content files.
2. A conversation with a Files sidebar but no Artéfacts (only Contenu, or neither) — confirm no crash, `artefacts/` stays empty appropriately.
3. A conversation with no Files button at all — confirm export still completes normally with both folders empty.
4. Observe whether a real "Download all" browser download notification/shelf entry appears during export (expected side effect, not a bug) — confirm the export doesn't hang waiting on any browser download-permission prompt.
5. A conversation with a large number of substantial artifacts (test whether the ~10s hook-capture timeout is sufficient, or needs tuning based on real-world timing observed).
6. Time the whole export to sanity-check it's not unreasonably slower than before this feature (should add a few seconds for sidebar interaction, not minutes).

## Phase 2 (future, not part of this implementation)

- Extend this mechanism (or find a more robust alternative, e.g. a real API endpoint if one is ever identified) to work for project-mode exports across every conversation in the project.
