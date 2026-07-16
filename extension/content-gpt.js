// GPT content script — pure DOM scraping (no REST API). Injected on
// chatgpt.com. Fully independent of the Claude content.js.

function gptWaitForCondition(checkFn, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const result = checkFn();
      if (result) { resolve(result); return; }
      if (Date.now() - start >= timeoutMs) { resolve(null); return; }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function gptGetProjectTitle() {
  const h1Btn = document.querySelector('button[name="project-title"]');
  if (h1Btn) return h1Btn.textContent.trim();
  const h1 = document.querySelector('h1');
  return h1 ? h1.textContent.trim() : '';
}

async function gptGetProjectMetadata() {
  const fallback = { name: gptGetProjectTitle(), instructions: '' };

  const detailsBtn = document.querySelector('button[aria-label="Afficher les détails du projet"]');
  if (!detailsBtn) return fallback;
  detailsBtn.click();

  const dialog = await gptWaitForCondition(
    () => document.querySelector('div[role="dialog"] input#project-name'),
    5000, 100
  );
  if (!dialog) return fallback;

  const nameInput = document.querySelector('div[role="dialog"] input#project-name');
  const instrArea = document.querySelector('div[role="dialog"] textarea#instructions');
  const result = {
    name: (nameInput && nameInput.value.trim()) || fallback.name,
    instructions: (instrArea && instrArea.value.trim()) || '',
  };

  const closeBtn = document.querySelector('div[role="dialog"] button[data-testid="close-button"]');
  if (closeBtn) closeBtn.click();

  return result;
}

function gptFindConversationLinks() {
  // Conversation rows on a project page carry a real href:
  // /g/g-p-<id>-<slug>/c/<convId>
  return [...document.querySelectorAll('a[href*="/c/"]')].filter((a) =>
    /\/g\/g-p-[a-f0-9]+-[^/]*\/c\/[a-f0-9-]+/.test(a.getAttribute('href') || '')
  );
}

function gptScrapeConversationList() {
  const seen = new Set();
  const conversations = [];
  for (const a of gptFindConversationLinks()) {
    const href = a.getAttribute('href');
    const m = href.match(/\/c\/([a-f0-9-]+)/);
    if (!m) continue;
    const convId = m[1];
    if (seen.has(convId)) continue;
    seen.add(convId);
    const titleEl = a.querySelector('.text-sm.font-medium');
    const title = (titleEl && titleEl.textContent.trim()) || convId;
    conversations.push({ title, convId });
  }
  return conversations;
}

function gptWaitForListToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;
    const poll = () => {
      window.scrollTo(0, document.body.scrollHeight);
      const count = gptFindConversationLinks().length;
      if (count === lastCount) { stableChecks++; }
      else { stableChecks = 0; lastCount = count; }
      if (stableChecks >= stableChecksRequired || Date.now() - start >= timeoutMs) {
        resolve(count); return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

async function gptGetProjectConversations() {
  await gptWaitForListToStabilize(30000, 3, 500);
  return { conversations: gptScrapeConversationList() };
}

function gptFindTurns() {
  return [...document.querySelectorAll('section[data-turn-id]')];
}

function gptWaitForThreadToStabilize(timeoutMs, stableChecksRequired, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;
    // Scroll the thread's scroll container. ChatGPT threads live in a
    // scrollable main; scrolling window + the main covers both layouts.
    const poll = () => {
      window.scrollTo(0, 0); // load earliest turns first
      const count = gptFindTurns().length;
      if (count === lastCount) { stableChecks++; }
      else { stableChecks = 0; lastCount = count; }
      if (stableChecks >= stableChecksRequired || Date.now() - start >= timeoutMs) {
        resolve(count); return;
      }
      window.scrollTo(0, document.body.scrollHeight);
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function gptScrapeTurn(section) {
  const roleEl = section.querySelector('[data-message-author-role]');
  if (!roleEl) return null;
  const role = roleEl.getAttribute('data-message-author-role');
  if (role === 'user') {
    const bubble = roleEl.querySelector('.whitespace-pre-wrap');
    return { role: 'user', text: bubble ? bubble.textContent : roleEl.textContent };
  }
  const md = roleEl.querySelector('.markdown');
  return { role: 'assistant', html: md ? md.innerHTML : roleEl.innerHTML };
}

function gptScrapeThreadImages() {
  const files = [];
  const seen = new Set();
  const imgs = document.querySelectorAll('section[data-turn-id] img[src*="backend-api"]');
  imgs.forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || seen.has(src)) return;
    seen.add(src);
    const alt = img.getAttribute('alt') || `image_${files.length + 1}`;
    const url = new URL(src, window.location.origin).href;
    files.push({ filename: alt, url });
  });
  return files;
}

async function gptGetConversation() {
  await gptWaitForThreadToStabilize(30000, 3, 500);
  const turns = [];
  for (const section of gptFindTurns()) {
    const turn = gptScrapeTurn(section);
    if (turn) turns.push(turn);
  }
  return { turns, contentFiles: gptScrapeThreadImages() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'PING') {
    sendResponse({ pong: true, pathname: window.location.pathname });
    return false;
  }
  if (message && message.type === 'GET_GPT_PROJECT_METADATA') {
    gptGetProjectMetadata().then(sendResponse);
    return true;
  }
  if (message && message.type === 'GET_GPT_PROJECT_CONVERSATIONS') {
    gptGetProjectConversations().then(sendResponse);
    return true;
  }
  if (message && message.type === 'GET_GPT_CONVERSATION') {
    gptGetConversation().then(sendResponse);
    return true;
  }
  return false;
});
