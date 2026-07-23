# Content Script Auto-Recovery — Design Spec

**Branch:** `feat/claude-gpt`
**Date:** 2026-07-24

## Problem

`extension/sidepanel.js` communicates with the active tab's content script (`content.js` on claude.ai,
`content-gpt.js` on chatgpt.com) via `chrome.tabs.sendMessage`. This throws whenever no content script is
listening in that tab — which happens whenever the tab was already open *before* the extension was installed
or last reloaded via `chrome://extensions`, since Manifest V3 only auto-injects `content_scripts` into tabs
that navigate/load *after* the extension becomes active. It is not a dropped connection to recover — the
content script was simply never injected into that already-open tab.

Today, every code path that hits this throws to a generic error message:
`"Could not start selection mode — try refreshing the page and reopening the panel."` — forcing the user to
manually reload the claude.ai/chatgpt.com tab (losing scroll position, any in-page state) just to make the
button work. This is avoidable: with `host_permissions` already covering `claude.ai/*` and `chatgpt.com/*`,
the extension can programmatically inject the missing content script into the active tab on demand, entirely
in the background, with no visible page reload.

## Goals

- Add the `scripting` permission and use `chrome.scripting.executeScript` to inject the correct content
  script (`content.js` or `content-gpt.js`) into the active tab, on demand, when a `sendMessage` call fails
  because no content script is present.
- Apply this recovery to the real entry-point call sites — the first `sendMessage` a given user-initiated
  flow makes — so the common "extension just reloaded, tab was already open" case resolves silently on the
  same click, without a manual page refresh.
- Fix a latent bug found while identifying entry points: `startGptSelection()` has no `try/catch` around its
  `sendMessage` call at all today (an unhandled rejection), unlike its Claude equivalent
  `enterSelectionMode()`.

## Non-goals

- No change to `sendMessage` calls that occur *inside* an already-running batch/export flow, where the
  content script was just injected moments earlier by the navigation immediately preceding that call (e.g.
  `captureProjectConversationImages`, `startBatchExport`'s per-project loop, `runGptBatch`'s per-project
  loop, `waitForContentScriptReady`'s own polling). A failure there signals a real problem — bad timing, a
  page that didn't load, navigation to the wrong page — that auto-recovery would mask rather than fix, and
  these call sites are already covered by existing `waitForContentScriptReady` polling or best-effort
  try/catch degradation.
- No change to the *content* of any error message shown to the user. If recovery is attempted and still
  fails, the existing message stays exactly as-is (e.g. `"Could not start selection mode — try refreshing
  the page and reopening the panel."`).
- No retry loop or exponential backoff — exactly one re-attempt after one injection attempt, per call site.
- No change to `content.js`/`content-gpt.js` themselves — they are injected as-is; recovery only fixes
  *whether* they're present, not their behavior once present.

## Design

### Mechanism: `sendMessageWithRecovery`

New helper in `extension/sidepanel.js`:

```js
async function sendMessageWithRecovery(tabId, message, contentScriptFile) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [contentScriptFile] });
    } catch (injectError) {
      throw e; // Injection itself failed (e.g. tab navigated away) — surface the original error.
    }
    return await chrome.tabs.sendMessage(tabId, message);
  }
}
```

- Fallback-after-failure, not ping-first: the fast path (content script already present — the normal case)
  costs nothing extra. Only the failure path (rare) pays for one injection attempt plus one retry.
- If the retry (`return await chrome.tabs.sendMessage(...)` on the last line) also throws, that exception
  propagates to the caller exactly as `chrome.tabs.sendMessage` throwing today would — every call site's
  existing `try/catch` and error message stay unchanged, satisfying the non-goal above.
- `chrome.scripting.executeScript` re-injecting a content script that's already running (a race where it was
  actually present but the first `sendMessage` failed for some other transient reason) is safe: both
  `content.js` and `content-gpt.js` are plain top-level scripts with no module-scope guard against
  double-injection today, but re-running them only re-declares the same functions/listeners — this is the
  same script Chrome would have run anyway on a manual page refresh, so behavior is identical to the
  documented user workaround.

### New permission

`extension/manifest.json`: add `"scripting"` to the `permissions` array (alongside the existing
`downloads`, `activeTab`, `cookies`, `sidePanel`, `tabs`). No new `host_permissions` needed — the existing
`https://claude.ai/*` and `https://chatgpt.com/*` entries already authorize script injection into those
origins.

### Call sites updated (the real entry points, confirmed by reading each function)

1. **`enterSelectionMode()`** (`sidepanel.js`, Claude project-list selection) — replace:
   ```js
   const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION_MODE' });
   ```
   with:
   ```js
   const response = await sendMessageWithRecovery(tab.id, { type: 'START_SELECTION_MODE' }, 'content.js');
   ```

2. **`enterRecentsSelectionMode()`** (`sidepanel.js`, Claude recents selection) — same pattern, `content.js`.

3. **`startGptSelection()`** (`sidepanel.js`, GPT project selection) — currently has **no try/catch at all**
   around its `sendMessage` call, an existing latent bug (an unhandled rejection if the content script is
   missing). This spec fixes it by wrapping the call in `sendMessageWithRecovery` (`content-gpt.js`) *and*
   adding a `try/catch` that shows a status error consistent with the Claude equivalents, since none exists
   today to preserve.

