# Claude Conversations Exporter

A Chrome extension that exports Claude conversations to structured Markdown.

- **Project export**: exports every conversation in a Claude Project as a `.zip` containing an `index.md` summary plus one folder per conversation.
- **Single conversation export**: exports one conversation as a `.zip` with the same per-conversation folder structure.

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

For **single conversation exports**, `artefacts/` and `contenu/` are populated automatically: `artefacts/` contains any Claude-generated artifacts attached to the conversation (captured by simulating a click on the conversation's "Download all" button and unzipping the result), and `contenu/` contains any individually-attached image files (fetched directly). This only works for the conversation currently open in your active browser tab, and only captures image-based attachments (non-image files, like `.pptx` attachments, currently have no discoverable download link and are skipped). If a conversation has no artifacts or no attached files, the corresponding folder stays empty.

For **project exports**, `artefacts/` and `contenu/` are still created empty for every conversation — this per-conversation capture mechanism is scoped to single-conversation export only for now (a future update may extend it to project exports). `fichiers/` is likewise an empty placeholder, reserved for a future update that will download the project's uploaded knowledge files. `memory.md`/`instructions.md` are only added when the project page has that section populated — they're scraped from the currently open project tab's page content, so the project's tab must be open in the browser when you export.

## How it works

The extension reads your `claude.ai` session cookie (`lastActiveOrg`) to identify your organization, then calls the same internal APIs the claude.ai web app uses to list and fetch conversations. All processing happens locally in your browser — no data is sent anywhere except to claude.ai itself.

## Related Tools

- **[Claude Project Knowledge Exporter](https://github.com/withLinda/claude-project-knowledge-exporter)** - Export project knowledge documentations from Claude Projects
- **[Claude Conversation Exporter](https://github.com/withLinda/claude-conversation-exporter)** - Export individual Claude conversations to Markdown

## License

This tool is provided as-is for personal use. Please respect Claude AI's terms of service and rate limits.