# Chrome Web Store Listing — LLM Vault

Copy-paste source for the Developer Dashboard fields. Not shipped with the extension itself.

## Short description (132 characters max)

```
Export Claude Project conversations, single chats, or whole projects to structured Markdown .zip files — all locally, no external servers.
```
(139 chars — trim if the field rejects it; suggested trim below)

```
Export Claude conversations and Projects to structured Markdown .zip files — entirely local, no external servers involved.
```
(125 chars)

## Detailed description

```
LLM Vault exports your Claude.ai conversations and Projects as structured, portable Markdown archives — so your work stays readable and searchable outside the browser.

WHAT IT EXPORTS
• A single conversation — full message history, Claude-generated artifacts, and attached files (images and documents alike)
• An entire Claude Project — every conversation in the project, plus the project's Memory, Instructions, and image knowledge files, all in one .zip
• Multiple Projects at once — visually select several projects from the Projects list and export them together into one combined archive
• A custom selection of recent conversations — pick any set of chats from your Recents list (individually, or all at once) and export just those

HOW IT WORKS
Click the toolbar icon to open the side panel. Navigate to a Claude conversation, Project, or the Projects/Recents listing pages, and the panel shows the right export option automatically. Every export downloads as a single .zip containing readable Markdown files plus the conversation's artifacts and attachments in their own folders.

PRIVACY
LLM Vault only talks to claude.ai. It reads your existing browser session to call the same internal APIs the Claude web app already uses — no separate login, no data sent to any third-party server, nothing stored outside your own Downloads folder. All processing happens locally in your browser.

Currently supports claude.ai. Broader multi-provider LLM export support is a planned future direction.
```

## Category

Productivity

## Language

English (primary); UI/DOM scraping currently assumes claude.ai's French-language interface for a few enrichment features (project Memory/Instructions capture) — core export works regardless of the claude.ai UI language.

## Justifications for permissions (Developer Dashboard "Permission justification" fields)

- **`downloads`**: Required to save the generated `.zip` export to the user's Downloads folder.
- **`activeTab`**: Required to read the currently open claude.ai tab's URL (to detect whether it's a conversation, Project, or listing page) and to inject the content script that scrapes page content not available via API (Memory/Instructions text, image attachment URLs).
- **`cookies`**: Required to read the `lastActiveOrg` cookie, which identifies the user's Claude organization ID — needed to build the correct API request URLs. No cookie value is transmitted anywhere except back to claude.ai itself (the same requests the Claude web app already makes).
- **`sidePanel`**: Required to show the extension's UI as a persistent side panel rather than a popup.
- **`tabs`**: Required to navigate the active tab between conversations/projects during multi-item batch exports (the extension visits each selected conversation/project in turn to scrape data that's only available on that page).
- **`host_permissions: https://claude.ai/*`**: Required to call claude.ai's internal API endpoints and to inject the content script — the extension does not function on any other site and requests no other host.

## Single purpose description (required field)

```
Export Claude.ai conversations and Projects (individually or in bulk) as structured Markdown .zip archives, entirely client-side.
```
