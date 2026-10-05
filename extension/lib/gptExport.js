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
  for (const conv of conversationsWithData) {
    await gptBuildConversationFolder(target, conv);
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
  // 1. Navigate to the project page and wait for the content script.
  await chrome.tabs.update(tabId, { url: projectUrl });
  const projectPath = new URL(projectUrl).pathname;
  const ready = await waitForContentScriptReady(tabId, 20000, projectPath);
  if (!ready) throw new Error('project page did not load in time (content script not ready)');

  // 2. Instructions + conversation list.
  let project;
  try {
    project = await sendMessageWithRecovery(tabId, { type: 'GET_GPT_PROJECT_METADATA' }, 'content-gpt.js');
  } catch (e) {
    throw new Error(`failed to fetch project metadata: ${e.message}`);
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

  // 3. Fetch each conversation's content via /backend-api/conversation/<id>.
  // This is a same-origin fetch keyed purely by convId — it does not read
  // anything from a specific conversation page's DOM, so there is no need
  // to navigate the tab to each conversation's URL first. We stay on the
  // project page (still the active tab from step 1/2) for every fetch,
  // which removes an entire chrome.tabs.update + waitForContentScriptReady
  // cycle per conversation — previously the single largest source of
  // navigation-timing flakiness in a project export (a click landing wrong,
  // a page taking >15s to report ready, a message channel torn down by a
  // navigation racing the request).
  const result = { project, conversations: [] };
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (onProgress) onProgress(i + 1, conversations.length, conv.title);
    try {
      const data = await gptSendMessageWithRetry(tabId, { type: 'GET_GPT_CONVERSATION_VIA_API', convId: conv.convId }, 1, 800);
      result.conversations.push({
        ...conv,
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
