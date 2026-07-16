let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;
let selectionMode = false;
let selectedProjects = [];
let batchInProgress = false;
let recentsSelectionMode = false;

function isProjectsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && (parsed.pathname === '/projects' || parsed.pathname === '/cowork/projects');
  } catch (e) {
    return false;
  }
}

function isRecentsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && (parsed.pathname === '/recents' || parsed.pathname === '/chats');
  } catch (e) {
    return false;
  }
}

// Claude Teams ("cowork") accounts serve project pages under
// /cowork/project/{uuid} and /cowork/projects instead of /project/{uuid}
// and /projects — same UUIDs, same (assumed) page content, different path
// prefix. Detecting this from the URL the export was launched from lets
// every navigation this extension constructs later (returning to the
// project page, visiting each project/conversation in a batch) stay
// consistent with whichever variant the user is actually on.
function getProjectBasePath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith('/cowork/') ? '/cowork/project/' : '/project/';
  } catch (e) {
    return '/project/';
  }
}

// Same idea as getProjectBasePath, for the conversations-listing page: Claude
// Teams accounts use /chats instead of /recents.
function getRecentsPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/chats' ? '/chats' : '/recents';
  } catch (e) {
    return '/recents';
  }
}

function buildArtifactsDataFromConversationJson(orgId, conversationUuid, conversationData) {
  const filePaths = extractFilePaths(conversationData);

  const artifactFiles = filePaths.outputs.map((path) => ({
    filename: path.split('/').pop(),
    url: `https://claude.ai/api/organizations/${orgId}/conversations/${conversationUuid}/wiggle/download-file?path=${encodeURIComponent(path)}`
  }));
  const uploadedFiles = filePaths.uploads.map((path) => ({
    filename: path.split('/').pop(),
    url: `https://claude.ai/api/organizations/${orgId}/conversations/${conversationUuid}/wiggle/download-file?path=${encodeURIComponent(path)}`
  }));

  return { artifactFiles, contentFiles: uploadedFiles };
}

function buildArtifactsDataByUuid(orgId, conversations) {
  const artifactsDataByUuid = new Map();
  for (const conv of conversations) {
    const uuid = conv.metadata.uuid;
    artifactsDataByUuid.set(uuid, buildArtifactsDataFromConversationJson(orgId, uuid, conv.data));
  }
  return artifactsDataByUuid;
}

async function captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, onProgress) {
  const total = conversations.length;
  for (let i = 0; i < total; i++) {
    const conv = conversations[i];
    const uuid = conv.metadata.uuid;
    if (onProgress) onProgress(i + 1, total, conv.metadata.name);

    try {
      await chrome.tabs.update(tabId, { url: `https://claude.ai/chat/${uuid}` });
      const ready = await waitForContentScriptReady(tabId, 15000, `/chat/${uuid}`);
      if (!ready) continue;

      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CONVERSATION_ARTIFACTS' });
      const imageFiles = (response && response.contentFiles) || [];
      if (imageFiles.length === 0) continue;

      const existing = artifactsDataByUuid.get(uuid) || { artifactFiles: [], contentFiles: [] };
      existing.contentFiles = [...existing.contentFiles, ...imageFiles];
      artifactsDataByUuid.set(uuid, existing);
    } catch (e) {
      // This conversation's images are skipped; its text/artefacts/uploaded
      // files (already in artifactsDataByUuid from Phase 1.5) are kept.
      // Never aborts the project/batch export.
    }
  }
}

function detectGptContext(url, tab) {
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');
  const selectRecentsBtn = document.getElementById('select-recents-btn');
  const selectAllRecentsBtn = document.getElementById('select-all-recents-btn');
  const confirmRecentsSelectionBtn = document.getElementById('confirm-recents-selection-btn');
  const contextMessage = document.getElementById('context-message');

  // Hide all Claude-specific controls we won't use.
  [selectRecentsBtn, selectAllRecentsBtn, confirmRecentsSelectionBtn].forEach((b) => { if (b) b.style.display = 'none'; });

  const ctx = gptDetectContext(url);

  if (ctx.kind === 'projects') {
    contextMessage.textContent = 'ChatGPT — select projects to export.';
    exportBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    selectProjectsBtn.textContent = 'Select GPT Projects';
    selectProjectsBtn.onclick = startGptSelection;
    return;
  }
  if (ctx.kind === 'project') {
    contextMessage.textContent = 'ChatGPT project detected.';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    exportBtn.style.display = 'block';
    exportBtn.textContent = 'Export GPT Project';
    exportBtn.disabled = false;
    exportBtn.onclick = () => startGptProjectExport(url, tab);
    return;
  }
  // conversation or unrelated GPT page
  contextMessage.textContent = 'Navigate to a ChatGPT project or the projects list to export.';
  exportBtn.style.display = 'none';
  selectProjectsBtn.style.display = 'none';
  confirmSelectionBtn.style.display = 'none';
}

