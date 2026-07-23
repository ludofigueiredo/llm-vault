# Home Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `.intro` text block in the side panel with a permanent home section (title, value-prop description, "Open Claude" / "Open ChatGPT" buttons that navigate the active tab to the respective site).

**Architecture:** Pure HTML/CSS/JS change inside the existing single-page side panel (`extension/sidepanel.html` + `extension/sidepanel.js`). No new files, no build step, no changes to `detectContext()`, the export pipelines, or any provider-specific logic. The new home block sits above the existing `.panel` block, which is untouched.

**Tech Stack:** Vanilla JS, Manifest V3 side panel, no frameworks/bundler (per `CLAUDE.md`).

## Global Constraints

- Pure vanilla JavaScript — no frameworks, no bundler, no build step.
- No new CSS color tokens — reuse existing `:root` variables (`--text-primary`, `--text-secondary`, `--radius-*`, `--accent`, `--accent-text`).
- Copy is in English, matching the rest of `sidepanel.html`.
- No automated test suite exists for this extension — verification is manual, via `chrome://extensions` reload + live browser testing (per `CLAUDE.md`'s Testing Approach).
- Do not modify `detectContext()`, `chrome.tabs.onUpdated` wiring, or any button IDs already used by the contextual panel below the home block.

---

### Task 1: Home section HTML + styles

**Files:**
- Modify: `extension/sidepanel.html:51-67` (the `.intro`/`.intro-title`/`.intro-body` CSS rules)
- Modify: `extension/sidepanel.html:144-147` (the `.intro` HTML block)

**Interfaces:**
- Produces: two new button elements with IDs `goto-claude-btn` and `goto-gpt-btn` that Task 2 attaches click listeners to.

- [ ] **Step 1: Replace the `.intro`/`.intro-title`/`.intro-body` CSS rules with `.home`/`.home-title`/`.home-body`/`.home-actions`**

Find this block (lines 51-66):

```css
    .intro {
      padding: 4px 4px 18px;
    }

    .intro-title {
      font-weight: 700;
      font-size: 15px;
      margin: 0 0 6px;
    }

    .intro-body {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-secondary);
      margin: 0;
    }
```

Replace it with:

```css
    .home {
      padding: 4px 4px 18px;
    }

    .home-title {
      font-weight: 700;
      font-size: 15px;
      margin: 0 0 6px;
    }

    .home-body {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-secondary);
      margin: 0 0 14px;
    }

    .home-actions {
      display: flex;
      gap: 8px;
    }

    .home-actions button {
      flex: 1;
      margin-top: 0;
    }
```

Note: `.home-actions button { margin-top: 0; }` overrides the global `button + button { margin-top: 10px; }` rule (still present elsewhere in the file for the `.panel` block's stacked buttons) so the two home buttons sit side by side instead of stacking.

- [ ] **Step 2: Replace the `.intro` HTML block with `.home`**

Find this block (lines 144-147):

```html
  <div class="intro">
    <p class="intro-title">LLM Vault</p>
    <p class="intro-body">Export your Claude projects and conversations as organized Markdown files. Open a project or conversation on claude.ai, then use the button below — or select multiple projects/conversations from a listing page to export them together.</p>
  </div>
```

Replace it with:

```html
  <div class="home">
    <p class="home-title">LLM Vault</p>
    <p class="home-body">
      Turn your Claude and ChatGPT conversations into organized, portable Markdown — projects,
      individual chats, attachments and generated files all included in a single zip. Keep a
      permanent, searchable archive of your work that lives outside any one provider's dashboard.
    </p>
    <div class="home-actions">
      <button id="goto-claude-btn" type="button">Open Claude</button>
      <button id="goto-gpt-btn" type="button">Open ChatGPT</button>
    </div>
  </div>
```

- [ ] **Step 3: Manually verify the HTML loads without errors**

Run:
```bash
cd "c:\Users\boome\Desktop\code\claude-project-conversations-exporter"
```
Then in Chrome: open `chrome://extensions`, enable Developer mode if not already, click "Load unpacked" (or the reload icon if already loaded) and select the `extension/` folder. Open the side panel via the toolbar icon.

Expected: panel renders with title "LLM Vault", the description paragraph, and two buttons "Open Claude" / "Open ChatGPT" side by side, no console errors in the panel's DevTools (right-click inside panel → Inspect).

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel.html
git commit -m "$(cat <<'EOF'
redesign: replace static intro text with home section + provider buttons

Adds a permanent home block (title, value-prop copy, Open Claude /
Open ChatGPT buttons) above the existing contextual export panel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire up navigation button clicks

**Files:**
- Modify: `extension/sidepanel.js:261-281` (the `DOMContentLoaded` listener)

**Interfaces:**
- Consumes: `goto-claude-btn` and `goto-gpt-btn` element IDs produced by Task 1.
- Produces: `gotoSite(url)` async function (no other task depends on it, but it must not collide with any existing identifier — confirmed no such name exists in `sidepanel.js` today).

- [ ] **Step 1: Add the `gotoSite` helper function**

In `extension/sidepanel.js`, immediately after the existing `setStatus` function (currently at lines 227-231):

```js
function setStatus(message, kind) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind || '';
}

async function gotoSite(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.update(tab.id, { url });
}
```

- [ ] **Step 2: Register the click listeners inside the existing `DOMContentLoaded` handler**

Find the `DOMContentLoaded` listener (lines 261-281):

```js
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
```

Add these two listeners right after `detectContext();` and before the `export-btn` listener:

```js
document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('goto-claude-btn').addEventListener('click', () => {
    gotoSite('https://claude.ai');
  });
  document.getElementById('goto-gpt-btn').addEventListener('click', () => {
    gotoSite('https://chatgpt.com');
  });
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
```

(The remaining listeners in that block — `select-projects-btn` through `confirm-recents-selection-btn` — stay exactly as they are, unchanged.)

- [ ] **Step 3: Manually verify navigation works**

In Chrome: reload the unpacked extension (`chrome://extensions` → reload icon), open the side panel on any page (e.g. `https://example.com`).

Test A — Claude:
1. Click "Open Claude".
2. Expected: the active tab navigates to `https://claude.ai`. Once the page loads, the panel below the home block updates on its own (via the existing `chrome.tabs.onUpdated` → `detectContext()` wiring) to reflect whatever Claude page loaded, without closing/reopening the panel.

Test B — ChatGPT:
1. Navigate back to `https://example.com` in the active tab (or open a new tab and make it active).
2. Click "Open ChatGPT".
3. Expected: the active tab navigates to `https://chatgpt.com`, and the panel updates accordingly.

Test C — home block stability across contexts:
1. Visit a Claude project page, a Claude conversation page, `claude.ai/projects`, `claude.ai/recents`, a ChatGPT project page, and `chatgpt.com/projects` in turn (reusing the side panel throughout).
2. Expected: in every case, the home block (title, description, two buttons) renders identically — same size, same content — while only the panel below it changes.

Test D — no regressions to existing flows:
1. On a Claude project page, click "Export Project" and confirm the export still completes and downloads a zip (per existing behavior — no functional change expected).
2. On `claude.ai/projects`, click "Select Projects", confirm selection mode still works (red outlines, live count, Confirm Selection button) unaffected by the new home buttons.

- [ ] **Step 4: Commit**

```bash
git add extension/sidepanel.js
git commit -m "$(cat <<'EOF'
feat: wire Open Claude / Open ChatGPT buttons to navigate active tab

Clicking either button calls chrome.tabs.update on the active tab;
existing chrome.tabs.onUpdated wiring re-runs detectContext() once
the destination page loads, so no additional detection logic is
needed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
