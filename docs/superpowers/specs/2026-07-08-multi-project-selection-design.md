# Multi-Project Visual Selection & Batch Export — Design

**Date:** 2026-07-08
**Status:** Approved

## Context

The extension currently exports one project at a time: the user navigates to a project page and clicks "Export Project" in the side panel. There's no way to export several projects in one operation without repeating that manually for each one.

The user wants to add this capability from the `claude.ai/projects` listing page: a "Select Projects" mode that lets them visually pick multiple project cards (red border highlight, toggled by clicking the card), then confirm to kick off a sequential scrape — the extension navigates the active tab to each selected project in turn, runs the existing project-export pipeline, and finally produces one combined `.zip` covering every selected project.

A captured DOM snapshot of the listing page (`select_projects.html`, repo root) shows the structure: a `<ul aria-label="Projets">` containing one `<li>` per project, each with an `<a href="/project/[uuid]">` wrapping the project's name and metadata.

## Goals

1. When the side panel detects the active tab is on `claude.ai/projects`, show a **"Select Projects"** button.
2. Clicking it arms a selection mode on the page: clicking a project card toggles a visible red border around it (selecting/deselecting) instead of navigating to that project.
3. Once at least one project is selected, the panel shows a **"Confirm Selection (N)"** button reflecting the current count.
4. Confirming: the panel navigates the active tab to each selected project in turn (same-tab, sequential — not parallel background tabs), waits for the page and its content script to be ready, then runs the exact same scraping pipeline as today's single-project "Export Project" (conversations, `memory.md`, `instructions.md`, `fichiers/` placeholder).
5. After every selected project has been processed, the panel builds **one combined `.zip`** — a subfolder per project (using the same project-zip internal structure as today, just nested), then triggers a single download.
6. Every step degrades gracefully in the same spirit as the rest of this extension: if navigating to or scraping one project fails, that project is skipped (logged in the final status) and the batch continues with the remaining ones — one bad project must not abort the whole batch.

## Non-goals

