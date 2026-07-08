async function fetchFilesInto(folder, files) {
  let anySucceeded = false;
  for (const file of files) {
    try {
      const response = await fetch(file.url, { credentials: 'include' });
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      folder.file(file.filename, buffer);
      anySucceeded = true;
    } catch (e) {
      // Skip this file, continue with the rest.
    }
  }
  if (!anySucceeded) {
    folder.file('.gitkeep', '');
  }
}

async function buildConversationFolder(zip, folderName, conversation, artifactsData) {
  const folder = zip.folder(folderName);
  folder.file('conversation.md', convertToMarkdown(conversation));

  const artefactsFolder = folder.folder('artefacts');
  const artifactFiles = (artifactsData && artifactsData.artifactFiles) || [];
  await fetchFilesInto(artefactsFolder, artifactFiles);

  const contenuFolder = folder.folder('contenu');
  const contentFiles = (artifactsData && artifactsData.contentFiles) || [];
  await fetchFilesInto(contenuFolder, contentFiles);
}

async function buildProjectZip(zip, folderPath, projectId, conversations, projectMetadata) {
  const target = folderPath ? zip.folder(folderPath) : zip;

  target.file('index.md', createIndexMarkdown(projectId, conversations));

  if (projectMetadata && projectMetadata.memory) {
    target.file('memory.md', projectMetadata.memory);
  }
  if (projectMetadata && projectMetadata.instructions) {
    target.file('instructions.md', projectMetadata.instructions);
  }
  target.folder('fichiers').file('.gitkeep', '');

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    await buildConversationFolder(target, folderName, conv);
  }
}

async function buildConversationZip(conversation, artifactsData) {
  const zip = new JSZip();
  const folderName = conversationFolderName(conversation);
  await buildConversationFolder(zip, folderName, conversation, artifactsData);
  return zip.generateAsync({ type: 'blob' });
}
