# Rebranding to "LLM Vault" — Design

**Date:** 2026-07-09
**Status:** Approved

## Context

The extension currently exports Claude Project/conversation data and is named/branded exclusively around Claude ("Claude Conversations Exporter"). The user's longer-term intent is to support exporting conversations from multiple LLM providers (Claude and GPT, at minimum) — but that is a future goal, not something being implemented now. This change is scoped to renaming/rebranding the extension to a provider-neutral name, "LLM Vault", without any functional or architectural changes.

## Goals

1. Rename the extension from "Claude Conversations Exporter" to "LLM Vault" everywhere it's user-visible: the Chrome extension name (`manifest.json`), the side panel's page title and visible header text, and the project's documentation (`README.md`, `CLAUDE.md`).
2. Update the extension's `manifest.json` description to reflect the new name without overstating current capability — the extension only supports claude.ai today; the description should not imply multi-provider support already exists.
3. Preserve every existing functional behavior exactly — this is a text/branding-only change.

## Non-goals

- No new icon — the extension currently has no icon at all (`manifest.json`'s `action` field is empty, no icon files exist in `extension/`; Chrome shows its generic default). Creating one is explicitly out of scope for this change.
- No architectural changes to prepare for multi-provider (GPT) support — no abstraction, no refactoring of claude.ai-specific code. That remains a stated future direction, not a current task.
- No renaming of the project's folder (`claude-project-conversations-exporter`) or its git remote — only user-visible text changes.
- No functional/behavioral changes of any kind — every export flow, message contract, and DOM-scraping mechanism stays exactly as-is.

## Architecture

This is a pure find-and-replace across a small, fixed set of files — no new files, no new functions, no logic changes.

### `extension/manifest.json`

- `"name"`: `"Claude Conversations Exporter"` → `"LLM Vault"`.
- `"description"`: currently `"Export Claude Project conversations or a single conversation as a structured Markdown zip."` — this already accurately scopes to Claude-only capability, so it does not need to change in substance. It may optionally be lightly reworded for tone consistency with the new name (exact wording finalized in the implementation plan), but must continue to name Claude specifically rather than implying multi-provider support that doesn't exist yet.

### `extension/sidepanel.html`

- `<title>` tag: update to "LLM Vault" (or whatever exact title text is currently there — read the file to find the precise current string).
- Any visible header/branding text rendered in the panel itself (e.g. an `<h1>` or similar at the top of the panel UI, if one exists) — update to "LLM Vault".

### `README.md`

- Top-level `# ` heading (currently something like "# Claude Conversations Exporter") → "# LLM Vault".
- Any other prose in the README that names the project by its old name (e.g. "This extension...", introductory sentences) — update for consistency, without changing any functional documentation (installation steps, usage instructions, output structure, etc. all stay as-is).

### `CLAUDE.md`

- The "Project Overview" section currently names the project — update to reflect "LLM Vault" as the project's name, while keeping the accurate technical description of current (Claude-only) functionality intact.

## Error handling

Not applicable — this is a documentation/text change with no runtime behavior, no failure modes to handle.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification:
1. Reload the unpacked extension in `chrome://extensions` — confirm the extension card shows "LLM Vault" as its name.
2. Open the side panel — confirm the browser tab/window title (if visible) and any in-panel header text show "LLM Vault".
3. Skim `README.md` and `CLAUDE.md` to confirm no leftover references to the old name in headings or introductory prose (deeper technical prose that doesn't name the project doesn't need scrubbing).
4. Confirm no functional regression — run one export (project or conversation) to confirm the rename didn't accidentally break anything (expected: nothing should be affected, since no code/logic files are touched).
