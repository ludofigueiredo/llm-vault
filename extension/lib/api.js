function buildConversationsListUrl(orgId, projectId, limit = 1000, offset = 0) {
  return `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/conversations_v2?limit=${limit}&offset=${offset}`;
}

async function fetchConversationsList(orgId, projectId) {
  const url = buildConversationsListUrl(orgId, projectId);
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Authentication failed. Please log in to Claude and try again.');
    if (response.status === 403) throw new Error('Access denied. Make sure you have access to this project.');
    if (response.status === 404) throw new Error('Project not found. Check the project ID.');
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.data && Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  throw new Error('Invalid response structure - expected data.data array');
}

async function fetchConversation(orgId, conversationId, retries = 3) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'include' });

      if (response.status === 429) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}

async function fetchAllConversations(orgId, conversationsList, onProgress) {
  const conversations = [];
  const total = conversationsList.length;
  const batchSize = 5;

  for (let i = 0; i < total; i += batchSize) {
    const batch = conversationsList.slice(i, Math.min(i + batchSize, total));

    const batchPromises = batch.map(conv =>
      fetchConversation(orgId, conv.uuid).then(data => ({ metadata: conv, data }))
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value.data) {
        conversations.push(result.value);
      }
    }

    const fetched = Math.min(i + batchSize, total);
    if (onProgress) onProgress(fetched, total);

    if (i + batchSize < total) {
      const delay = total > 50 ? 750 : 500;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return conversations;
}

// Matches /mnt/user-data/uploads/<name> or /mnt/user-data/outputs/<name> as
// they appear inside the conversation JSON's string values (tool_use bash
// commands, tool_result output, chat_messages[].files[].path, etc.). Some of
// these strings are multi-line bash commands rather than a bare path, so the
// filename portion is restricted to characters plausible in a real
// filename (word chars, spaces, dots, hyphens, parens) rather than reading
// until the next quote — otherwise a `cp src dst\n...` command would swallow
// everything up to its own closing quote as part of the "path".
const USER_DATA_PATH_PATTERN = /\/mnt\/user-data\/(uploads|outputs)\/[\w .()-]+\.[\w]+/g;

function extractFilePaths(conversationData) {
  const json = JSON.stringify(conversationData);
  const uploads = new Set();
  const outputs = new Set();

  let match;
  while ((match = USER_DATA_PATH_PATTERN.exec(json)) !== null) {
    const bucket = match[1];
    const path = match[0];
    if (bucket === 'uploads') uploads.add(path);
    else outputs.add(path);
  }

  return { uploads: [...uploads], outputs: [...outputs] };
}
