# Project Memory & Instructions Export — Design

**Date:** 2026-07-07
**Status:** Approved

## Context

The Chrome extension (built in a prior phase, see `docs/superpowers/specs/2026-07-07-chrome-extension-design.md` and `docs/superpowers/plans/2026-07-07-chrome-extension.md`) currently exports a Claude Project's conversations as a `.zip` with `index.md` + one folder per conversation. It does not capture two other pieces of project-level context that are visible on the project page itself:

- **Memory** ("Mémoire" section) — a free-text summary Claude maintains about the project (purpose, context, current state, learnings).
- **Instructions** — the project's custom instructions text.

Neither of these is exposed through the REST API endpoints the extension already uses (`conversations_v2`, `chat_conversations/{id}`). They only exist rendered in the project page's DOM. A third section, **Files** ("Fichiers" — project knowledge documents uploaded by the user), is visible on the same page but downloading their actual content requires a REST endpoint that has not yet been confirmed to exist; that part is deferred (see Non-goals).

## Goals

1. When exporting a Project, also capture the Memory and Instructions text from the currently-open project page's DOM and include them in the output zip as `memory.md` and `instructions.md`, alongside the existing `index.md`.
2. Add an empty `fichiers/` folder at the zip root (placeholder, same pattern as the existing per-conversation `artefacts/`/`contenu/` placeholders) reserving the location for a future phase that will populate it with real file downloads.
3. Degrade gracefully: if Memory/Instructions can't be found in the DOM (page not fully loaded, selectors no longer match after a claude.ai UI change, or the section is genuinely absent because the project doesn't have one configured), the export must still succeed — it just omits the corresponding `.md` file and does not error out.

## Non-goals (explicitly out of scope for this phase)

- Downloading the actual content of project files ("Fichiers" section). The thumbnail URL seen in the page (`/api/[org]/files/[uuid]/preview`) is a preview image, not confirmed to serve original file bytes. Finding and calling the correct download endpoint is deferred to a later phase.
- Any change to single-conversation export (`buildConversationZip`) — Memory/Instructions/Files are project-level concepts only, a standalone conversation has none of them.
- Verifying against a real claude.ai session in this design/implementation pass — the implementer works in a sandboxed environment with no real Chrome browser. The DOM selectors are based on a captured HTML snapshot of a real project page; live verification against claude.ai is a follow-up step for the user to perform after implementation (see Known risk below).

## Known risk: DOM truncation

The captured HTML snapshot shows the Memory paragraph's full text present in the DOM (`<p class="... line-clamp-2">`) even though `line-clamp-2` visually truncates it to 2 lines — meaning in the snapshot's case, the truncation is purely CSS (`-webkit-line-clamp`), and `textContent` of that element yields the complete text. It's possible claude.ai only populates the full text after a "see more" UI interaction in some states (JS-level truncation, not just CSS). This cannot be verified in the sandboxed implementation environment. The implementation proceeds on the assumption that the full text is present in the DOM at page load (matching the captured snapshot), and the user will confirm this against a real project page after implementation; no special "click show more" automation is built for this phase.

## Architecture

### New file: `extension/content.js`

