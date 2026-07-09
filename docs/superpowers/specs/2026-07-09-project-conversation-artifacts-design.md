# Per-Conversation Artifacts & Content in Project Export — Design

**Date:** 2026-07-09
**Status:** Approved

## Context

Single-conversation export already populates `artefacts/` (Claude-generated artifacts, via `wiggle/download-file` URLs built from file paths found in the conversation's own JSON) and `contenu/` (attached files — non-image files the same way, image files scraped from the DOM's "Contenu" section).

Project export (`buildProjectZip`) fetches every conversation's JSON via the existing batched API pipeline (`fetchConversationsList` + `fetchAllConversations`), but leaves `artefacts/`/`contenu/` empty for every conversation — this per-conversation capture was scoped to single-conversation export only, since it originally required DOM interaction only possible while that conversation's page was open.

That's no longer entirely true: `extractFilePaths()` (added in the single-conversation fix) derives artifact and uploaded-file download URLs directly from each conversation's JSON — no DOM needed. The only remaining DOM-only piece is image content files' `/preview` URLs, which aren't derivable from a `/mnt/user-data` path and require the conversation's own page to be open to scrape.

This feature extends project export (single-project and multi-project batch alike) to populate `artefacts/` and `contenu/` for every conversation in the export, using the same two-source approach: JSON-derived paths for artifacts/non-image files (no navigation needed), and one DOM visit per conversation for image content files.

## Goals

