# Recents Page Multi-Conversation Selection & Export — Design

**Date:** 2026-07-09
**Status:** Approved

## Context

The extension currently supports exporting a single conversation, a whole project, or several projects selected visually from `claude.ai/projects`. It has no way to export an arbitrary set of conversations that aren't grouped under a project — e.g. picking a handful of conversations from `claude.ai/recents` (the "all conversations" listing, distinct from any single project's conversation list).

A captured DOM snapshot of `/recents` (`snippet-claude-website/all-conversations.html`, repo root) shows the structure: a `<table>` whose `<tbody>` contains one `<tr data-hoverable="">` per conversation, each with `<a href="/chat/[uuid]" data-primary="true" aria-label="[title]">`. The snapshot captured 66 rows already rendered; `/recents` uses scroll-triggered lazy-loading (more rows load as the user scrolls down), so a snapshot at any given moment does not necessarily contain every conversation the user has.

The DOM already contains hidden native checkboxes per row (`data-cds="Checkbox"`, revealed via a `data-selection-mode` attribute on the table) — but these back claude.ai's own bulk-delete flow, not export. Reusing them would couple this extension to UI designed for a different, destructive action and liable to change without notice. This feature builds its own selection mechanism instead, following the same pattern already used for `claude.ai/projects` (visual red-border selection via a custom click-capture listener).

## Goals

1. When the side panel detects the active tab is on `claude.ai/recents`, show a **"Select Conversations"** button (parallel to the existing "Select Projects" button on `claude.ai/projects`).
2. Clicking it arms a selection mode on the page: clicking a conversation row toggles a red border around it (selecting/deselecting), using the same visual/mechanical pattern as project selection — without touching claude.ai's own native checkbox/selection-mode machinery.
3. A **"Select All"** control auto-scrolls the page to trigger claude.ai's lazy-loading until no new rows appear, then selects every conversation row found — guaranteeing full coverage rather than only what happened to be loaded at the moment of the click.
4. During manual (one-by-one) selection, the user scrolls the page normally with their mouse/trackpad to reveal more conversations; claude.ai's own lazy-load triggers as usual. No dedicated "load more" control is needed for this path.
5. Once the user confirms a selection (via a **"Confirm Selection (N)"** button, same pattern as the existing batch flows), the panel exports every selected conversation with the same completeness as project export: text via the batched conversation-fetch API, artifacts/uploaded-files via JSON path extraction (no navigation), and image content files via one navigation visit per conversation — reusing the existing helpers built for project export (`buildArtifactsDataByUuid`, `captureProjectConversationImages`) rather than duplicating that logic.
6. Output: a single `.zip` (`conversations_selection_<count>.zip`) containing an `index.md` listing the exported conversations plus one folder per conversation (`conversation.md`, `artefacts/`, `contenu/`) — no `memory.md`/`instructions.md`/`fichiers/`, since those are project-level concepts that don't apply to an arbitrary conversation selection.
7. Graceful degradation throughout, consistent with every other capture mechanism in this extension: a conversation that fails at any step is skipped for that step only (or entirely, if its text fetch itself fails) without aborting the rest of the export.

## Non-goals

- No reuse of claude.ai's native row-selection/checkbox UI (see Context) — this feature's selection mechanism is fully independent, mirroring the `/projects` pattern.
- No persistence of the selection across a page reload — consistent with the existing `/projects` selection feature's same limitation.
- No support for resuming an in-progress export if the side panel is closed mid-operation — consistent with every other batch/multi-item export in this extension.
- No change to single-conversation export, project export, or multi-project batch export — this is purely additive, a new context alongside the existing ones.
- No attempt to detect or handle `/recents` filters/search (e.g. if the user has typed into a search box that filters the visible table) — selection operates on whatever rows are currently rendered/loadable via scroll, matching what the user sees.

## Architecture

### Content script: selection mode on `claude.ai/recents`

