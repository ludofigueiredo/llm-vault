async function buildConversationFolder(zip, folderName, conversation, artifactsData) {
  const folder = zip.folder(folderName);
  folder.file('conversation.md', convertToMarkdown(conversation));

  const artefactsFolder = folder.folder('artefacts');
  if (artifactsData && artifactsData.artifactsZip) {
    const artifactsZipInstance = await JSZip.loadAsync(artifactsData.artifactsZip);
    const entries = [];
    artifactsZipInstance.forEach((relativePath, entry) => {
      entries.push({ relativePath, entry });
    });
    for (const { relativePath, entry } of entries) {
      if (entry.dir) continue;
      const content = await entry.async('arraybuffer');
      artefactsFolder.file(relativePath, content);
    }
  } else {
    artefactsFolder.file('.gitkeep', '');
  }

  const contenuFolder = folder.folder('contenu');
  const contentFiles = (artifactsData && artifactsData.contentFiles) || [];
  if (contentFiles.length > 0) {
    let anySucceeded = false;
    for (const file of contentFiles) {
      try {
        const response = await fetch(file.url, { credentials: 'include' });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        contenuFolder.file(file.filename, buffer);
        anySucceeded = true;
      } catch (e) {
        // Skip this file, continue with the rest.
      }
    }
    if (!anySucceeded) {
      contenuFolder.file('.gitkeep', '');
    }
  } else {
    contenuFolder.file('.gitkeep', '');
  }
}

async function buildProjectZip(projectId, conversations, projectMetadata) {
  const zip = new JSZip();
  zip.file('index.md', createIndexMarkdown(projectId, conversations));

  if (projectMetadata && projectMetadata.memory) {
    zip.file('memory.md', projectMetadata.memory);
  }
  if (projectMetadata && projectMetadata.instructions) {
    zip.file('instructions.md', projectMetadata.instructions);
  }
  zip.folder('fichiers').file('.gitkeep', '');

  for (const conv of conversations) {
    const folderName = conversationFolderName(conv);
    await buildConversationFolder(zip, folderName, conv);
  }

  return zip.generateAsync({ type: 'blob' });
}

async function buildConversationZip(conversation, artifactsData) {
  const zip = new JSZip();
  const folderName = conversationFolderName(conversation);
  await buildConversationFolder(zip, folderName, conversation, artifactsData);
  return zip.generateAsync({ type: 'blob' });
}
