# Claude Conversations Exporter

A Chrome extension that exports Claude conversations to structured Markdown.

- **Project export**: exports every conversation in a Claude Project as a `.zip` containing an `index.md` summary plus one folder per conversation.
- **Single conversation export**: exports one conversation as a `.zip` with the same per-conversation folder structure.

## Installation (developer mode)

This extension is not published to the Chrome Web Store. Install it manually:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder from this repository.
5. Pin the extension to your toolbar for easy access.

## Usage

1. Log into [claude.ai](https://claude.ai).
2. Navigate to a Claude Project page (`claude.ai/project/[uuid]`) or a conversation page (`claude.ai/chat/[uuid]`).
3. Click the extension icon in your Chrome toolbar.
4. Click **Export Project** or **Export Conversation** (the button label depends on which page you're on).
5. Wait for the export to complete — a `.zip` file will download automatically.

## Output structure

**Project export** (`project_<id>.zip`):
```
index.md
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

`artefacts/` and `contenu/` are currently created empty — they're reserved for a future update that will populate them with Claude-generated artifacts and uploaded file attachments respectively.

## How it works

The extension reads your `claude.ai` session cookie (`lastActiveOrg`) to identify your organization, then calls the same internal APIs the claude.ai web app uses to list and fetch conversations. All processing happens locally in your browser — no data is sent anywhere except to claude.ai itself.

## Related Tools

- **[Claude Project Knowledge Exporter](https://github.com/withLinda/claude-project-knowledge-exporter)** - Export project knowledge documentations from Claude Projects
- **[Claude Conversation Exporter](https://github.com/withLinda/claude-conversation-exporter)** - Export individual Claude conversations to Markdown

## License

This tool is provided as-is for personal use. Please respect Claude AI's terms of service and rate limits.