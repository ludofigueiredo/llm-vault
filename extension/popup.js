let exportMode = null; // 'project' | 'conversation' | null
let exportProjectId = null;
let exportConversationId = null;

async function detectContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url || '';

  const contextMessage = document.getElementById('context-message');
  const exportBtn = document.getElementById('export-btn');

  const projectId = getProjectIdFromUrl(url);
  const conversationId = getConversationIdFromUrl(url);

  if (projectId) {
    exportMode = 'project';
    exportProjectId = projectId;
    contextMessage.textContent = 'Claude Project detected.';
    exportBtn.textContent = 'Export Project';
    exportBtn.style.display = 'block';
  } else if (conversationId) {
    exportMode = 'conversation';
    exportConversationId = conversationId;
    contextMessage.textContent = 'Claude Conversation detected.';
    exportBtn.textContent = 'Export Conversation';
    exportBtn.style.display = 'block';
  } else {
    exportMode = null;
    contextMessage.textContent = 'Navigate to a Claude project (claude.ai/project/...) or conversation (claude.ai/chat/...) page to export it.';
    exportBtn.style.display = 'none';
  }
}

function setStatus(message, kind) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = kind || '';
}

document.addEventListener('DOMContentLoaded', () => {
  detectContext();
  document.getElementById('export-btn').addEventListener('click', () => {
    runExport();
  });
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
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_METADATA' });
        if (response) {
          projectMetadata = response;
        }
      } catch (e) {
        // Content script not present/responsive — proceed without memory/instructions.
      }

      const conversations = await fetchAllConversations(orgId, conversationsList, (fetched, total) => {
        setStatus(`Fetched ${fetched}/${total} conversations...`, '');
      });

      if (conversations.length === 0) {
        throw new Error('Failed to fetch any conversations.');
      }

      setStatus(`Building zip for ${conversations.length} conversations...`, '');
      blob = await buildProjectZip(exportProjectId, conversations, projectMetadata);
      downloadFilename = `project_${exportProjectId.substring(0, 8)}.zip`;

      if (conversations.length < conversationsList.length) {
        const failedCount = conversationsList.length - conversations.length;
        setStatus(`✅ Exported ${conversations.length}/${conversationsList.length} conversations (${failedCount} failed to fetch).`, 'success');
      } else {
        setStatus(`✅ Exported ${conversations.length} conversations.`, 'success');
      }
    } else if (exportMode === 'conversation') {
      setStatus('Fetching conversation...', '');
      const data = await fetchConversation(orgId, exportConversationId);
      if (!data) {
        throw new Error('Failed to fetch this conversation.');
      }

      const conversation = { metadata: { name: data.name, uuid: data.uuid, created_at: data.created_at, updated_at: data.updated_at, model: data.model }, data };

      let artifactsData = { artifactsZip: null, contentFiles: [] };
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setStatus('Capturing artifacts and content files...', '');
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION_ARTIFACTS' });
        if (response) {
          artifactsData = response;
        }
      } catch (e) {
        // Content script not present/responsive — proceed without artifacts/content.
      }

      setStatus('Building zip...', '');
      blob = await buildConversationZip(conversation, artifactsData);
      downloadFilename = `${conversationFolderName(conversation)}.zip`;
      setStatus('✅ Exported conversation.', 'success');
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
