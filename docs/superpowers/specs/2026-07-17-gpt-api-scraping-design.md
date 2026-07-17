# GPT API-based Scraping — Design Spec

**Date:** 2026-07-17
**Status:** Approved for planning
**Branch:** `feat/gpt-export` (continues the existing GPT export work)
**Supersedes:** the conversation-thread DOM scraping from `2026-07-16-gpt-export-design.md` (that spec's DOM approach for *conversation content* is replaced here; its project detection, multi-project selection, instructions scraping, and output structure remain).

## 1. Goal

Replace the DOM-scraping of ChatGPT conversation **content** with calls to ChatGPT's internal REST API (`/backend-api`), which returns each conversation's full JSON (the `mapping` tree) and provides authenticated file downloads for **all** file types. This eliminates the fragile parts of the current pipeline (thread auto-scroll, virtualization, brittle message selectors) and resolves the "non-image files not downloaded" limitation.

The trigger for this change: a working console script proved chatgpt.com exposes a usable internal API — session token via `GET /api/auth/session`, conversation list via `GET /backend-api/conversations`, full conversation JSON via `GET /backend-api/conversation/{id}`, and file downloads via `GET /backend-api/files/download/{fileId}`.

## 2. Guiding principle: DOM where it's the only reliable source, API for everything else

| Data | Source | Rationale |
|---|---|---|
| Project→conversation linkage (the list of a project's `convId`s) | **DOM** (project page `<a href=".../c/<convId>">`) | The API's conversation list is account-wide; the DOM is the only confirmed project-scoped source. |
| Project instructions | **DOM** (settings popover) | Not exposed by the API endpoints in use. |
| Conversation **content** (messages, roles, order) | **API** `GET /backend-api/conversation/{convId}` → `mapping` JSON | Far more reliable than scraping rendered HTML; no virtualization. |
| Files (images + docx/pdf/xlsx/…) | **API** `GET /backend-api/files/download/{fileId}` | Authenticated download of every file type. |

## 3. Where the API calls run

All `/backend-api` and `/api/auth/session` calls run in the **content script** (`content-gpt.js`), which executes in the `chatgpt.com` page context and therefore has session cookies and access to `/api/auth/session`. The side panel (isolated extension context) cannot make these calls directly; it messages the content script and receives results, exactly like the rest of the GPT pipeline.

Per-conversation navigation (`chrome.tabs.update` to each conversation page) is **kept** (user decision): it guarantees a live GPT content script is injected on a chatgpt.com page when the API call is made, and keeps token/session handling entirely in the page context. (Trade-off acknowledged: this forgoes the speed/robustness gain of a navigation-free loop.)

## 4. API access (new, in `content-gpt.js`)

- `gptGetSessionToken()` — `fetch('/api/auth/session', {credentials:'include'})` → `json.accessToken`; cached for the duration of the export (module-level variable) to avoid re-fetching per conversation. Throws if no `accessToken` (blocking condition — nothing works without it).
- `gptApiGet(path, token)` — `fetch('/backend-api/'+path, {headers, credentials:'include'})` where headers = `{Content-Type, Accept, Authorization: 'Bearer '+token, 'Oai-Device-Id': <uuid>, 'Oai-Language': 'en-US'}`. The `Oai-Device-Id` is a single `crypto.randomUUID()` generated once per export. Throws on `!resp.ok`.

## 5. Conversation flow (per conversation, content script already on the conv page)

1. `GET /backend-api/conversation/{convId}` → full JSON (`mapping`).
2. `extractFileReferences(convo)` → `[{fileId, filename, type}]` — from `image_asset_pointer` parts (match `file-service://` or `sediment://`), `metadata.attachments` (`id`/`name`), and `metadata.citations` (`metadata.file_id`/`title`); de-duplicated by fileId. (Ported from the console script.)
3. For each fileId: `GET /backend-api/files/download/{fileId}` → `download_url`; the content script **fetches the bytes itself** (it has the token/context), deriving the filename from `meta.file_name` (or the reference's fallback name) and appending an extension from the response `content-type` when missing (`MIME_TO_EXT` map, ported from the script). Filenames de-duplicated via `deduplicateFilename`.
4. `mappingToTurns(convo, fileMap)` → `[{role, markdown}]` for `conversation.md`.

**New content-script message:** `GET_GPT_CONVERSATION_VIA_API` (`{convId}`) → returns `{title, createTime, turns:[{role, markdown}], files:[{filename, bytesBase64}]}`. Replaces the old `GET_GPT_CONVERSATION`.

**Binary transfer:** `chrome.runtime.sendMessage` serializes to JSON, so file bytes are transferred as **base64** strings (`bytesBase64`); the panel decodes them (base64 → `Uint8Array`) before `folder.file(filename, bytes)`.

## 6. Mapping → markdown (`mappingToTurns`, faithful to the console script)

- **Tree walk** from the root node (`parent == null`), a queue over `children` — reproduces true chronological order.
- **Role filtering:** emit `user` and `assistant` (text). **Skip** `system`, `tool`, and assistant messages whose `content_type !== "text"` (internal reasoning / tool output) — as in the script's `toMarkdown`.
- **Parts:** a string → text as-is; `image_asset_pointer` → `![image](contenu-gpt/<file>)` when the fileId is in `fileMap`, else `[image]`; any other part → `JSON.stringify(part)` (fallback).
- **Attachments** (`msg.metadata.attachments`) → `📎 [<name>](contenu-gpt/<file>)`.
- **Citations** stripped from text via `stripCitations` (removes `【…】` spans).
- Each emitted message becomes `## Vous` (user) / `## ChatGPT` (assistant) + its markdown, matching the current French headings.

The assistant `parts` already contain **source markdown**, so it is written as-is — no HTML→markdown conversion is needed.

**File links in markdown** point to `contenu-gpt/<filename>` (relative to `conversation.md`, which sits in the same conversation folder). The script's `fileMap` (which used `../files/...`) is adapted to this structure: `fileMap[fileId] = 'contenu-gpt/' + <deduped filename>`.

## 7. Output structure (unchanged from the DOM spec)

Single project → `gpt_project_<name>.zip`:
```
index.md
instructions.md              (only if instructions non-empty)
<conv-title>_<convId8>/
    conversation.md          (parsed from the mapping JSON)
    contenu-gpt/             (ALL files via API; .gitkeep if none/all failed)
```
Multi-project batch → `gpt_projects_batch_<count>.zip`, one folder per project. Identical to the current behavior.

## 8. Delta vs current code

| File | Change |
|---|---|
| `content-gpt.js` | **Add:** `gptGetSessionToken`, `gptApiGet`, `extractFileReferences`, `downloadFileViaApi`, `deduplicateFilename`, `stripCitations`, `mappingToTurns`, `MIME_TO_EXT`, and the `GET_GPT_CONVERSATION_VIA_API` handler. **Remove:** `gptFindTurns`, `gptWaitForThreadToStabilize`, `gptScrapeTurn`, `gptScrapeThreadImages`, and the old `GET_GPT_CONVERSATION` handler. **Keep:** instructions scraping (settings popover, incl. the intermediate menu step), project conversation-list scraping, multi-project selection. |
| `gptExport.js` | `gptScrapeProject` sends `GET_GPT_CONVERSATION_VIA_API`; receives `{title, turns, files}`. `gptBuildProjectInto`/`gptBuildConversationFolder` decode base64 file bytes and write them into `contenu-gpt/` (no longer via URL-fetch, since bytes arrive from the content script). |
| `gptMarkdown.js` | `gptTurnsToMarkdown` writes `turn.markdown` as-is (turns are `{role, markdown}`). **Remove** `gptHtmlToMarkdown` and its unit test (dead once content comes from JSON). Keep `gptInstructionsMarkdown`, `gptIndexMarkdown`, `gptConvFolderName`, `gptSanitizeFilename`. |
| `manifest.json` | No change (already `chatgpt.com/*`; API calls are same-origin from the page context). |
| `sidepanel.js` | No logic change (flow unchanged: select → navigate → message content script → build zip). |

## 9. Error handling

- **No token** (`/api/auth/session` has no `accessToken`) → export fails with an explicit "ChatGPT session not found — are you logged in?" message. Blocking.
- **A `conversation/{id}` call fails** → that conversation is counted failed and skipped; the project export continues (as today).
- **A file fails** (`files/download` or the binary fetch) → that file is skipped; the conversation continues; `contenu-gpt/` falls back to `.gitkeep` if every file failed.
- **Rate limiting:** a short delay between conversations and between file downloads (the script used 500ms), consistent with the existing Claude batching.
- Existing guardrails preserved: `batchInProgress`, `detectContext` re-entry guard, batch name-mismatch guardrail, partial-failure tolerance, no zip if every project fails.

## 10. Out of scope (unchanged)

- Standalone (non-project) GPT conversations — still not exported (the project-scoped `convId` list comes from the project page DOM).
- Discovering a project's conversations via the API (would require a confirmed project-filter field/endpoint; the DOM list remains the source of truth).
- The account-wide conversation list endpoint (`/backend-api/conversations`) is not used — export stays project-scoped.
