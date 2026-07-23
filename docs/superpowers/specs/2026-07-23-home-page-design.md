# Home Page Redesign — Design Spec

**Branch:** `feat/claude-gpt`
**Date:** 2026-07-23

## Problem

The side panel's top section (`.intro` block in `extension/sidepanel.html`) currently shows a static
paragraph of text ("Export your Claude projects and conversations...") with no call to action. When the
active tab isn't on claude.ai or chatgpt.com in an exportable state, the contextual panel below just shows
a passive message ("Navigate to a Claude project... or conversation... page to export it.") — the user has
to know to manually type a URL. There's no single place that explains what the extension does for both
supported providers, and no shortcut to get to either site.

## Goals

- Give the panel a real "home" section that explains the extension's value (exporting Claude and ChatGPT
  conversations to structured Markdown/zip) in 2-3 sentences.
- Provide two buttons, "Open Claude" and "Open ChatGPT", that navigate the active tab directly to the
  respective site.
- Keep this home section visible at all times (not just when no context is detected), at a constant size,
  as a permanent header above the existing contextual panel.

## Non-goals

- No changes to `detectContext()`, the export pipelines, or any provider-specific logic.
- No change to the sizing/behavior of the contextual panel below (project/conversation detection, selection
  modes, export flows) — it continues to work exactly as today.
- No i18n — copy is in English, matching the rest of the UI (`extension/sidepanel.html` is already English
  aside from `content.js`'s French-only DOM scraping selectors, which are unrelated).

## Design

### HTML structure (`extension/sidepanel.html`)

Replace the current `.intro` block:

```html
<div class="intro">
  <p class="intro-title">LLM Vault</p>
  <p class="intro-body">Export your Claude projects and conversations as organized Markdown files. ...</p>
</div>
```

with a `.home` block:

```html
<div class="home">
  <p class="home-title">LLM Vault</p>
  <p class="home-body">
    Turn your Claude and ChatGPT conversations into organized, portable Markdown — projects, individual
    chats, attachments and generated files all included in a single zip. Keep a permanent, searchable
    archive of your work that lives outside any one provider's dashboard.
  </p>
  <div class="home-actions">
    <button id="goto-claude-btn" type="button">Open Claude</button>
    <button id="goto-gpt-btn" type="button">Open ChatGPT</button>
  </div>
</div>
```

The existing `.panel` block (context message + contextual buttons + status) is unchanged and stays below
the `.home` block, in the same document position it occupies today.

### Styling

- Reuse existing tokens (`--text-primary`, `--text-secondary`, `--radius-*`, existing `button` base styles)
  rather than introducing new ones.
- `.home-actions` lays the two buttons out side by side (`display: flex; gap: 8px;`), each `flex: 1`, since
  they're peers (not a primary/secondary pair like the existing stacked buttons) — this deviates from the
  default stacked-button styling (`button + button { margin-top: 10px }`), so `.home-actions button` needs
  its own rule to sit side by side instead of stacking.
- No new color tokens: both buttons use the existing solid `--accent`/`--accent-text` button styling used
  elsewhere (e.g. `#export-btn`), since they're equally-weighted actions, not a primary/confirm pair.

### Behavior (`extension/sidepanel.js`)

Add two click listeners alongside the existing ones registered in the `DOMContentLoaded` handler:

```js
document.getElementById('goto-claude-btn').addEventListener('click', () => {
  gotoSite('https://claude.ai');
});
document.getElementById('goto-gpt-btn').addEventListener('click', () => {
  gotoSite('https://chatgpt.com');
});
```

```js
async function gotoSite(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.update(tab.id, { url });
}
```

No manual call to `detectContext()` is needed after navigation: the existing `chrome.tabs.onUpdated`
listener (already wired up for re-detection on navigation within the same tab) fires once the new page
loads and re-runs `detectContext()` on its own.

These buttons work regardless of current context — including while `selectionMode`, `batchInProgress`, or
`recentsSelectionMode` is active. This is an accepted edge case: navigating away mid-selection/mid-batch
already has existing (if imperfect) handling via `detectContext()`'s early-return guard for those flags, and
clicking "Open Claude" while already engaged in a Claude-side batch is a user-initiated abandonment of that
flow, no different from the user manually typing a new URL today.

### Out of scope for this spec

- No "back to home" affordance is needed since the home section is always visible.
- No loading/disabled state on the two buttons — `chrome.tabs.update` is fire-and-forget from the panel's
  perspective; the panel's own `detectContext()` re-render (triggered by `onUpdated`) is what reflects the
  new state once the destination page loads.

## Testing

Manual verification (no automated suite exists for this extension):

1. Open the side panel on an unrelated page (e.g. `https://example.com`) — confirm the home block renders
   with title, description, and both buttons, and the panel below shows the existing "navigate to..."
   message.
2. Click "Open Claude" — confirm the active tab navigates to `https://claude.ai` and the panel below
   updates to reflect whatever Claude page loads (home, project, conversation, etc.) without needing to
   close/reopen the panel.
3. Click "Open ChatGPT" — same check for `https://chatgpt.com`.
4. Verify the home block's size/content doesn't change across different detected contexts (project,
   conversation, projects-list selection mode, recents selection mode, GPT project, GPT projects-list).
5. Confirm existing contextual flows (single-project export, multi-project batch, recents selection, GPT
   flows) are unaffected — home block presence doesn't interfere with any existing button IDs, layout, or
   `detectContext()` logic.
