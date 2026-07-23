# Privacy Policy — LLM Vault

*Last updated: 2026-07-24*

## Summary

LLM Vault does not collect, store, transmit, or sell any user data. It runs entirely inside your browser and only communicates with claude.ai and chatgpt.com.

## What the extension does

LLM Vault is a Chrome extension that exports claude.ai and ChatGPT conversations and Projects into structured Markdown `.zip` files, downloaded to your own computer.

## Data access and use

- **claude.ai session**: The extension reads your existing claude.ai browser session (via the `lastActiveOrg` cookie) to identify your organization and call the same internal API endpoints the claude.ai web app itself already uses to list and fetch your conversations. This is the same data you already see by using claude.ai normally.
- **ChatGPT session**: On chatgpt.com, the extension's content script reads your existing browser session (via ChatGPT's own `/api/auth/session` endpoint, from within the page) to call the same internal `/backend-api` endpoints the ChatGPT web app itself already uses to list projects, fetch conversation content, and download referenced files. No separate login or credential is required or stored by the extension.
- **Page content**: On claude.ai pages, the extension's content script reads on-page text and image URLs (e.g. a Project's Memory/Instructions text, attached image thumbnails) that aren't exposed through claude.ai's API, so they can be included in your export. On chatgpt.com pages, the content script similarly reads on-page project instructions and the project's conversation list, which aren't exposed through a dedicated listing API.
- **No third-party transmission**: The extension does not send any data to any server other than claude.ai and chatgpt.com. There is no analytics, telemetry, tracking, or remote logging of any kind.
- **No persistent storage**: The extension does not store your conversation data anywhere except the `.zip` file it downloads directly to your computer via Chrome's own download mechanism. Nothing is retained in extension storage between sessions.

## Permissions

See the "Justifications for permissions" section of the Chrome Web Store listing for a full breakdown of why each requested permission (`downloads`, `activeTab`, `cookies`, `sidePanel`, `tabs`) is needed — each is used solely to read claude.ai or chatgpt.com page/session data and save the resulting export file locally.

## Third parties

LLM Vault has no third-party integrations, embedded SDKs, or external dependencies loaded at runtime. Its only bundled dependency is a vendored copy of JSZip (used to build the `.zip` file locally), which does not communicate with any server.

## Changes to this policy

Any future change to what data this extension accesses will be reflected here and in the extension's own changelog before being published.

## Contact

For questions about this policy, contact [ludofigueiredo@gmail.com](mailto:ludofigueiredo@gmail.com).
