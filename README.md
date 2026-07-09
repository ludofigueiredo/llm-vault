# LLM Vault

A Chrome extension that exports Claude conversations to structured Markdown.

- **Project export**: exports every conversation in a Claude Project as a `.zip` containing an `index.md` summary plus one folder per conversation.
- **Single conversation export**: exports one conversation as a `.zip` with the same per-conversation folder structure.
- **Multi-project batch export**: from the `claude.ai/projects` listing page, visually select several projects (red border on click) and export all of them into one combined `.zip`, one subfolder per project.
- **Multi-conversation recents export**: from the `claude.ai/recents` page, visually select individual recent conversations (red border on click) or use "Select All" to bulk-select with auto-scroll, then export them into one `.zip` containing a combined index and one folder per conversation.

## Installation (developer mode)

This extension is not published to the Chrome Web Store. Install it manually (requires Chrome 114+ for side panel support):

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder from this repository.
5. Pin the extension to your toolbar for easy access.

## Usage

1. Log into [claude.ai](https://claude.ai).
2. Click the extension icon in your Chrome toolbar — a side panel opens and stays docked to the side of the browser window (it stays open across tab switches until you close it).
3. Navigate to a Claude Project page (`claude.ai/project/[uuid]`) or a conversation page (`claude.ai/chat/[uuid]`); the panel updates to show the detected context.
4. Click **Export Project** or **Export Conversation** (the button label depends on which page you're on).
5. Wait for the export to complete — a `.zip` file will download automatically.

### Batch-exporting multiple projects

1. Navigate to `claude.ai/projects` (the projects listing page). The panel shows a **Select Projects** button.
2. Click it, then click each project card you want to include — a red border appears around selected cards. Click a selected card again to deselect it.
3. The panel's button updates live to **Confirm Selection (N)**. Click it once you've picked the projects you want.
4. The extension takes over: it navigates the tab to each selected project in turn, scrapes it (same pipeline as a single-project export), and moves to the next. Watch the tab and the panel's status message for progress.
5. Once every selected project has been processed, one combined `.zip` downloads automatically, containing a subfolder per project.

Keep the side panel open for the whole batch — closing it mid-batch loses progress (the batch does not resume). If a project fails to load or scrape, it's skipped and the batch continues with the rest; the final status message reports which ones failed and why.

### Exporting selected conversations from Recents

1. Navigate to `claude.ai/recents` (the recents page showing your conversation history). The panel shows a **Select Conversations** button.
2. Click it, then click each conversation row you want to include — a red border appears around selected rows. Click a selected row again to deselect it. Alternatively, click **Select All** to auto-scroll through your entire conversation history and select every conversation found (this may take a minute or two for large histories, as the page lazy-loads).
3. The panel's button updates live to **Confirm Selection (N)**. Click it once you've picked the conversations you want.
4. The extension takes over: it fetches all selected conversations (same pipeline as a project export), briefly visits each conversation's page to capture its image attachments, then builds and downloads a combined `.zip` automatically.
5. Once every selected conversation has been processed, one combined `.zip` downloads automatically, containing a unified index and one folder per conversation.

Keep the side panel open for the whole export — closing it mid-export loses progress. If a conversation fails to fetch, it's skipped and the export continues with the rest; the final status message reports how many succeeded.

## Output structure

**Project export** (`project_<id>.zip`):
```
index.md
memory.md               (if the project has a Memory summary configured)
instructions.md         (if the project has custom Instructions configured)
fichiers/
conversation-title_<uuid8>/
  conversation.md
  artefacts/
  contenu/
another-conversation_<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

**Single conversation export** (`conversation-title_<uuid8>.zip`):
```
conversation-title_<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

**Multi-project batch export** (`projects_batch_<count>.zip`):
```
project-name-a_<uuid8>/
  index.md
  memory.md               (if present)
  instructions.md         (if present)
  fichiers/
  conversation-title_<uuid8>/
    conversation.md
    artefacts/
    contenu/
project-name-b_<uuid8>/
  index.md
  ...
```

Each selected project gets its own subfolder with the exact same contents as a standalone project export.

**Multi-conversation recents export** (`conversations_selection_<count>.zip`):

```
index.md
conversation-title-a_<uuid8>/
  conversation.md
  artefacts/
  contenu/
conversation-title-b_<uuid8>/
  conversation.md
  artefacts/
  contenu/
```

Each selected conversation gets its own subfolder with the same structure as a single-conversation export.

For **single conversation exports**, `artefacts/` and `contenu/` are populated automatically: `artefacts/` contains any Claude-generated artifacts attached to the conversation, and `contenu/` contains any individually-attached files (images and other file types like `.pptx` alike) — both are fetched directly by URL, using the real on-disk filenames found inside the conversation's own data. This only works for the conversation currently open in your active browser tab. If a conversation has no artifacts or no attached files, the corresponding folder stays empty.

For **project exports** (including multi-project batch export), `artefacts/` and `contenu/` are populated for every conversation the same way as a single-conversation export — this does mean project export now takes noticeably longer, since the extension briefly visits each conversation's page to capture its image attachments. `fichiers/` contains the project's image knowledge files (non-image knowledge files aren't captured yet). `memory.md`/`instructions.md` are only added when the project page has that section populated — they're scraped from the currently open project tab's page content, so the project's tab must be open in the browser when you export.

## How it works

The extension reads your `claude.ai` session cookie (`lastActiveOrg`) to identify your organization, then calls the same internal APIs the claude.ai web app uses to list and fetch conversations. All processing happens locally in your browser — no data is sent anywhere except to claude.ai itself.

## Related Tools

- **[Claude Project Knowledge Exporter](https://github.com/withLinda/claude-project-knowledge-exporter)** - Export project knowledge documentations from Claude Projects
- **[Claude Conversation Exporter](https://github.com/withLinda/claude-conversation-exporter)** - Export individual Claude conversations to Markdown

## License

This tool is provided as-is for personal use. Please respect Claude AI's terms of service and rate limits.