- No support for resuming a batch if the side panel is closed mid-operation — the panel must stay open for the whole batch; closing it loses in-memory progress (accepted trade-off, avoids the complexity of persisting large zip Blobs to `chrome.storage`).
- No parallel/background-tab scraping — projects are processed one at a time in the same visible tab, matching the existing project-export pipeline's expectations (it already assumes it's operating on the tab currently showing the target project).
- No change to single-project export or single-conversation export — both keep working exactly as they do today; this is purely additive.
- No persistence of the selection across a page reload — if the user reloads `claude.ai/projects` while in selection mode, the selection resets (same class of limitation as the existing Memory/Instructions/Artifacts features, which also don't survive a page reload mid-operation).

## Architecture

### Content script: selection mode on `claude.ai/projects`

New logic added to `extension/content.js`, active only on pages matching `claude.ai/projects` (requires extending `content_scripts`' `matches` in `manifest.json`, or adding a project-listing-specific script — see plan for the exact manifest change). Responsibilities, reachable via new message types:

- **`START_SELECTION_MODE`**: finds the `<ul aria-label="Projets">` project list, attaches a capturing click listener on the list (event delegation) that, while selection mode is active, calls `preventDefault()`/`stopPropagation()` on clicks within a project `<li>`'s `<a>` (blocking normal navigation) and instead toggles that project's UUID (extracted from the `<a href="/project/[uuid]">`) in an in-page `Set`. Toggling also adds/removes a visible CSS class (e.g. a `3px solid red` outline) on the `<li>`'s container so the user sees which cards are selected.
- **`GET_SELECTED_PROJECTS`**: returns the current selection as `Array<{uuid: string, name: string}>` (name read from the same `<div>` the listing already renders it in, for status-message purposes later).
- **`STOP_SELECTION_MODE`**: removes the click listener and all visual selection borders, restoring the page to normal (called both when the user confirms — since the panel takes over from there — and if the user cancels).

Design constraint carried over from the rest of this extension: none of this may throw uncaught, and if the `<ul aria-label="Projets">` isn't found (e.g. an empty project list, or claude.ai changed the page), `START_SELECTION_MODE` simply arms nothing and the panel will see zero selectable projects — no crash.

### Side panel: batch orchestration

`extension/sidepanel.js` gains a new branch of `detectContext()`: if the active tab's URL matches `claude.ai/projects` (no project/conversation UUID in the path), show the **"Select Projects"** button instead of (or alongside — see plan) the normal "no project/conversation detected" message.

New flow, all driven from the panel (which is the only place able to survive the tab's navigation across projects — an in-page content script is destroyed and recreated on every navigation):

1. **Select Projects clicked** → send `START_SELECTION_MODE` to the content script. Panel switches its own UI to show a live-updating "Confirm Selection (N)" button — the panel polls `GET_SELECTED_PROJECTS` (or listens for a lightweight push notification from the content script on each toggle — see plan for the exact mechanism) to keep `N` current as the user clicks cards.
2. **Confirm Selection clicked** → panel sends `GET_SELECTED_PROJECTS` for the final list, then `STOP_SELECTION_MODE` to clean up the page, then begins the batch loop.
3. **Batch loop**, for each selected project `{uuid, name}` in order:
   - `chrome.tabs.update(tabId, {url: 'https://claude.ai/project/' + uuid})`.
   - Wait for the navigation to complete and the content script to be ready on the new page — reusing the same "poll until responsive" idea already used elsewhere in this extension (e.g. `waitForCondition` in `content.js`), applied here from the panel's side via repeated `chrome.tabs.sendMessage` attempts with a bounded timeout, since a fresh navigation means a fresh content-script injection that isn't instantaneous.
   - Run the existing project-export pipeline (`fetchConversationsList`, `fetchAllConversations`, `GET_PROJECT_METADATA` for memory/instructions) exactly as today's single-project export does.
   - Call the refactored `buildProjectZip` (see below) against a shared, running `JSZip` instance, nested under a per-project folder (named the same way as today's single-project zip root, e.g. `project_<uuid8>/`).
   - Update the panel's status message (`Scraping project 2/5: <name>...`).
   - On any failure at any of these steps for this project, record it as failed (name + reason) and move on to the next project — do not abort the batch.
4. **After the loop**: generate the combined zip's blob (`zip.generateAsync({type: 'blob'})`) and trigger one `chrome.downloads.download(...)`, named e.g. `projects_batch_<count>.zip`. Final status message summarizes success/failure counts, similar to the existing "Exported N/M conversations (K failed)" pattern.

### `extension/lib/zipBuilder.js`: `buildProjectZip` refactor

Change `buildProjectZip`'s signature from `buildProjectZip(projectId, conversations, projectMetadata)` (which internally creates its own root `JSZip` and returns a generated blob) to `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata)`, where:
- `zip` is an existing `JSZip` instance (root or otherwise) the caller owns and will call `.generateAsync()` on when it's ready — mirroring the existing `buildConversationFolder(zip, folderName, conversation, artifactsData)` pattern already in this file.
- `folderPath` is the folder name/path to nest this project's contents under within `zip` (e.g. `''` for the existing single-project-export call site, which puts `index.md` etc. at the zip root exactly as today; `project_<uuid8>/` for each project in a batch).
- The function no longer calls `zip.generateAsync()` itself — that responsibility moves to the caller, exactly once, after all desired content has been added.

The single-project export call site in `sidepanel.js` updates accordingly (create a `JSZip`, call `buildProjectZip(zip, '', ...)`, then `zip.generateAsync({type: 'blob'})`) — this is a pure refactor with no behavior change for that existing path, verified by the fact that `folderPath: ''` produces byte-identical zip contents to the current implementation (JSZip treats an empty-string folder prefix as "no nesting").

## Error handling

Consistent with the rest of this extension:
- A project that fails to load/navigate within its timeout, or whose conversations fail to fetch entirely, is skipped — recorded in a `failures: [{name, reason}]` list, batch continues.
- Memory/instructions capture failures for an individual project degrade the same way single-project export already does (that project's subfolder just lacks `memory.md`/`instructions.md`, no batch-level impact).
- If the side panel is closed mid-batch, the in-progress operation is simply lost (per Non-goals) — no special handling attempted, this matches the existing "panel must stay open" constraint already accepted for the persistent-panel behavior.
- If zero projects end up successfully scraped (all failed), no zip is generated and the panel shows an explicit error rather than downloading an empty/near-empty zip.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification against a live claude.ai session:
1. On `claude.ai/projects` with 3+ projects, click "Select Projects", click 2-3 cards — confirm red borders appear/disappear correctly on toggle, and the panel's "Confirm Selection (N)" count updates live.
2. Click a card, click it again — confirm it deselects (border removed, count decreases).
3. Confirm with 2 projects selected — confirm the tab visibly navigates to each project in turn, the panel's status updates per project, and a single combined `.zip` downloads at the end containing both projects' subfolders with correct internal structure (conversations, memory.md/instructions.md where present).
4. Select a project, then deliberately make one fail (e.g. a project with zero conversations, if `fetchConversationsList` treats that as a failure) alongside a normal one — confirm the batch continues and the final status correctly reports one success and one failure.
5. Confirm single-project export (from a project page) and single-conversation export still work exactly as before — regression check on the `buildProjectZip` refactor.
6. Start a batch, close the side panel mid-way — confirm the tab is left on whatever project it was navigating to (no crash), and reopening the panel starts fresh (no attempt to resume).

## Phase 2 (future, not part of this implementation)

- Selection mode UI polish (e.g. a "select all" shortcut, a visible running list of selected project names in the panel rather than just a count).
- Background-tab (non-navigating) batch scraping, if the sequential same-tab approach proves too slow for large batches.