async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  if (isGptHost(url)) {
    return detectGptContext(url, tab);
  }

  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');
  const selectRecentsBtn = document.getElementById('select-recents-btn');
  const selectAllRecentsBtn = document.getElementById('select-all-recents-btn');
  const confirmRecentsSelectionBtn = document.getElementById('confirm-recents-selection-btn');

  if (selectionMode || batchInProgress || recentsSelectionMode) {
    // Don't clobber the selection-mode/batch-export UI while either is in
    // progress — context re-detection from tab-switch listeners (fired by
    // this extension's own chrome.tabs.update() calls during a batch, among
    // other things) must not interrupt it or re-enable the single-project
    // export button against a tab a batch is actively driving.
    return;
  }

  const projectId = getProjectIdFromUrl(url);
  const conversationId = getConversationIdFromUrl(url);

  if (projectId) {
    exportMode = 'project';
    exportProjectId = projectId;
    contextMessage.textContent = 'Claude Project detected.';
    exportBtn.textContent = 'Export Project';
    exportBtn.style.display = 'block';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else if (conversationId) {
    exportMode = 'conversation';
    exportConversationId = conversationId;
    contextMessage.textContent = 'Claude Conversation detected.';
    exportBtn.textContent = 'Export Conversation';
    exportBtn.style.display = 'block';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else if (isProjectsListingUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude Projects list detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else if (isRecentsUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude recent conversations detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'block';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
    selectRecentsBtn.style.display = 'none';
    selectAllRecentsBtn.style.display = 'none';
    confirmRecentsSelectionBtn.style.display = 'none';
  }
}

function setStatus(message, kind) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind || '';
}

function waitForContentScriptReady(tabId, timeoutMs, expectedPathname) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = async () => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        // A stale content script on the PREVIOUS page can still answer PING
        // for a brief window after chrome.tabs.update() resolves (navigation
        // has only been initiated, not completed) — require the responding
        // page's own pathname to match the page we just navigated to, so we
        // don't proceed against the wrong page's content script.
        if (response && response.pong && (!expectedPathname || response.pathname.includes(expectedPathname))) {
          resolve(true);
          return;
        }
      } catch (e) {
        // Not ready yet — content script hasn't injected on the new page.
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
  document.getElementById('select-projects-btn').addEventListener('click', () => {
    enterSelectionMode();
  });
  document.getElementById('confirm-selection-btn').addEventListener('click', () => {
    confirmSelection();
  });
  document.getElementById('select-recents-btn').addEventListener('click', () => {
    enterRecentsSelectionMode();
  });
  document.getElementById('select-all-recents-btn').addEventListener('click', () => {
    selectAllRecents();
  });
  document.getElementById('confirm-recents-selection-btn').addEventListener('click', () => {
    confirmRecentsSelection();
  });
});

async function enterSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION_MODE' });
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the project list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }

  selectionMode = true;
  document.getElementById('select-projects-btn').style.display = 'none';
  document.getElementById('confirm-selection-btn').style.display = 'block';
  document.getElementById('confirm-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click project cards to select them, then click Confirm.';
  pollSelectionCount();
}

let selectionPollTimer = null;

function pollSelectionCount() {
  if (selectionPollTimer) clearInterval(selectionPollTimer);
  selectionPollTimer = setInterval(async () => {
    if (!selectionMode) {
      clearInterval(selectionPollTimer);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const projects = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_PROJECTS' });
      const count = Array.isArray(projects) ? projects.length : 0;
      document.getElementById('confirm-selection-btn').textContent = `Confirm Selection (${count})`;
    } catch (e) {
      // Content script not reachable (e.g. user navigated away) — leave the
      // last known count displayed rather than erroring the panel.
    }
  }, 500);
}

