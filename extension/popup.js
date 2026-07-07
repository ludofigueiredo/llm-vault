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
  setStatus('Export logic not yet implemented.', 'error');
}
