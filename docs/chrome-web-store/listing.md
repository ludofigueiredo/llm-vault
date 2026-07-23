# Chrome Web Store Listing — LLM Vault

Copy-paste source for the Developer Dashboard fields. Not shipped with the extension itself.

## Short description (132 characters max)

```
Export Claude and ChatGPT Project conversations to structured Markdown .zip files — all locally, no external servers.
```
(119 chars)

## Detailed description

```
LLM Vault exports your Claude.ai and ChatGPT conversations and Projects as structured, portable Markdown archives — so your work stays readable and searchable outside the browser.

WHAT IT EXPORTS (Claude)
• A single conversation — full message history, Claude-generated artifacts, and attached files (images and documents alike)
• An entire Claude Project — every conversation in the project, plus the project's Memory, Instructions, and image knowledge files, all in one .zip
• Multiple Projects at once — visually select several projects from the Projects list and export them together into one combined archive
• A custom selection of recent conversations — pick any set of chats from your Recents list (individually, or all at once) and export just those

WHAT IT EXPORTS (ChatGPT)
• An entire ChatGPT Project — every conversation in the project, its instructions, and any files referenced in each conversation (images, attachments, citation-linked files), all in one .zip
• Multiple ChatGPT Projects at once — visually select several projects from the Projects list and export them together into one combined archive

Standalone (non-project) ChatGPT conversations are not yet exportable.

HOW IT WORKS
Click the toolbar icon to open the side panel. The panel always shows quick links to open Claude or ChatGPT, plus shortcuts to each provider's Projects and conversation-history pages. Navigate to a conversation, Project, or a listing page, and the panel shows the right export option automatically. Every export downloads as a single .zip containing readable Markdown files plus the conversation's artifacts and attachments in their own folders.

PRIVACY
LLM Vault only talks to claude.ai and chatgpt.com. It reads your existing browser session on whichever site you're using to call the same internal APIs each site's own web app already uses — no separate login, no data sent to any third-party server, nothing stored outside your own Downloads folder. All processing happens locally in your browser.
```

## Category

Productivity

## Language

English (primary); UI/DOM scraping currently assumes claude.ai's French-language interface for a few enrichment features (project Memory/Instructions capture) — core export works regardless of the claude.ai UI language. ChatGPT-side scraping is not language-dependent.

## Justifications for permissions (Developer Dashboard "Permission justification" fields)

- **`downloads`**: Required to save the generated `.zip` export to the user's Downloads folder.
- **`activeTab`**: Required to read the currently open claude.ai/chatgpt.com tab's URL (to detect whether it's a conversation, Project, or listing page) and to inject the content script that scrapes page content not available via API (Claude: Memory/Instructions text, image attachment URLs; ChatGPT: project instructions, conversation list, and file downloads via the site's own session).
- **`cookies`**: Required to read the `lastActiveOrg` cookie on claude.ai, which identifies the user's Claude organization ID — needed to build the correct API request URLs. No cookie value is transmitted anywhere except back to claude.ai itself (the same requests the Claude web app already makes).
- **`sidePanel`**: Required to show the extension's UI as a persistent side panel rather than a popup.
- **`tabs`**: Required to navigate the active tab between conversations/projects during multi-item batch exports (the extension visits each selected conversation/project in turn to scrape data that's only available on that page), for both Claude and ChatGPT batches.
- **`host_permissions: https://claude.ai/*`**: Required to call claude.ai's internal API endpoints and to inject the content script.
- **`host_permissions: https://chatgpt.com/*`**: Required to call ChatGPT's internal `/backend-api` endpoints (from the content script, using the page's own session) and to inject the content script. The extension does not function on any other site and requests no other host.

## Single purpose description (required field)

```
Export Claude.ai and ChatGPT conversations and Projects (individually or in bulk) as structured Markdown .zip archives, entirely client-side.
```
