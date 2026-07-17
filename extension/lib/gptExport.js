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

async function gptScrapeProject(tabId, projectUrl, onProgress) {
  // 1. Navigate to the project page and wait for the content script.
  await chrome.tabs.update(tabId, { url: projectUrl });
  const projectPath = new URL(projectUrl).pathname;
  const ready = await waitForContentScriptReady(tabId, 15000, projectPath);
  if (!ready) throw new Error('project page not ready');

  // 2. Instructions + conversation list.
  const project = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_METADATA' });
  const listResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_PROJECT_CONVERSATIONS' });
  const conversations = (listResp && listResp.conversations) || [];
  if (conversations.length === 0) throw new Error('no conversations');

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
      if (!convReady) { result.conversations.push({ ...conv, turns: [], files: [] }); continue; }
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_CONVERSATION_VIA_API', convId: conv.convId });
      result.conversations.push({
        ...conv,
        turns: (data && data.turns) || [],
        files: (data && data.files) || [],
      });
    } catch (e) {
      result.conversations.push({ ...conv, turns: [], files: [] });
    }
  }
  return result;
}
