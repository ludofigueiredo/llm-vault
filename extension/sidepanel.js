let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;
let selectionMode = false;
let selectedProjects = [];

function isProjectsListingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'claude.ai' && parsed.pathname === '/projects';
  } catch (e) {
    return false;
  }
}

async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');
  const selectProjectsBtn = document.getElementById('select-projects-btn');
  const confirmSelectionBtn = document.getElementById('confirm-selection-btn');

  if (selectionMode) {
    // Don't clobber the selection-mode UI while a selection is in progress —
    // context re-detection from tab-switch listeners must not interrupt it.
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
  } else if (conversationId) {
    exportMode = 'conversation';
    exportConversationId = conversationId;
    contextMessage.textContent = 'Claude Conversation detected.';
    exportBtn.textContent = 'Export Conversation';
    exportBtn.style.display = 'block';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
  } else if (isProjectsListingUrl(url)) {
    exportMode = null;
    contextMessage.textContent = 'Claude Projects list detected.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'block';
    confirmSelectionBtn.style.display = 'none';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
    selectProjectsBtn.style.display = 'none';
    confirmSelectionBtn.style.display = 'none';
  }
}

function setStatus(message, kind) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind || '';
}

function waitForContentScriptReady(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = async () => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (response && response.pong) {
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
  const confirmBtn = document.getElementById('confirm-selection-btn');
  const selectBtn = document.getElementById('select-projects-btn');

  setStatus('Resolving organization ID...', '');
  const orgId = await getOrganizationId();
  if (!orgId) {
    setStatus('Batch export failed: could not find your organization ID. Make sure you are logged into claude.ai.', 'error');
    selectBtn.style.display = 'block';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;

  const zip = new JSZip();
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    setStatus(`Scraping project ${i + 1}/${projects.length}: ${project.name}...`, '');

    try {
      await chrome.tabs.update(tabId, { url: `https://claude.ai/project/${project.uuid}` });

      const ready = await waitForContentScriptReady(tabId, 15000);
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

      const folderName = `${sanitizeFilename(project.name)}_${project.uuid.substring(0, 8)}`;
      await buildProjectZip(zip, folderName, project.uuid, conversations, projectMetadata);

      succeeded.push(project.name);
    } catch (error) {
      failed.push({ name: project.name, reason: error.message });
    }
  }

  if (succeeded.length === 0) {
    setStatus(`Batch export failed: all ${projects.length} project(s) failed. ${failed.map(f => `${f.name}: ${f.reason}`).join('; ')}`, 'error');
    selectBtn.style.display = 'block';
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
  selectBtn.style.display = 'block';
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
      setStatus('Fetching conversations list...', '');
      const conversationsList = await fetchConversationsList(orgId, exportProjectId);

      if (!conversationsList || conversationsList.length === 0) {
        throw new Error('No conversations found in this project.');
      }

      let projectMetadata = { memory: null, instructions: null };
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_METADATA' });
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

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      const projectZip = new JSZip();
      await buildProjectZip(projectZip, '', exportProjectId, conversations, projectMetadata);
      blob = await projectZip.generateAsync({ type: 'blob' });
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

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

      let artifactsData = { artifactsZip: null, contentFiles: [] };
      let contentScriptUnreachable = false;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' });
        if (response) {
          artifactsData = response;
        }
      } catch (e) {
        // Content script not present/responsive (e.g. the page was open before the
        // extension was installed/reloaded) — proceed without artifacts/content.
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
