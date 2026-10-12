function gptSanitizeFilename(name) {
  return (name || 'sans-titre')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function gptConvFolderName(conv) {
  const title = gptSanitizeFilename(conv.title);
  const short = (conv.convId || '').slice(0, 8);
  return `${title}_${short}`;
}

function gptTurnsToMarkdown(project, turns) {
  const lines = [`# ${project.name || 'Conversation'}`, ''];
  for (const turn of turns) {
    const heading = turn.role === 'user' ? '## Vous' : '## ChatGPT';
    lines.push(heading, '', (turn.markdown || '').trim(), '');
  }
  return lines.join('\n');
}

function gptInstructionsMarkdown(project) {
  return [
    `# ${project.name || 'Projet'}`,
    '',
    '## Instructions',
    '',
    (project.instructions || '').trim(),
    '',
  ].join('\n');
}

function gptIndexMarkdown(project, conversations) {
  const lines = [`# ${project.name || 'Projet'}`, '', '## Conversations', ''];
  for (const conv of conversations) {
    const folder = gptConvFolderName(conv);
    lines.push(`- [${conv.title || 'sans-titre'}](Conversations/${folder}/conversation.md)`);
  }
  lines.push('');
  const sourceFiles = project.sourceFiles || [];
  if (sourceFiles.length > 0) {
    lines.push('## Sources', '');
    for (const f of sourceFiles) {
      lines.push(`- [${f.filename}](fichiers/${f.filename})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gptTurnsToMarkdown,
    gptInstructionsMarkdown,
    gptIndexMarkdown,
    gptConvFolderName,
    gptSanitizeFilename,
  };
}
