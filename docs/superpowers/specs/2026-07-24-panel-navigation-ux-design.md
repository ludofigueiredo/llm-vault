# Panel Navigation UX Improvements — Design Spec

**Branch:** `feat/claude-gpt`
**Date:** 2026-07-24

## Problem

Following the home-section redesign (see `2026-07-23-home-page-design.md`), four smaller UX gaps remain in
`extension/sidepanel.html`/`extension/sidepanel.js`:

1. The "Open Claude" / "Open ChatGPT" buttons give no visual feedback about which site the active tab is
   currently on.
2. The home block and the contextual panel below it sit too close together with no visual break, making the
   panel feel like one undifferentiated stack.
3. When on claude.ai or chatgpt.com but not on a project/conversation page, the contextual panel only shows
   a passive text message ("Navigate to a Claude project... or conversation... page to export it.") with no
   way to get there from the panel.
4. The three existing selection-mode flows (Claude projects, Claude recents, GPT projects) each show a
   "Confirm Selection (N)" button once entered, but provide no way to back out of selection mode without
   either confirming (with 0 items, which is a no-op) or navigating away.

## Goals

- Home block: the button for the site the active tab is currently on gets a lighter/muted background,
  signaling "you are here"; the other keeps the normal solid button style.
- Add a visual separator (a horizontal rule, more contrasted than the existing `--border` token) with extra
  spacing between the home block and the contextual panel.
- Add a new, permanent "Project / Conversation" navigation block, visible whenever the active tab is on
  claude.ai or chatgpt.com (regardless of which page), sitting between the separator and the existing
  contextual panel. Two buttons:
  - **Project** → `https://claude.ai/cowork/projects` (Claude) / `https://chatgpt.com/projects` (GPT)
  - **Conversation** → `https://claude.ai/chats` (Claude) / `https://chatgpt.com/` (GPT — the closest
    equivalent to a conversation-history listing; ChatGPT has no dedicated recents page)
  - Same "active = lighter background" treatment as the home block: if the current URL already matches a
    button's target category (project listing or conversation/recents listing), that button gets the muted
    background.
- Add a "Cancel" button beneath each of the two existing "Confirm Selection" buttons (`#confirm-selection-btn`,
  shared by Claude-projects and GPT-projects selection, and `#confirm-recents-selection-btn`, used by Claude
  recents selection), which exits selection mode without confirming and without navigating.

## Non-goals

- No dark mode / `prefers-color-scheme` support — the user explicitly does not want this. The separator is
  just a more-contrasted rule within the existing single light palette.
- No changes to `detectContext()`'s core routing logic beyond what's needed to compute the new "active"
  states and render the new Project/Conversation block.
- No change to the export pipelines, selection-mode click-capture logic in `content.js`/`content-gpt.js`
  beyond what "Cancel" needs (which is exactly the existing `STOP_*_SELECTION_MODE` messages, already
  implemented).
- No new "recents" page equivalent is built for ChatGPT — the spec accepts `https://chatgpt.com/` (root) as
  the pragmatic target, since ChatGPT does not expose a URL dedicated to conversation history the way
  `claude.ai/recents` does.

## Design

### 1. Home block active-site styling

`detectContext()` (Claude branch) and `detectGptContext()` (GPT branch, in `sidepanel.js`) both already run
once per context re-detection. Add a small helper:

```js
function setHomeActiveButton(isGpt) {
  document.getElementById('goto-claude-btn').classList.toggle('is-active-site', !isGpt);
  document.getElementById('goto-gpt-btn').classList.toggle('is-active-site', isGpt);
}
```

Call `setHomeActiveButton(false)` at the top of the Claude branch of `detectContext()` (before the
`isGptHost` check returns early) and `setHomeActiveButton(true)` at the top of `detectGptContext()`. This
runs on every re-detection (tab switch, navigation), so the highlighted button always reflects the tab that
triggered the current detection pass.

New CSS class:

```css
.is-active-site {
  background: var(--surface-inset);
  color: var(--text-primary);
  border-color: var(--border);
}

.is-active-site:hover:not(:disabled) {
  background: var(--surface-inset);
  opacity: 1;
}
```

This reuses the existing `--surface-inset` token (already used for `button:disabled`), keeping the "you are
here" button visually calm/muted while the other button keeps the solid `--accent` fill (still fully
clickable — this is not a disabled state, just a style difference).

### 2. Separator + spacing

New CSS rule and one new HTML element between `.home` and `.panel`:

```css
.home-separator {
  border: none;
  border-top: 1px solid #D8D4C4;
  margin: 20px 0;
}
```

`#D8D4C4` is a manually-chosen darker step from the existing `--border` (`#ECE9DE`) — still within the warm
cream palette, but visibly more present than the current subtle card borders. Add as a new `:root` token
`--separator: #D8D4C4` rather than a bare hex in the rule, consistent with the file's existing convention of
naming all colors as CSS variables.

