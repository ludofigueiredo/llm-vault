# Side Panel Default Behavior — Design

**Date:** 2026-07-08
**Status:** Approved

## Context

The extension currently opens as a classic Manifest V3 popup (`default_popup` in `manifest.json`): a floating window anchored to the toolbar icon that closes as soon as the user clicks elsewhere or switches tabs. The user wants the extension to open as a persistent side panel instead, docked to the side of the browser window.

Chrome exposes a dedicated `chrome.sidePanel` API (Chrome 114+) for this. Unlike the popup (which Chrome opens automatically from a static `default_popup` manifest declaration), the side panel requires an explicit runtime call — there is no static manifest field that makes a toolbar-icon click open the side panel by itself. This requires adding a background service worker, a component this extension does not currently have.

## Goals

1. Clicking the extension's toolbar icon opens a side panel (not a popup).
2. The side panel's content and behavior are otherwise identical to today's popup — same context detection, same export button, same status messages, same underlying export pipeline. This is a shell/UI-host change only, not a functional change.
3. The panel behaves like a standard global side panel: once opened, it stays open across tab switches and site navigation until the user closes it manually.

## Non-goals

- No change to any export logic, API fetching, content-script messaging, or zip-building code — `lib/*.js` files are untouched.
- No support for pre-114 Chrome versions — acceptable since this extension is already developer-mode-only (unpacked), with no store-review or broad-compatibility constraint.
- No dual popup+panel mode — the popup is fully replaced, not offered as an alternative.

## Architecture

### New file: `extension/background.js`

A minimal Manifest V3 service worker whose only responsibility is enabling side-panel-on-icon-click behavior:

```javascript
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
```

This is the Chrome-recommended way to bind toolbar-icon clicks to opening the side panel — simpler and more robust than manually handling `chrome.action.onClicked` and calling `chrome.sidePanel.open()`, since `setPanelBehavior` is a one-time setup call handled entirely by Chrome's own click-to-open wiring afterward.

### Renamed: `extension/popup.html` → `extension/sidepanel.html`, `extension/popup.js` → `extension/sidepanel.js`

Pure rename, no content changes. The file's existing `<script src="...">` tags (referencing `lib/jszip.min.js`, `lib/orgId.js`, `lib/api.js`, `lib/markdown.js`, `lib/zipBuilder.js`, and the renamed `sidepanel.js`) stay as-is — only the two file names change, plus the internal reference from the HTML file to its script.

### Modified: `extension/manifest.json`

- Remove `"action": {"default_popup": "popup.html"}`, replace with `"action": {}` (keeps the toolbar icon clickable and present, but Chrome no longer auto-opens anything on click — the click event is instead routed to the side panel via the behavior set in `background.js`).
- Add `"side_panel": {"default_path": "sidepanel.html"}`.
- Add `"background": {"service_worker": "background.js"}`.
- Add `"sidePanel"` to the `permissions` array.

The full resulting manifest shape:
```json
{
  "manifest_version": 3,
  "name": "Claude Conversations Exporter",
  "version": "1.0.0",
  "description": "...",
  "permissions": ["downloads", "activeTab", "cookies", "sidePanel"],
  "host_permissions": ["https://claude.ai/*"],
  "action": {},
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "content_scripts": [ /* unchanged */ ]
}
```

### Global behavior (not per-site)

Per the user's choice, the panel is NOT scoped to claude.ai — once opened, it stays open across any tab or site until manually closed. This is the default `chrome.sidePanel` behavior when no per-tab `chrome.sidePanel.setOptions({tabId, ...})` scoping is applied, so no additional code is needed to achieve this — it falls out naturally from using only the global `setPanelBehavior` call and no tab-specific panel logic.

## Testing approach

No automated test suite (consistent with the rest of this project). Manual verification:
1. Load the unpacked extension, click the toolbar icon — confirm a side panel opens (not a popup), docked to the side of the browser window.
2. Confirm the panel's content and behavior (context detection, export button, status messages, actual export completing successfully for both project and conversation modes) are unchanged from the prior popup behavior.
3. Switch to a different tab/site while the panel is open — confirm it stays open (global behavior, not closed/hidden).
4. Click the toolbar icon again while the panel is already open — confirm it doesn't error or duplicate; standard Chrome behavior is that this either does nothing or closes it, verify whichever occurs is not broken.
5. Confirm the extension still loads without manifest errors in `chrome://extensions`.