A content script injected automatically into `https://claude.ai/project/*` pages (declared via `manifest.json`'s `content_scripts`). Responsibilities:

- On being asked (via a runtime message, not on load — avoids doing work when the popup never asks), scan the current page's DOM for the Memory and Instructions sections and extract their text.
- Both sections follow the same DOM shape in the captured snapshot: an `<h3>` containing (or exactly equal to, after trimming) the section's label text ("Mémoire" / "Instructions"), inside a container `<div>` that also holds a sibling `<p class="text-text-500 font-small ...">` with the actual content. The extraction walks from the `<h3>` up to a reasonable ancestor container, then finds the first `<p>` within that container.
- Because `<h3>` for Memory wraps the label in a nested `<div>` (`<h3><div>Mémoire</div></h3>`) while Instructions has the label as the `<h3>`'s direct text, the selector logic matches on the `<h3>`'s trimmed `textContent` rather than assuming a fixed nesting depth.
- Responds to a `chrome.runtime.onMessage` listener for a `{type: 'GET_PROJECT_METADATA'}` request with `{memory: string|null, instructions: string|null}`. Returns `null` for either field it can't find, never throws.

### Modified: `extension/manifest.json`

Add:
```json
"content_scripts": [
  {
    "matches": ["https://claude.ai/project/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }
]
```

No new permissions needed — `content_scripts` doesn't require a permission entry beyond the existing `host_permissions` for `https://claude.ai/*`, which is already present.

### Modified: `extension/popup.js`

In `runExport()`'s `project` branch, after `orgId` is resolved and before/around the conversations fetch, send a message to the active tab's content script:

```javascript
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let projectMetadata = { memory: null, instructions: null };
try {
  projectMetadata = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_METADATA' });
} catch (e) {
  // Content script not present/responsive — proceed without memory/instructions.
}
```

This call is wrapped in try/catch because `chrome.tabs.sendMessage` rejects if no content script is listening (e.g., page hasn't finished loading, or somehow the content script failed to inject) — this must never abort the export.

`projectMetadata` is passed into `buildProjectZip` (signature extended, see below).

### Modified: `extension/lib/zipBuilder.js`

`buildProjectZip` gains a new parameter for the scraped metadata:

```javascript
async function buildProjectZip(projectId, conversations, projectMetadata) {
  const zip = new JSZip();
  zip.file('index.md', createIndexMarkdown(projectId, conversations));

  if (projectMetadata && projectMetadata.memory) {
    zip.file('memory.md', projectMetadata.memory);
  }
  if (projectMetadata && projectMetadata.instructions) {
    zip.file('instructions.md', projectMetadata.instructions);
  }
  zip.folder('fichiers').file('.gitkeep', '');

  conversations.forEach(conv => {
    const folderName = conversationFolderName(conv);
    buildConversationFolder(zip, folderName, conv);
  });

  return zip.generateAsync({ type: 'blob' });
}
```

`projectMetadata` is optional (defaults effectively to "add nothing") so existing call patterns/tests that don't pass it still work — but the only real caller (`popup.js`) is updated to always pass it.

### Output structure (project export, updated)

```
index.md
memory.md              <- new, only if Memory section found
instructions.md        <- new, only if Instructions section found
fichiers/               <- new, empty placeholder (like artefacts/ and contenu/)
  .gitkeep
conversation-title_<uuid8>/
  conversation.md
  artefacts/
  contenu/
...
```

Single-conversation export is unchanged.

## Error handling

- Content script not injected / not responding: `popup.js` catches the rejected `sendMessage` promise, treats memory/instructions as absent, continues the export normally. No user-facing error — this is an expected, silent degradation path.
- Content script injected but selectors don't match (DOM structure changed, or project genuinely has no Memory/Instructions configured): content script returns `{memory: null, instructions: null}` (or one field null), same downstream handling — no `.md` file added for the missing field(s).
- The export's overall success/failure status message is unaffected by whether memory/instructions were found — this is considered enrichment, not a required part of a successful export.

## Testing approach

Same manual-verification approach as the rest of this project (no automated test suite, per existing CLAUDE.md conventions). Covering:
1. A real project with both a Memory summary and custom Instructions configured — confirm both `.md` files appear in the output zip with complete (non-truncated) text.
2. A project with no Instructions configured (many projects don't set this) — confirm the zip omits `instructions.md` cleanly, no error shown to the user.
3. A project with a very long Memory text (like the captured snapshot's example) — confirm the full text is captured, not just the visually-truncated 2 lines (this directly tests the Known Risk above).
4. Rapid export click right after page load (before content script may have fully initialized) — confirm export still completes, possibly without memory/instructions, without hanging or erroring.

## Phase 2 (future, not part of this implementation)

- Locate and call the real file-download endpoint for the "Fichiers" project knowledge documents, and populate `fichiers/` with actual downloaded content (mirroring how `artefacts/`/`contenu/` are reserved for a similar future phase on the conversation side).
