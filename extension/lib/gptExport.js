async function gptBuildConversationFolder(target, conv) {
  const folder = target.folder(gptConvFolderName(conv));
  folder.file('conversation.md', gptTurnsToMarkdown({ name: conv.title }, conv.turns || []));
  const contenu = folder.folder('contenu-gpt');
  await fetchFilesInto(contenu, conv.contentFiles || []);
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
  const base = projectUrl.replace(/\/project$/, ''); // /g/g-p-<id>-<slug>
  // conversation URL shape: /g/g-p-<id>-<slug>/c/<convId>; but the project
  // URL may lack the slug. Build from the same origin + the href pattern
  // the list scrape gave us is safest: reconstruct via /c/<convId>.
  const origin = new URL(projectUrl).origin;
  const result = { project, conversations: [] };
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (onProgress) onProgress(i + 1, conversations.length, conv.title);
    const convUrl = `${origin}${base.replace(origin, '')}/c/${conv.convId}`;
    try {
      await chrome.tabs.update(tabId, { url: convUrl });
      const convReady = await waitForContentScriptReady(tabId, 15000, `/c/${conv.convId}`);
      if (!convReady) { result.conversations.push({ ...conv, turns: [], contentFiles: [] }); continue; }
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_GPT_CONVERSATION' });
      result.conversations.push({
        ...conv,
        turns: (data && data.turns) || [],
        contentFiles: (data && data.contentFiles) || [],
      });
    } catch (e) {
      result.conversations.push({ ...conv, turns: [], contentFiles: [] });
    }
  }
  return result;
}
