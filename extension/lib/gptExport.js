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

// Sends a message and retries once on failure. Covers two distinct causes
// of "the message channel closed before a response was received":
// (1) the content script instance was torn down mid-request because the
// page navigated/re-rendered out from under us (e.g. GET_GPT_PROJECT_METADATA
// clicking the details button/dialog can itself perturb the page just before
// the next message is sent), and (2) a stale content script reference from
// before a chrome.tabs.update() finished. A short delay + retry recovers
// from both without failing the whole project export.
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

  // GET_GPT_PROJECT_METADATA clicks the project's details button/dialog to
  // read instructions, then closes it — give that interaction a moment to
  // fully settle before the next message, since a dialog-close animation or
  // stray re-render can otherwise tear down the message channel mid-flight
  // for the very next call (this is what "message channel closed before a
  // response was received" on GET_GPT_PROJECT_CONVERSATIONS came from).
  await new Promise((r) => setTimeout(r, 500));

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

  // 3. Visit each conversation and scrape its thread.
  // Prefer the real href scraped from the DOM (includes the -<slug> segment);
  // only reconstruct from the project URL as a fallback if it's missing.
  const result = { project, conversations: [] };
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (onProgress) onProgress(i + 1, conversations.length, conv.title);
    const origin = new URL(projectUrl).origin;
    const convUrl = conv.url
      || `${origin}${projectUrl.replace(origin, '').replace(/\/project$/, '')}/c/${conv.convId}`;
    try {
      await chrome.tabs.update(tabId, { url: convUrl });
      const convReady = await waitForContentScriptReady(tabId, 15000, `/c/${conv.convId}`);
      if (!convReady) {
        console.warn(`[gptScrapeProject] Conversation "${conv.title}": content script not ready, skipping content`);
        result.conversations.push({ ...conv, turns: [], files: [] });
        continue;
      }
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