4. **`runExport()`** (`sidepanel.js`, Claude project/conversation export) — this function's first
   `sendMessage` is not literally its first statement; it occurs after `getOrganizationId()` and
   `fetchConversationsList()`/`fetchConversation()` succeed, at:
   - Project-mode branch: `GET_PROJECT_METADATA` (currently the call that populates `memory.md`/
     `instructions.md`).
   - Conversation-mode branch: `GET_CONVERSATION_ARTIFACTS` (currently the call that captures image content
     files).

   Both already have a `try/catch` that **degrades gracefully** today (proceeds without
   memory/instructions/images, sets `contentScriptUnreachable = true`, appends a warning to the final status
   message) rather than aborting the export. This spec wraps both calls in `sendMessageWithRecovery`
   (`content.js`) so that the common "extension just reloaded" case actually succeeds and the user gets their
   memory/instructions/images, instead of silently degrading every time until they manually refresh. The
   existing graceful-degradation `catch` block is preserved unchanged as the fallback if recovery itself
   fails.

5. **`gptScrapeProject()`** (`extension/lib/gptExport.js`) — the true entry point for GPT project export
   (`startGptProjectExport()` in `sidepanel.js` delegates here immediately). Its first `sendMessage` is
   `GET_GPT_PROJECT_METADATA`. Wrap this call in `sendMessageWithRecovery` (`content-gpt.js`). Since
   `sendMessageWithRecovery` is defined in `sidepanel.js` and `gptExport.js` is loaded as a separate
   `<script>` tag in `sidepanel.html` (both share the same global scope in this non-module extension, per
   existing convention — e.g. `gptExport.js` already calls `waitForContentScriptReady`, defined in
   `sidepanel.js`), no import/export plumbing is needed; `gptScrapeProject` can call
   `sendMessageWithRecovery` directly, exactly as it already calls other `sidepanel.js`-defined helpers.

### Call sites intentionally left unchanged (non-goal, listed for clarity)

- `captureProjectConversationImages` (`GET_CONVERSATION_ARTIFACTS` inside the per-conversation image-capture
  loop) — content script was just injected by the navigation immediately preceding this call within the same
  loop iteration; already has its own try/catch that skips just that conversation's images on failure.
- `startBatchExport`'s per-project loop (`GET_PROJECT_METADATA`) — same reasoning, plus
  `waitForContentScriptReady` already polls before this point.
- `runGptBatch`'s per-project loop (`GET_GPT_PROJECT_METADATA` via `gptScrapeProject`, `NAVIGATE_GPT_PROJECT`)
  — same reasoning.
- `confirmSelection`/`confirmRecentsSelection`/`confirmGptSelection`'s `GET_SELECTED_*`/`STOP_*_SELECTION_MODE`
  calls — these occur after selection mode was already successfully entered (meaning the content script was
  already confirmed present moments earlier in the same session), and cancelling/confirming should not incur
  extra injection latency.
- `cancelSelection`/`cancelRecentsSelection`'s `STOP_*_SELECTION_MODE` calls — same reasoning; these already
  have best-effort try/catch that doesn't block resetting local panel state.
- `selectAllRecents` (`SELECT_ALL_RECENTS_CONVERSATIONS`) — only reachable after
  `enterRecentsSelectionMode()` already succeeded, so the content script is already confirmed present.
- `pollSelectionCount`/`pollRecentsSelectionCount`'s `GET_SELECTED_*` polling calls — same reasoning, plus
  these already silently ignore failures (leaving the last known count displayed).

## Testing

Manual verification (no automated suite exists for this extension), extending the existing test list:

1. Simulate the failure condition: open a claude.ai project-listing tab, then reload the unpacked extension
   via `chrome://extensions` (without reloading the tab) — the tab's content script is now stale/detached.
   Click **Select Projects**. Confirm selection mode starts successfully (no error message), with the
   project cards' selection styling working normally — i.e., the fix actually recovers instead of erroring.
2. Repeat step 1 for **Select Conversations** on `claude.ai/recents`.
3. Repeat step 1 for **Select GPT Projects** on `chatgpt.com/projects`.
4. Repeat step 1 for **Export Project** on a claude.ai project page — confirm the exported zip's `index.md`
   includes Memory/Instructions (previously would have been silently missing until a manual refresh).
5. Repeat step 1 for **Export Conversation** on a claude.ai conversation page — confirm exported image
   content files are present in `contenu/`.
6. Repeat step 1 for **Export GPT Project** on a chatgpt.com project page.
7. Confirm the true-failure path still shows the existing error message: navigate to a page where the
   content script genuinely cannot run correctly (e.g. `claude.ai/projects` renamed/broken selectors, or a
   non-matching URL reached via a race) and confirm the panel still shows
   `"Could not start selection mode — try refreshing the page and reopening the panel."` rather than hanging
   or silently failing.
8. Confirm no regression to the batch/export flows explicitly left unchanged (multi-project batch, recents
   batch, GPT batch) — these should behave exactly as before this change.
