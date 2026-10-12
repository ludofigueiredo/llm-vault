function gptBase64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gptBuildConversationFolder(target, conv) {
  const folder = target.folder(gptConvFolderName(conv));
  folder.file('conversation.md', gptTurnsToMarkdown({ name: conv.title }, conv.turns || []));
  const contenu = folder.folder('contenu-gpt');
  const files = conv.files || [];
  let any = false;
  for (const f of files) {
    try {
      contenu.file(f.filename, gptBase64ToBytes(f.bytesBase64));
      any = true;
    } catch (e) {
      // Skip a corrupt entry; keep going.
    }
  }
  if (!any) contenu.file('.gitkeep', '');
}

async function gptBuildProjectInto(zip, folderPath, project, conversationsWithData) {
  const target = folderPath ? zip.folder(folderPath) : zip;
  target.file('index.md', gptIndexMarkdown(project, conversationsWithData));
  if (project.instructions) {
    target.file('instructions.md', gptInstructionsMarkdown(project));
  }
  const sourceFiles = project.sourceFiles || [];
  if (sourceFiles.length > 0) {
    const sources = target.folder('fichiers');
    for (const f of sourceFiles) {
      try {
        sources.file(f.filename, gptBase64ToBytes(f.bytesBase64));
      } catch (e) {
        // Skip a corrupt entry; keep going — same tolerance as
        // gptBuildConversationFolder's own file-writing loop.
      }
    }
  }
  const conversationsFolder = target.folder('conversations');
  for (const conv of conversationsWithData) {
    await gptBuildConversationFolder(conversationsFolder, conv);
  }
}

// Sends a message and retries on failure, with a delay between attempts.
// Guards against transient issues: a stale content script reference from
// just after a chrome.tabs.update() (navigation initiated but not yet
// complete), or an ordinary network hiccup in the content script's own
// fetch to /backend-api. A short delay + retry recovers from both without
// failing the whole project export.
async function gptSendMessageWithRetry(tabId, message, retries, delayMs) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

async function gptScrapeProject(tabId, projectUrl, onProgress) {
  // The tab is already on projectUrl and its content script already
  // confirmed ready by the caller (either gptNavigateToProject in
  // sidepanel.js, for a batch, or the user having manually navigated there
  // for a single-project export) — no need to navigate again here.

  // 1. Instructions + conversation list.
  let project;
  try {
    project = await sendMessageWithRecovery(tabId, { type: 'GET_GPT_PROJECT_METADATA' }, 'content-gpt.js');
  } catch (e) {
    throw new Error(`failed to fetch project metadata: ${e.message}`);
  }

  // 1.5. The project's "Sources" tab files (project.sources, from the same
  // gizmos API response GET_GPT_PROJECT_METADATA already fetched) — done
  // here, still on the project page, before navigating away to the first
  // conversation. A project with no sources (project.sources is an empty
  // array) skips this with no extra request.
  project.sourceFiles = [];
  if (project.sources && project.sources.length > 0) {
    try {
      const sourcesResp = await gptSendMessageWithRetry(
        tabId, { type: 'DOWNLOAD_GPT_PROJECT_SOURCES', sources: project.sources }, 1, 800
      );
      project.sourceFiles = (sourcesResp && sourcesResp.files) || [];
    } catch (e) {
      console.warn(`[gptScrapeProject] Failed to download project sources: ${e.message}`);
    }
  }

  let listResp;
  try {
    listResp = await gptSendMessageWithRetry(tabId, { type: 'GET_GPT_PROJECT_CONVERSATIONS' }, 2, 1000);
  } catch (e) {
    throw new Error(`failed to fetch conversation list: ${e.message}`);
  }

  const conversations = (listResp && listResp.conversations) || [];

  // An empty project is a legitimate state (e.g. a freshly created project,
  // or one used only to hold instructions/knowledge files), not an export
  // failure — build it with zero conversations instead of throwing, so the
  // caller can report it as a warning rather than counting it against
  // "failed" projects.
  if (conversations.length === 0) {
    console.warn('[gptScrapeProject] Project has no conversations');
    return { project, conversations: [], empty: true };
  }

  console.log(`[gptScrapeProject] Found ${conversations.length} conversations to scrape`);

  // 3. Visit each conversation's own page, then fetch its content via
  // /backend-api/conversation/<id> once there. The API call itself doesn't
  // need the tab to be on that conversation's page (it's a same-origin
  // fetch keyed purely by convId) — but navigating there anyway is
  // deliberate: the user wants to see each conversation actually open and
  // be scraped one by one, not have everything resolved invisibly from the
  // project page.
  const result = { project, conversations: [] };
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (onProgress) onProgress(i + 1, conversations.length, conv.title);
    try {
      await chrome.tabs.update(tabId, { url: conv.url });
      const convReady = await waitForContentScriptReady(tabId, 15000, `/c/${conv.convId}`);
      if (!convReady) {
        console.warn(`[gptScrapeProject] Conversation "${conv.title}": page did not load in time, skipping content`);
        result.conversations.push({ ...conv, turns: [], files: [] });
        continue;
      }
      const data = await gptSendMessageWithRetry(tabId, { type: 'GET_GPT_CONVERSATION_VIA_API', convId: conv.convId }, 1, 800);
      // Prefer the API's own title over the one scraped from the project
      // page's DOM when available: the DOM scrape (gptScrapeConversationList
      // in content-gpt.js) falls back to the raw convId when its selector
      // doesn't match a given row (observed live — some rows render without
      // the expected title element), which otherwise ends up as the
      // zip folder name via gptConvFolderName(). The API's conversation/
      // <convId> response always has the real title.
      const apiTitle = (data && data.title || '').trim();
      result.conversations.push({
        ...conv,
        title: apiTitle || conv.title,
        turns: (data && data.turns) || [],
        files: (data && data.files) || [],
      });
    } catch (e) {
      console.warn(`[gptScrapeProject] Conversation "${conv.title}": ${e.message}`);
      result.conversations.push({ ...conv, turns: [], files: [] });
    }
  }
  return result;
}