```html
<hr class="home-separator">
```

Placed directly after the closing `</div>` of `.home` and before the new Project/Conversation block (see
below).

### 3. Project / Conversation navigation block

New permanent block, visible whenever `isGptHost(url)` is true OR `url` is a `claude.ai` URL (i.e., whenever
the active tab is on either supported provider) — hidden otherwise (mirroring how the home block's
"you are here" styling only makes sense in that condition, though the home block's Open buttons themselves
stay visible unconditionally per the existing design).

HTML (new block, always present in the DOM, visibility toggled via a container `display`):

```html
<div class="provider-nav" id="provider-nav" style="display:none;">
  <div class="provider-nav-actions">
    <button id="goto-project-btn" type="button">Project</button>
    <button id="goto-conversation-btn" type="button">Conversation</button>
  </div>
</div>
```

CSS (reuses `.home-actions`-style side-by-side layout — extracted into a shared class since both blocks need
identical flex/gap/button-sizing behavior):

```css
.provider-nav {
  padding: 0 4px 18px;
}
```

Rename the existing `.home-actions` rule to a shared `.button-row` class used by both `.home-actions` and
`.provider-nav-actions`:

```css
.button-row {
  display: flex;
  gap: 8px;
}

.button-row button {
  flex: 1;
  margin-top: 0;
}
```

(Update the existing `<div class="home-actions">` markup to `<div class="button-row">` — the rename is a
pure refactor with no visual change, done because Task order in the plan will introduce a second consumer of
this exact rule; duplicating the flex rule under two class names would violate DRY.)

**Behavior** (`sidepanel.js`):

```js
function gptConversationsUrl() { return 'https://chatgpt.com/'; }
function gptProjectsUrl() { return 'https://chatgpt.com/projects'; }
function claudeProjectsUrl() { return 'https://claude.ai/cowork/projects'; }
function claudeConversationsUrl() { return 'https://claude.ai/chats'; }
```

Two click listeners registered once in `DOMContentLoaded`, each re-reading the active tab's host at click
time (not cached), so the correct destination is picked even if the tab navigated between renders:

```js
document.getElementById('goto-project-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = isGptHost(tab.url || '') ? gptProjectsUrl() : claudeProjectsUrl();
  gotoSite(target);
});
document.getElementById('goto-conversation-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = isGptHost(tab.url || '') ? gptConversationsUrl() : claudeConversationsUrl();
  gotoSite(target);
});
```

(Reuses the existing `gotoSite(url)` helper from the home-page-design plan — no new navigation primitive
needed.)

**Visibility + active-button state**, computed inside `detectContext()`/`detectGptContext()` alongside the
existing context-message logic:

```js
function updateProviderNav(url, isGpt) {
  const nav = document.getElementById('provider-nav');
  const projectBtn = document.getElementById('goto-project-btn');
  const conversationBtn = document.getElementById('goto-conversation-btn');
  nav.style.display = 'block';

  const onProjectsListing = isGpt
    ? isGptProjectsListingUrl(url)   // new helper, see below
    : isProjectsListingUrl(url);     // existing
  const onConversationsListing = isGpt
    ? isGptConversationsListingUrl(url) // new helper, see below
    : isRecentsUrl(url);                 // existing

  projectBtn.classList.toggle('is-active-site', onProjectsListing);
  conversationBtn.classList.toggle('is-active-site', onConversationsListing);
}
```

New small URL helpers (mirroring the existing `isProjectsListingUrl`/`isRecentsUrl` pattern already in
`sidepanel.js`):

```js
function isGptProjectsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chatgpt.com' && parsed.pathname === '/projects';
  } catch (e) {
    return false;
  }
}

function isGptConversationsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chatgpt.com' && parsed.pathname === '/';
  } catch (e) {
    return false;
  }
}
```

**Rule:** `provider-nav` is visible if and only if `new URL(url).hostname` is `'claude.ai'` or `isGptHost(url)`
is true; hidden otherwise. This is a new distinction — `detectContext()` today has no branch for "claude.ai
with an unrecognized path" separate from "some other site entirely" (both currently fall through to the same
"neither" fallback message), so this spec adds it explicitly.

Concretely: at the top of `detectContext()`, after the existing `isGptHost(url)` early-return, compute
`const onClaudeHost = (() => { try { return new URL(url).hostname === 'claude.ai'; } catch (e) { return false; } })();`
and call `updateProviderNav(url, false)` if `onClaudeHost` is true, or set `document.getElementById('provider-nav').style.display = 'none'` otherwise — before falling into the existing
project/conversation/projects-list/recents/neither branches, so the block's visibility is decided once per
call regardless of which of those branches runs afterward. `detectGptContext()` unconditionally calls
`updateProviderNav(url, true)` (every path reaching that function is already confirmed to be a GPT host).

