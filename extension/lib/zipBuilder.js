function buildConversationFolder(zip, folderName, conversation) {
  const folder = zip.folder(folderName);
  folder.file('conversation.md', convertToMarkdown(conversation));
  folder.folder('artefacts').file('.gitkeep', '');
  folder.folder('contenu').file('.gitkeep', '');
}

async function buildProjectZip(projectId, conversations) {
  const zip = new JSZip();
  zip.file('index.md', createIndexMarkdown(projectId, conversations));

  conversations.forEach(conv => {
    const folderName = conversationFolderName(conv);
    buildConversationFolder(zip, folderName, conv);
  });

  return zip.generateAsync({ type: 'blob' });
}

async function buildConversationZip(conversation) {
  const zip = new JSZip();
  const folderName = conversationFolderName(conversation);
  buildConversationFolder(zip, folderName, conversation);
  return zip.generateAsync({ type: 'blob' });
}