async function enterRecentsSelectionMode() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_RECENTS_SELECTION_MODE' });
    if (!response || !response.armed) {
      setStatus('Could not start selection mode — the conversations list was not found on this page.', 'error');
      return;
    }
  } catch (e) {
    setStatus('Could not start selection mode — try refreshing the page and reopening the panel.', 'error');
    return;
  }

  recentsSelectionMode = true;
  document.getElementById('select-recents-btn').style.display = 'none';
  document.getElementById('select-all-recents-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').style.display = 'block';
  document.getElementById('confirm-recents-selection-btn').textContent = 'Confirm Selection (0)';
  document.getElementById('context-message').textContent = 'Click conversation rows to select them, then click Confirm.';
  pollRecentsSelectionCount();
}

let recentsSelectionPollTimer = null;

function pollRecentsSelectionCount() {
  if (recentsSelectionPollTimer) clearInterval(recentsSelectionPollTimer);
  recentsSelectionPollTimer = setInterval(async () => {
    if (!recentsSelectionMode) {
      clearInterval(recentsSelectionPollTimer);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const conversations = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_RECENTS_CONVERSATIONS' });
      const count = Array.isArray(conversations) ? conversations.length : 0;
      document.getElementById('confirm-recents-selection-btn').textContent = `Confirm Selection (${count})`;
    } catch (e) {
      // Content script not reachable (e.g. user navigated away) — leave the
      // last known count displayed rather than erroring the panel.
    }
  }, 500);
}

async function selectAllRecents() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus('Scrolling to load all conversations...', '');
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SELECT_ALL_RECENTS_CONVERSATIONS' });
    const count = (response && response.count) || 0;
    document.getElementById('confirm-recents-selection-btn').textContent = `Confirm Selection (${count})`;
    if (count === 0) {
      setStatus('No conversations found on this page.', 'error');
    } else {
      setStatus(`Selected ${count} conversation(s).`, '');
    }
  } catch (e) {
    setStatus('Could not select all conversations — try refreshing the page.', 'error');
  }
}

async function confirmRecentsSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let selected = [];
  try {
    selected = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_RECENTS_CONVERSATIONS' });
  } catch (e) {
    selected = [];
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECENTS_SELECTION_MODE' });
  } catch (e) {
    // Best-effort cleanup — if this fails, the visual borders may linger on
    // the page until the next reload, but the export itself is unaffected.
  }

  if (recentsSelectionPollTimer) {
    clearInterval(recentsSelectionPollTimer);
    recentsSelectionPollTimer = null;
  }

  recentsSelectionMode = false;
  document.getElementById('select-all-recents-btn').style.display = 'none';
  document.getElementById('confirm-recents-selection-btn').style.display = 'none';

  if (!Array.isArray(selected) || selected.length === 0) {
    setStatus('No conversations were selected.', 'error');
    detectContext();
    return;
  }

  await startRecentsExport(selected);
}

async function startRecentsExport(conversationsSelected) {
  const selectBtn = document.getElementById('select-recents-btn');

  // Same guard as project export's navigation phase (runExport) and the
  // multi-project batch (startBatchExport): the navigation below is driven
  // by this function, not the user, so detectContext() must not reinterpret
  // it as the user browsing away mid-export.
  batchInProgress = true;
  exportBtnDisabledForBatch(true);

  try {
    setStatus('Resolving organization ID...', '');
    const orgId = await getOrganizationId();
    if (!orgId) {
      setStatus('Export failed: could not find your organization ID. Make sure you are logged into claude.ai.', 'error');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;
    const recentsPath = getRecentsPath(tab.url || '');

    setStatus(`Fetching ${conversationsSelected.length} conversation(s)...`, '');
    const conversations = await fetchAllConversations(orgId, conversationsSelected, (fetched, total) => {
      setStatus(`Fetched ${fetched}/${total} conversations...`, '');
    });

    if (conversations.length === 0) {
      setStatus('Export failed: could not fetch any of the selected conversations.', 'error');
      return;
    }

    const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);
    await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
      setStatus(`Capturing images ${current}/${total}: ${name}...`, '');
    });

    try {
      await chrome.tabs.update(tabId, { url: `https://claude.ai${recentsPath}` });
    } catch (e) {
      // Best-effort return navigation — the export itself has already succeeded.
    }

    setStatus(`Building zip for ${conversations.length} conversation(s)...`, '');
    const blob = await buildConversationsSelectionZip(conversations, artifactsDataByUuid);
    const downloadFilename = `conversations_selection_${conversations.length}.zip`;

    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });

    let finalMessage = `✅ Exported ${conversations.length}/${conversationsSelected.length} conversation(s).`;
    if (conversations.length < conversationsSelected.length) {
      finalMessage += ` ${conversationsSelected.length - conversations.length} failed to fetch.`;
    }
    setStatus(finalMessage, 'success');
  } finally {
    batchInProgress = false;
    exportBtnDisabledForBatch(false);
    selectBtn.style.display = 'block';
    await detectContext();
  }
}

