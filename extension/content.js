function extractSectionText(labelText) {
  const headings = document.querySelectorAll('h3');

  for (const heading of headings) {
    const headingText = heading.textContent.trim();
    if (headingText !== labelText) continue;

    let container = heading.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const paragraph = container.querySelector('p');
      if (paragraph && paragraph.textContent.trim()) {
        return paragraph.textContent.trim();
      }
      container = container.parentElement;
    }
  }

  return null;
}

function getProjectMetadata() {
  return {
    memory: extractSectionText('Mémoire'),
    instructions: extractSectionText('Instructions')
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'GET_PROJECT_METADATA') {
    sendResponse(getProjectMetadata());
  }
  return false;
});