The `selectionMode`/`batchInProgress`/`recentsSelectionMode` early-return guard in `detectContext()` (which
skips re-rendering the contextual panel during those flows) does **not** apply to `provider-nav` — the new
block's own visibility/active-state update runs unconditionally on every `detectContext()`/`detectGptContext()`
call, independent of that guard, since navigating away via Project/Conversation during an active selection
is the same accepted "user-initiated abandonment" edge case already accepted for the home block's Open
Claude/ChatGPT buttons in the prior spec.

### 4. Cancel button under each Confirm Selection

Two new buttons in the HTML, directly after each existing confirm button:

```html
<button id="confirm-selection-btn" style="display:none;">Confirm Selection (0)</button>
<button id="cancel-selection-btn" style="display:none;">Cancel</button>
...
<button id="confirm-recents-selection-btn" style="display:none;">Confirm Selection (0)</button>
<button id="cancel-recents-selection-btn" style="display:none;">Cancel</button>
```

Styled as a secondary/outline action (same visual treatment already used for `#select-all-recents-btn`):

```css
#cancel-selection-btn,
#cancel-recents-selection-btn {
  background: var(--surface);
  color: var(--text-primary);
  border-color: var(--border);
}
```

**Behavior** — `#cancel-selection-btn` covers both the Claude-projects and GPT-projects selection flows
(these already share `#confirm-selection-btn` via `onclick` reassignment; Cancel follows the same pattern):

```js
async function cancelSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (isGptHost(tab.url || '')) {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_GPT_SELECTION_MODE' });
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SELECTION_MODE' });
    }
  } catch (e) {
    // Content script unreachable (e.g. navigated away) — still reset local
    // panel state below so the user isn't stuck.
  }
  selectionMode = false;
  if (selectionPollTimer) { clearInterval(selectionPollTimer); selectionPollTimer = null; }
  document.getElementById('confirm-selection-btn').style.display = 'none';
  document.getElementById('cancel-selection-btn').style.display = 'none';
  detectContext();
}
```

`#cancel-recents-selection-btn` mirrors this for the recents flow:

```js
async function cancelRecentsSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECENTS_SELECTION_MODE' });
  } catch (e) {
    // Content script unreachable — still reset local panel state.
  }
  recentsSelectionMode = false;
  if (recentsSelectionPollTimer) { clearInterval(recentsSelectionPollTimer); recentsSelectionPollTimer = null; }
  document.getElementById('select-all-recents-btn').style.display = 'none';
  document.getElementById('confirm-recents-selection-btn').style.display = 'none';
  document.getElementById('cancel-recents-selection-btn').style.display = 'none';
  detectContext();
}
```

Both are registered in `DOMContentLoaded` and shown/hidden alongside their respective confirm buttons: every
existing call site that sets `confirmSelectionBtn.style.display = 'block'` (in `enterSelectionMode()` and
`startGptSelection()`) gains a matching `document.getElementById('cancel-selection-btn').style.display =
'block'`; same for the recents equivalents in `enterRecentsSelectionMode()`.

Calling `detectContext()` at the end of `cancelSelection()`/`cancelRecentsSelection()` re-renders the
contextual panel from scratch based on the tab's actual current URL — since `selectionMode`/
`recentsSelectionMode` are already reset to `false` by that point, the guard that normally skips
re-rendering during selection mode no longer applies, so the panel correctly falls through to showing
`select-projects-btn`/`select-recents-btn` again (or whatever the current URL actually warrants, if the user
navigated during selection).

## Testing

Manual verification (no automated suite exists for this extension), extending the existing test list:

1. Open the panel on claude.ai — confirm "Open Claude" shows the muted `is-active-site` background and
   "Open ChatGPT" shows the normal solid style; navigate to chatgpt.com and confirm the styles swap.
2. Confirm the new `<hr class="home-separator">` renders with visible extra spacing and a more contrasted
   line than the existing `.panel` border.
3. On claude.ai (any page), confirm the Project/Conversation block is visible; click "Project" and confirm
   navigation to `claude.ai/cowork/projects`; click "Conversation" and confirm navigation to
   `claude.ai/chats`.
4. On `claude.ai/cowork/projects`, confirm the "Project" button shows the active-site muted style; on
   `claude.ai/chats`, confirm "Conversation" shows it instead.
5. Repeat 3-4 for chatgpt.com (`chatgpt.com/projects` and `chatgpt.com/` respectively).
6. On a non-claude.ai/non-chatgpt.com page, confirm the Project/Conversation block is hidden.
7. On `claude.ai/projects`, click "Select Projects", confirm both "Confirm Selection (0)" and "Cancel" show;
   click "Cancel" and confirm selection mode ends (red borders removed on the page, panel returns to showing
   "Select Projects").
8. Repeat step 7 for `claude.ai/recents` ("Select Conversations" flow) and for `chatgpt.com/projects` (GPT
   project selection).
9. Confirm existing flows (export, confirm-and-batch) are unaffected by the new buttons' presence.