async function confirmSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let projects = [];
  try {
    projects = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTED_PROJECTS' });
  } catch (e) {
    projects = [];
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SELECTION_MODE' });
  } catch (e) {
    // Best-effort cleanup — if this fails, the visual borders may linger on
    // the page until the next reload, but the batch itself is unaffected.
  }

  if (selectionPollTimer) {
    clearInterval(selectionPollTimer);
    selectionPollTimer = null;
  }

  selectionMode = false;
  document.getElementById('confirm-selection-btn').style.display = 'none';

  if (!Array.isArray(projects) || projects.length === 0) {
    setStatus('No projects were selected.', 'error');
    detectContext();
    return;
  }

  selectedProjects = projects;
  await startBatchExport(selectedProjects);
}

async function startBatchExport(projects) {
  const selectBtn = document.getElementById('select-projects-btn');

  // While a batch is in progress, this function itself drives the active
  // tab's navigation via chrome.tabs.update() — each of those triggers this
  // panel's own chrome.tabs.onUpdated listener, which would otherwise call
  // detectContext() mid-batch and re-enable the single-project "Export
  // Project" button against the very tab the batch is driving. Guarding on
  // batchInProgress (checked by detectContext()) prevents that.
  batchInProgress = true;
  exportBtnDisabledForBatch(true);

  try {
    setStatus('Resolving organization ID...', '');
    const orgId = await getOrganizationId();
    if (!orgId) {
      setStatus('Batch export failed: could not find your organization ID. Make sure you are logged into claude.ai.', 'error');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;
    const basePath = getProjectBasePath(tab.url || '');

    const zip = new JSZip();
    const succeeded = [];
    const failed = [];

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      setStatus(`Scraping project ${i + 1}/${projects.length}: ${project.name}...`, '');

      try {
        await chrome.tabs.update(tabId, { url: `https://claude.ai${basePath}${project.uuid}` });

        const ready = await waitForContentScriptReady(tabId, 15000, `${basePath}${project.uuid}`);
        if (!ready) {
          throw new Error('page did not finish loading in time');
        }

        const conversationsList = await fetchConversationsList(orgId, project.uuid);
        if (!conversationsList || conversationsList.length === 0) {
          throw new Error('no conversations found');
        }

        let projectMetadata = { memory: null, instructions: null };
        try {
          const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROJECT_METADATA' });
          if (response) {
            projectMetadata = response;
          }
        } catch (e) {
          // Proceed without memory/instructions for this project.
        }

        const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
          setStatus(`Scraping project ${i + 1}/${projects.length}: ${project.name} (${fetched}/${total} conversations)...`, '');
        });

        if (conversations.length === 0) {
          throw new Error('failed to fetch any conversations');
        }

        const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);
        await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
          setStatus(`Capturing images ${current}/${total} in ${project.name}: ${name}...`, '');
        });

        const folderName = `${sanitizeFilename(project.name)}_${project.uuid.substring(0, 8)}`;
        await buildProjectZip(zip, folderName, project.uuid, conversations, projectMetadata, artifactsDataByUuid);

        succeeded.push(project.name);
      } catch (error) {
        failed.push({ name: project.name, reason: error.message });
      }
    }

    if (succeeded.length === 0) {
      setStatus(`Batch export failed: all ${projects.length} project(s) failed. ${failed.map(f => `${f.name}: ${f.reason}`).join('; ')}`, 'error');
      return;
    }

    setStatus(`Building combined zip for ${succeeded.length} project(s)...`, '');
    const blob = await zip.generateAsync({ type: 'blob' });
    const downloadFilename = `projects_batch_${succeeded.length}.zip`;

    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });

    let finalMessage = `✅ Batch export complete: ${succeeded.length}/${projects.length} project(s) exported.`;
    if (failed.length > 0) {
      finalMessage += ` Failed: ${failed.map(f => `${f.name} (${f.reason})`).join(', ')}.`;
    }
    setStatus(finalMessage, 'success');
  } finally {
    batchInProgress = false;
    exportBtnDisabledForBatch(false);
    selectBtn.style.display = 'block';
    await detectContext();
  }
}

