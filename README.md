# Claude Conversations Exporter

A Chrome extension that exports Claude conversations to structured Markdown.

- **Project export**: exports every conversation in a Claude Project as a `.zip` containing an `index.md` summary plus one folder per conversation.
- **Single conversation export**: exports one conversation as a `.zip` with the same per-conversation folder structure.
- **Multi-project batch export**: from the `claude.ai/projects` listing page, visually select several projects (red border on click) and export all of them into one combined `.zip`, one subfolder per project.

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

For **single conversation exports**, `artefacts/` and `contenu/` are populated automatically: `artefacts/` contains any Claude-generated artifacts attached to the conversation (captured by simulating a click on the conversation's "Download all" button and unzipping the result), and `contenu/` contains any individually-attached files — images are fetched directly, and other file types (like `.pptx`) are captured by simulating a click to open the file's preview, then clicking its "Download" button. This only works for the conversation currently open in your active browser tab. If a conversation has no artifacts or no attached files, the corresponding folder stays empty.

For **project exports**, `artefacts/` and `contenu/` are still created empty for every conversation — this per-conversation capture mechanism is scoped to single-conversation export only for now (a future update may extend it to project exports). `fichiers/` is likewise an empty placeholder, reserved for a future update that will download the project's uploaded knowledge files. `memory.md`/`instructions.md` are only added when the project page has that section populated — they're scraped from the currently open project tab's page content, so the project's tab must be open in the browser when you export.

## How it works

The extension reads your `claude.ai` session cookie (`lastActiveOrg`) to identify your organization, then calls the same internal APIs the claude.ai web app uses to list and fetch conversations. All processing happens locally in your browser — no data is sent anywhere except to claude.ai itself.

## Related Tools

- **[Claude Project Knowledge Exporter](https://github.com/withLinda/claude-project-knowledge-exporter)** - Export project knowledge documentations from Claude Projects
- **[Claude Conversation Exporter](https://github.com/withLinda/claude-conversation-exporter)** - Export individual Claude conversations to Markdown

## License

This tool is provided as-is for personal use. Please respect Claude AI's terms of service and rate limits.