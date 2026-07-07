function getProjectIdFromUrl(url) {
  const match = url.match(/\/project\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return match ? match[1] : null;
}

function getConversationIdFromUrl(url) {
  const match = url.match(/\/chat\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return match ? match[1] : null;
}

function getOrganizationId() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' }, (cookie) => {
      resolve(cookie ? cookie.value : null);
    });
  });
}