New logic added to `extension/content.js`, active only on pages matching `claude.ai/recents` (requires adding this path to `manifest.json`'s `content_scripts.matches` — see plan for the exact change). Reachable via new message types, named distinctly from the existing `/projects` selection messages to avoid ambiguity when both features exist side by side:

- **`START_RECENTS_SELECTION_MODE`**: finds the conversations `<table>`'s `<tbody>`, attaches a capturing click listener that intercepts clicks on a `<tr data-hoverable="">` (via `event.target.closest('tr[data-hoverable]')`, scoped to confirm the row is inside the recents table), calling `preventDefault()`/`stopPropagation()` to block navigation to the conversation and instead toggling that row's conversation UUID (extracted from its `<a href="/chat/[uuid]">`) in an in-page `Set`. Toggling also adds/removes the same visual CSS class already used for `/projects` selection (`claude-exporter-selected`, red outline) on the `<tr>`.
- **`GET_SELECTED_RECENTS_CONVERSATIONS`**: returns the current selection as `Array<{uuid: string, name: string}>` (name read from the row's `aria-label` or its truncated title `<span>`, for status-message purposes).
- **`STOP_RECENTS_SELECTION_MODE`**: removes the click listener and all visual selection borders, restoring the page to normal.
- **`SELECT_ALL_RECENTS_CONVERSATIONS`**: auto-scrolls the page (`window.scrollTo` to the bottom, repeated) until the count of `<tr data-hoverable="">` rows stops growing across a bounded number of consecutive checks (polling pattern, reusing the existing `waitForCondition`-style approach already used elsewhere in this codebase — e.g. `captureArtifactsZip`'s history before its own removal, `waitForContentScriptReady`), then selects every row found by adding each one's UUID to the same selection `Set` used by manual toggling and applying the same visual border to each. Returns the final count once done, so the panel can update its "Confirm Selection (N)" button without a separate poll round-trip.

Design constraint carried over from the rest of this extension: none of this may throw uncaught, and if the conversations table isn't found (e.g. an empty recents list, or claude.ai changed the page), `START_RECENTS_SELECTION_MODE`/`SELECT_ALL_RECENTS_CONVERSATIONS` simply arm/select nothing — no crash, panel shows zero selected.

### Side panel: context detection and selection UI

`extension/sidepanel.js` gains a new branch of `detectContext()`: if the active tab's URL is `claude.ai/recents` (exact path, no wildcard — mirroring `isProjectsListingUrl`'s existing pattern), show **"Select Conversations"** and (once in selection mode) **"Select All"** and **"Confirm Selection (N)"** buttons, analogous to the existing `/projects` selection UI but as a distinct code path (separate module-level state, separate message types) rather than sharing state with project selection — the two contexts are mutually exclusive by URL, so there's no risk of overlap, but keeping them separate avoids one feature's bugs silently affecting the other.

Flow:
1. **Select Conversations clicked** → send `START_RECENTS_SELECTION_MODE`. Panel polls `GET_SELECTED_RECENTS_CONVERSATIONS` (same 500ms interval pattern as `/projects` selection) to keep a live "Confirm Selection (N)" count as the user clicks rows, and shows a **"Select All"** button alongside.
2. **Select All clicked** → send `SELECT_ALL_RECENTS_CONVERSATIONS`, show a status message (e.g. "Scrolling to load all conversations...") while it runs (this may take several seconds for a large history), then update the confirm button's count once the response returns.
3. **Confirm Selection clicked** → panel sends `GET_SELECTED_RECENTS_CONVERSATIONS` for the final list, then `STOP_RECENTS_SELECTION_MODE` to clean up the page, then begins the export.
4. **Export**, given the selected `{uuid, name}[]`:
   - `fetchAllConversations(orgId, selectedList, onProgress)` — reuses the existing batched-fetch helper exactly as project export does (it only needs `{uuid}` per item, which the selection already provides).
   - `buildArtifactsDataByUuid(orgId, conversations)` — reuses the existing helper (Task 2 of the prior project-conversation-artifacts plan) to extract artifact/uploaded-file data from each conversation's JSON, no navigation.
   - `captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, onProgress)` — reuses the existing helper to sequentially navigate to each conversation and scrape its image content files, status message adapted to this context (e.g. `"Capturing images N/Total: <name>..."`, same format already established).
   - After the navigation phase, best-effort navigate the tab back to `https://claude.ai/recents` (mirroring project export's "return to project page" behavior), then build and download the zip.
5. **New zip builder function** `buildConversationsSelectionZip(conversations, artifactsDataByUuid)` in `extension/lib/zipBuilder.js`: creates a root `JSZip`, writes an `index.md` (new markdown function, e.g. `createConversationsSelectionIndexMarkdown` in `extension/lib/markdown.js`, listing each conversation with a link to its folder — modeled on the existing `createIndexMarkdown` for projects but without project-specific fields), then calls the existing `buildConversationFolder(zip, folderName, conv, artifactsData)` for each conversation directly at the zip root (no project subfolder), and returns the generated blob. Downloaded as `conversations_selection_<count>.zip`.

   **Important divergence from `createIndexMarkdown`'s existing field access:** the selection each conversation object carries here only has `{uuid, name}` on `conv.metadata` (from the recents-page scrape) — unlike project export, where `conv.metadata` comes from the `conversations_v2` API and already includes `created_at`/`updated_at`/`model`. `createIndexMarkdown`'s existing sort/render logic reads `conv.metadata.updated_at`/`.created_at`/`.model` directly with no fallback, which would break (`undefined`/"Invalid Date") if reused as-is. `createConversationsSelectionIndexMarkdown` must instead read `conv.data.updated_at`/`conv.data.created_at`/`conv.data.model` (the full conversation JSON fetched by `fetchAllConversations`, always present once a conversation makes it into the `conversations` array passed in) — the exact same fallback source `convertToMarkdown` already uses (`data.created_at || metadata.created_at`) for the per-conversation file, just without the `metadata` half of the fallback since it isn't populated here.

### `manifest.json`

Add `"https://claude.ai/recents"` to the existing `content_scripts` entry's `matches` array (the one that already includes `claude.ai/project/*`, `claude.ai/chat/*`, `claude.ai/projects`), so `content.js` is injected there too.

## Error handling

Consistent with the rest of this extension:
- A conversation whose text fetch fails entirely (via `fetchAllConversations`'s existing per-item failure tolerance) is dropped from the export, same as project export already does — the final status message reports how many failed.
- A conversation whose Phase 2 (image navigation) fails keeps its Phase 1.5 (JSON-derived) data — only its image content files are missing, export continues.
- If the conversations table isn't found when starting selection mode, or `Select All`'s scroll loop finds zero rows, the panel shows an explicit message rather than proceeding with an empty export.
- If zero conversations end up successfully exported (all failed), no zip is generated, matching the equivalent safeguard already in multi-project batch export.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification against a live claude.ai session:
1. On `claude.ai/recents` with several conversations, click "Select Conversations", click 2-3 rows — confirm red borders appear/disappear correctly on toggle, and "Confirm Selection (N)" updates live.
2. Click "Select All" on an account with enough conversation history to require multiple lazy-load scroll triggers — confirm the page visibly scrolls, the count keeps growing until it stabilizes, and the final selected count matches the total number of conversations in the account.
3. Confirm with 2-3 selected conversations — confirm the tab navigates through each for image capture, a single `conversations_selection_<count>.zip` downloads, containing `index.md` plus one correctly-populated folder per conversation (text, artefacts, contenu including images).
4. Select a conversation, then deliberately test a failure path (e.g. observe behavior if a conversation fails to fetch) — confirm the export continues with the rest and reports the failure.
5. Confirm existing `/projects` selection and single-project/single-conversation export still work unaffected — regression check on shared code paths (`fetchAllConversations`, `buildArtifactsDataByUuid`, `captureProjectConversationImages`, `buildConversationFolder`).
6. Start a selection, navigate away from `/recents` before confirming — confirm the panel degrades gracefully (matches the established pattern for interrupted selection elsewhere in this extension).
