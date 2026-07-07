function sanitizeFilename(filename) {
  if (!filename) return 'untitled_conversation';

  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100)
    || 'untitled_conversation';
}

function conversationFolderName(conversation) {
  const uuid = conversation.metadata.uuid || conversation.data?.uuid || '';
  const uuidSuffix = uuid ? `_${uuid.substring(0, 8)}` : '';
  return `${sanitizeFilename(conversation.metadata.name)}${uuidSuffix}`;
}

function convertToMarkdown(conversation) {
  const { metadata, data } = conversation;

  if (!data || !data.chat_messages) {
    return `# ${metadata.name}\n\n*Failed to load conversation data*\n\n---\n\n`;
  }

  let markdown = `# ${data.name || metadata.name}\n\n`;

  if (data.summary) {
    markdown += `## Summary\n${data.summary}\n\n`;
  }

  markdown += `*Created: ${new Date(data.created_at || metadata.created_at).toLocaleString()}*\n`;
  markdown += `*Updated: ${new Date(data.updated_at || metadata.updated_at).toLocaleString()}*\n`;
  markdown += `*Model: ${metadata.model}*\n\n`;
  markdown += `---\n\n`;

  data.chat_messages.forEach(message => {
    const sender = message.sender === 'human' ? '👤 **Human**' : '🤖 **Claude**';
    markdown += `## ${sender}\n\n`;

    if (message.content && message.content.length > 0) {
      message.content.forEach(content => {
        if (content.type === 'thinking' && content.thinking) {
          const thinkingText = content.thinking.includes('characters truncated')
            ? '**Note:** Full thinking content is truncated in the export.\n\n'
            : content.thinking;
          markdown += `**Thinking:**\n\`\`\`\n${thinkingText}\n\`\`\`\n\n`;
        } else if (content.type === 'text' && content.text) {
          markdown += `${content.text}\n\n`;
        } else if (content.type === 'tool_use' && content.input) {
          markdown += `**Tool Use:**\n\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
        } else if (content.type === 'tool_result' && content.content) {
          markdown += `**Tool Result:**\n\`\`\`\n`;
          if (Array.isArray(content.content)) {
            content.content.forEach(item => {
              if (item.type === 'text') markdown += item.text;
            });
          } else {
            markdown += JSON.stringify(content.content, null, 2);
          }
          markdown += `\n\`\`\`\n\n`;
        }
      });
    }

    if (message.attachments && message.attachments.length > 0) {
      markdown += `### Attachments:\n`;
      message.attachments.forEach(attachment => {
        markdown += `- **${attachment.file_name || 'Attachment'}** (${attachment.file_type || 'file'})\n`;
        if (attachment.extracted_content && !attachment.extracted_content.includes('truncated')) {
          markdown += `  \`\`\`\n${attachment.extracted_content.substring(0, 500)}...\n  \`\`\`\n`;
        }
      });
      markdown += `\n`;
    }

    markdown += `*${new Date(message.created_at).toLocaleString()}*\n\n`;
    markdown += `---\n\n`;
  });

  return markdown;
}

function createIndexMarkdown(projectId, conversations) {
  let markdown = `# Claude Project Export\n\n`;
  markdown += `*Project ID: ${projectId}*\n`;
  markdown += `*Export Date: ${new Date().toLocaleString()}*\n`;
  markdown += `*Total Conversations: ${conversations.length}*\n\n`;
  markdown += `---\n\n`;
  markdown += `## Conversations\n\n`;

  const sorted = [...conversations].sort((a, b) =>
    new Date(b.metadata.updated_at) - new Date(a.metadata.updated_at)
  );

  sorted.forEach((conv, index) => {
    const folderName = conversationFolderName(conv);
    markdown += `${index + 1}. [${conv.metadata.name}](./${folderName}/conversation.md)\n`;
    markdown += `   - Created: ${new Date(conv.metadata.created_at).toLocaleDateString()}\n`;
    markdown += `   - Updated: ${new Date(conv.metadata.updated_at).toLocaleDateString()}\n`;
    markdown += `   - Model: ${conv.metadata.model}\n\n`;
  });

  return markdown;
}