1. During a project export (single-project `runExport()` or multi-project `startBatchExport()`), after each conversation's JSON is fetched, extract its artifact/uploaded-file paths via `extractFilePaths()` (already used for single-conversation export) and build `artefacts/`/`contenu/` entries from them — no additional navigation required for this part.
2. Additionally, navigate the active tab to each conversation in turn (`claude.ai/chat/{uuid}`), wait for its content script to be ready, and scrape its "Contenu" section for image attachment URLs — merging them into that conversation's `contenu/` entries.
3. After the last conversation (of the last project, in a batch), navigate the active tab back to the project page it started from (single-project export) or leave it wherever the existing batch loop's own logic puts it between projects (batch export continues to the next project's own navigation regardless).
4. Status messages during this phase: `"Capturing images N/Total: <conversation name>..."`, consistent with the existing batch multi-project status pattern.
5. A conversation whose navigation/scrape fails (timeout, page didn't load) keeps whatever it already got from its JSON (text, artefacts, non-image content files) — only its image content files are skipped. This does not fail the conversation's inclusion in the export, nor the overall project/batch export.
6. Applies uniformly to both single-project export and multi-project batch export, since both already converge on `buildProjectZip`.

## Non-goals

- No user-facing toggle to skip image scraping for speed — the slower, more complete behavior is the only mode (explicitly accepted trade-off).
- No parallelization of the navigation phase — conversations are visited strictly one at a time in the same tab, consistent with every other navigation-based mechanism in this extension (multi-project batch, single-project metadata capture).
- No change to Phase 1 (the existing batched JSON fetch) — it keeps its existing concurrency (5 at a time) and rate-limit handling exactly as-is.
- No change to `fichiers/` (project knowledge files) — still an empty placeholder, unrelated to this feature.

## Architecture

### Two-phase project export

For a given project (whether from single-project `runExport()` or one iteration of batch export's per-project loop):

**Phase 1 (existing, unchanged):** `fetchConversationsList` + `fetchAllConversations` retrieve every conversation's full JSON, batched 5 at a time with existing rate-limit backoff. `memory.md`/`instructions.md` are captured via the existing `GET_PROJECT_METADATA` message to the project page's content script, exactly as today.

**Phase 1.5 (new, no navigation):** For each fetched conversation, `extractFilePaths(conversationData)` (moved from being single-conversation-export-only into a shared location — see File Changes) derives its artifact (`/mnt/user-data/outputs/`) and uploaded-file (`/mnt/user-data/uploads/`) paths, and builds their `download-file` URLs exactly as single-conversation export does. This produces each conversation's `artifactFiles` and (partial, non-image) `contentFiles` lists without any navigation.

**Phase 2 (new, sequential navigation):** For each conversation in the project (in the same order they'll be zipped), the active tab navigates to `claude.ai/chat/{uuid}`, waits (bounded, reusing `waitForContentScriptReady`) for that page's content script to respond to `PING` with a matching pathname, then sends `GET_CONVERSATION_ARTIFACTS` (now image-only, per the prior fix) and merges the returned `contentFiles` (image entries) into that conversation's existing `contentFiles` list from Phase 1.5. Status updates as `"Capturing images N/Total: <name>..."`. A failure at any step (navigation timeout, unresponsive content script) is caught and that conversation simply keeps its Phase 1.5 content files — the loop continues to the next conversation.

**Phase 3 (build):** `buildProjectZip` is called exactly as today, except each conversation's `artifactsData` (previously always `{artifactFiles: [], contentFiles: []}` for project export) is now the real per-conversation data assembled in Phases 1.5/2.

**End of export:** after Phase 2's loop completes for a project, the active tab navigates back to that project's own page (`claude.ai/project/{id}`) before the zip is generated (single-project export) or before the batch loop moves on to the next project's own navigation (batch export — the next project's Phase 1 navigation will overwrite this anyway, so returning to the *current* project's page between its Phase 2 and the next project's Phase 1 is a no-op in practice for batches, but keeps single-project export's existing "return to where you started" behavior consistent).

### Data flow change: `artifactsData` becomes per-conversation, indexed

Today, `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata)` calls `buildConversationFolder(target, folderName, conv)` — no `artifactsData` argument, so `buildConversationFolder` always falls into its `artifactsData` being `undefined`, producing empty `artefacts/`/`contenu/`.

`buildProjectZip`'s signature gains one parameter: `buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata, artifactsDataByUuid)`, where `artifactsDataByUuid` is a `Map<string, {artifactFiles, contentFiles}>` keyed by conversation UUID (built by the caller across Phases 1.5/2, keyed off each conversation's `conv.metadata.uuid`, matching the existing `{metadata, data}` shape each conversation already has — see `extension/lib/api.js`'s `fetchAllConversations`). For each conversation, `buildProjectZip` looks up its entry via `conv.metadata.uuid` (falling back to `{artifactFiles: [], contentFiles: []}` if missing — e.g. a conversation that somehow isn't in the map) and passes it to `buildConversationFolder`, exactly as single-conversation export already does.

This keeps `buildConversationFolder` itself completely unchanged — it already accepts an `artifactsData` parameter and handles it correctly; project export was simply never passing one.

### `extractFilePaths` becomes shared

Currently defined in `sidepanel.js`, used only by single-conversation export's branch of `runExport()`. It has no dependency on `sidepanel.js`-specific state (it's a pure function over a conversation JSON object) — moving it to `extension/lib/api.js` (alongside the other conversation-JSON-consuming functions) makes it available to both the single-conversation branch and the new project-export Phase 1.5 logic without duplication. `orgId`/conversation-UUID-dependent URL-building stays inline at each call site (single-conversation export, project export Phase 1.5, batch export Phase 1.5) since those need the specific conversation's UUID, which `extractFilePaths` itself doesn't need (it only reads paths out of the JSON).

### Batch export integration

`startBatchExport(projects)`'s existing per-project loop already does: navigate to project → fetch conversations list → fetch metadata → `fetchAllConversations` → `buildProjectZip`. This feature inserts Phase 1.5 (pure, no navigation) right after `fetchAllConversations`, and Phase 2 (navigation per conversation) right before that project's `buildProjectZip` call — reusing the same `tabId` the batch loop already holds. The per-project `try/catch` already in place means a project that fails entirely (e.g. its own navigation times out) behaves exactly as today; a project that succeeds but has one conversation whose Phase 2 navigation fails just has that one conversation's images missing, per Goal 5.

## Error handling

- Consistent with the rest of the extension: a conversation's Phase 2 failure (navigation timeout, content script unreachable) is caught, logged into that conversation's absence of image content files, and does not abort the conversation's Phase 1.5 data, the project's export, or (in batch mode) the rest of the batch.
- If Phase 2 fails for every conversation in a project (e.g. some project-wide navigation issue), the project export still succeeds with text/artefacts/uploaded-files populated and only images missing — same graceful-degradation spirit as every other capture mechanism in this extension.
- The final "return to project page" navigation is best-effort — if it fails, the export has already completed successfully (the zip download isn't gated on it), so it's fire-and-forget with no user-facing error.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification against a live claude.ai session:
1. Single-project export on a project with 2-3 conversations, at least one with a Claude-generated artifact, one with an uploaded image, one with an uploaded non-image file (e.g. `.pptx`) — confirm all three end up in the right conversation's `artefacts/`/`contenu/` in the final zip, and the tab visibly navigates through each conversation before returning to the project page.
2. A project with a conversation that has no artifacts/attachments at all — confirm its folders stay empty (`.gitkeep`) without errors.
3. Multi-project batch export with 2 selected projects, each with a couple of conversations — confirm every conversation across both projects gets its images, and the status messages show both project-level and conversation-level progress correctly.
4. Close the side panel mid-export (during Phase 2) — confirm the same "batch does not resume" behavior already documented for this extension, no crash.
5. A conversation whose page fails to load in time during Phase 2 (simulate by being on a very slow connection, or by closing the tab briefly) — confirm the export still completes, that conversation's artefacts/non-image content files are still present (from Phase 1.5), only its images are missing.