function exportBtnDisabledForBatch(disabled) {
  document.getElementById('export-btn').disabled = disabled;
}

// The side panel is persistent (unlike the old popup, it doesn't reload on
// every open), so context must be re-detected whenever the active tab
// changes or navigates, not just once at panel load.
chrome.tabs.onActivated.addListener(() => {
  detectContext();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    detectContext();
  }
});

async function runExport() {
  const exportBtn = document.getElementById('export-btn');
  exportBtn.disabled = true;

  try {
    setStatus('Resolving organization ID...', '');
    const orgId = await getOrganizationId();
    if (!orgId) {
      throw new Error('Could not find your organization ID. Make sure you are logged into claude.ai.');
    }

    let blob, downloadFilename;

    if (exportMode === 'project') {
      // Capture a local copy up front: captureProjectConversationImages()
      // below navigates the tab repeatedly, and each navigation fires
      // detectContext() (via chrome.tabs.onUpdated) which would otherwise
      // overwrite the exportProjectId global mid-export once the tab lands
      // on a /chat/{uuid} page.
      const projectId = exportProjectId;

      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, projectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab.id;
      const basePath = getProjectBasePath(tab.url || '');

      let projectMetadata = { memory: null, instructions: null };
      let contentScriptUnreachable = false;
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without memory/instructions.
        contentScriptUnreachable = true;
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      const artifactsDataByUuid = buildArtifactsDataByUuid(orgId, conversations);

      // Guard detectContext() the same way the multi-project batch does:
      // the navigation below is driven by this function, not the user, so
      // the panel's tab-switch listener must not reinterpret it as the user
      // browsing to a different project/conversation mid-export.
      batchInProgress = true;
      try {
        await captureProjectConversationImages(tabId, conversations, artifactsDataByUuid, (current, total, name) => {
          setStatus(`Capturing images ${current}/${total}: ${name}...`, '');
        });

        try {
          await chrome.tabs.update(tabId, { url: `https://claude.ai${basePath}${projectId}` });
        } catch (e) {
          // Best-effort return navigation — the export itself has already succeeded.
        }
      } finally {
        batchInProgress = false;
        await detectContext();
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      const projectZip = new JSZip();
      await buildProjectZip(projectZip, '', projectId, conversations, projectMetadata, artifactsDataByUuid);
      blob = await projectZip.generateAsync({ type: 'blob' });
      downloadFilename = `project_${projectId.substring(0, 8)}.zip`;

      let projectStatusMessage;
      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        projectStatusMessage = `✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`;
      } else {
        projectStatusMessage = `✅ Exported ${conversations.length} conversations.`;
      }
      if (contentScriptUnreachable) {
        projectStatusMessage += ' ⚠️ Could not capture memory/instructions — refresh the project page and try again to include them.';
      }
      setStatus(projectStatusMessage, 'success');
    } else if (exportMode === 'conversation') {
      setStatus('Fetching conversation...', '');
      const data = await fetchConversation(orgId, exportConversationId);
      if (!data) {
        throw new Error('Failed to fetch this conversation.');
      }

      const conversation = { metadata: { name: data.name, uuid: data.uuid, created_at: data.created_at, updated_at: data.updated_at, model: data.model }, data };

      // The conversation JSON itself contains every /mnt/user-data/uploads/
      // and /mnt/user-data/outputs/ file path claude.ai's own UI uses to
      // build its download links — see buildArtifactsDataFromConversationJson.
      let artifactsData = buildArtifactsDataFromConversationJson(orgId, exportConversationId, data);
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' });
        if (response) {
          // Image content files still come from the DOM (their /preview URL
          // isn't derivable from a /mnt/user-data path), merged alongside
          // the JSON-derived uploads.
          artifactsData.contentFiles = [...artifactsData.contentFiles, ...(response.contentFiles || [])];
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without image content files.
        contentScriptUnreachable = true;
      }

      setStatus('Building zip...', '');
      blob = await buildConversationZip(conversation, artifactsData);
      downloadFilename = `${conversationFolderName(conversation)}.zip`;

      let conversationStatusMessage = '✅ Exported conversation.';
      if (contentScriptUnreachable) {
        conversationStatusMessage += ' ⚠️ Could not capture artifacts/content — refresh the conversation page and try again to include them.';
      }
      setStatus(conversationStatusMessage, 'success');
    } else {
      throw new Error('No project or conversation detected.');
    }

    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: downloadFilename, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, 'error');
  } finally {
    exportBtn.disabled = false;
  }
}
