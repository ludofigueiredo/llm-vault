# Project Knowledge Files (fichiers/) — Design

**Date:** 2026-07-09
**Status:** Approved

## Context

Every project export creates an empty `fichiers/` placeholder, documented as a planned-but-unimplemented feature reserved for the project's uploaded knowledge files (distinct from a conversation's own artifacts/attachments). This is the last unimplemented piece of the export structure.

A captured DOM snapshot of a project page confirms the "Fichiers" section (project knowledge files) lives directly on the project page, structured identically to a conversation's "Contenu" section: a `<h3>Fichiers</h3>` heading followed by a `<ul>` of thumbnail entries, each `<div data-testid="{filename}">` wrapping a `<button><img alt="{filename}" src="/api/{orgId}/files/{fileId}/preview"></button>`. A live test confirmed this `/preview` URL serves the actual file content directly (opening it in a new tab downloads/displays the real file), for an image file.

## Goals

1. Scrape the project page's "Fichiers" section for every image file's `{filename, url}` pair, the same way `scrapeImageContentFiles()` already does for a conversation's "Contenu" section.
2. Thread this data through the existing `GET_PROJECT_METADATA` message/response (already sent once per project export) rather than introducing a new message type — add a `files` field alongside the existing `memory`/`instructions`.
3. `buildProjectZip` fetches every scraped file into `fichiers/`, reusing the existing `fetchFilesInto()` helper (already shared by `artefacts/`/`contenu/`).
4. Works identically for single-project export and multi-project batch export, consistent with every other per-project capture mechanism in this extension.
5. Graceful degradation: a missing "Fichiers" section, a failed individual fetch, or the content script being unreachable never fails the overall export — `fichiers/` simply stays (partially) empty, same as every other capture mechanism here.

## Non-goals

- Non-image files in the project's "Fichiers" section (e.g. `.docx`, `.pdf`) are explicitly out of scope for this iteration — their download URL/mechanism hasn't been confirmed live (unlike images' `/preview` URL, which has). A future iteration can extend this once that's confirmed.
- No navigation is introduced — the project page is already open for `GET_PROJECT_METADATA`, and the "Fichiers" section lives on that same page, so this reuses the same DOM visit.
- No change to `artefacts/`/`contenu/` (conversation-level capture) — those are unrelated to this project-level "Fichiers" section.

## Architecture

### `extension/content.js`: scrape project files

New function `scrapeProjectFiles()`, modeled directly on the existing `scrapeImageContentFiles()` in `content.js` (same `<img alt src>` scraping shape — see that function for the closest precedent): finds the "Fichiers" `<h3>` heading (exact text match, French UI, no i18n — consistent with `extractSectionText`'s existing precedent for "Mémoire"/"Instructions"), locates its `<ul>` of thumbnail entries, and for each `<img alt src>` inside, returns `{filename: alt, url: new URL(src, window.location.origin).href}` — skipping entries missing either attribute.

`getProjectMetadata()` (the function backing the `GET_PROJECT_METADATA` message) gains a third field:

```javascript
function getProjectMetadata() {
  return {
    memory: extractSectionText('Mémoire'),
    instructions: extractSectionText('Instructions'),
    files: scrapeProjectFiles()
  };
}
```

No new message type — `sidepanel.js` already sends `GET_PROJECT_METADATA` once per project export (both single-project `runExport()` and each project in `startBatchExport()`'s loop) and already has a `try/catch` around it that degrades gracefully (`contentScriptUnreachable` flag) if the content script isn't reachable. `files` defaults to `[]` the same way `memory`/`instructions` default to `null` when scraping finds nothing or the section is absent.

### `extension/lib/zipBuilder.js`: populate `fichiers/`

`buildProjectZip` currently does:
```javascript
target.folder('fichiers').file('.gitkeep', '');
```

This becomes:
```javascript
const fichiersFolder = target.folder('fichiers');
const projectFiles = (projectMetadata && projectMetadata.files) || [];
await fetchFilesInto(fichiersFolder, projectFiles);
```

`fetchFilesInto()` (already defined in this file, used by `artefacts/`/`contenu/`) already handles the empty-list-falls-back-to-`.gitkeep` behavior, individual fetch failures, and `credentials: 'include'` — no changes needed to it.

### No changes needed in `sidepanel.js`

`projectMetadata` (the `GET_PROJECT_METADATA` response) is already passed as-is into `buildProjectZip` at both call sites (`runExport()`'s project branch, `startBatchExport()`'s per-project loop) — since `files` is just a new field on that same object, no call-site changes are required. This is purely a `content.js` + `zipBuilder.js` change.

## Error handling

Consistent with every other capture mechanism in this extension:
- "Fichiers" heading not found on the page → `scrapeProjectFiles()` returns `[]`, `fichiers/` gets its `.gitkeep` placeholder, no error surfaced.
- Content script unreachable entirely → existing `contentScriptUnreachable` handling in `sidepanel.js` already covers this (project export proceeds without memory/instructions/files, with the existing warning message in the final status).
- An individual file's fetch fails (network error, non-200) → skipped, `fetchFilesInto()`'s existing per-file try/catch handles it; `fichiers/` still gets whatever succeeded.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification against a live claude.ai session:
1. Single-project export on a project with 1+ image files in its "Fichiers" (project knowledge) section — confirm `fichiers/` contains them with correct filenames and viewable content.
2. A project with zero files in "Fichiers" — confirm `fichiers/` stays an empty `.gitkeep` placeholder, no errors.
3. Multi-project batch export — confirm every selected project's `fichiers/` is populated correctly, independent of the others.
4. A project whose "Fichiers" section has both image and non-image files — confirm only the image(s) end up in `fichiers/` (non-image silently skipped, per Non-goals), and the export doesn't fail or warn about the skipped non-image file.
