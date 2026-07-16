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

// --- Self-contained HTML -> Markdown -------------------------------------
// Walks a parsed DOM tree and emits markdown for the tags GPT threads use.
// `parser` must expose parse(html) -> root node whose descendants have:
// nodeType (1 element / 3 text), nodeName (upper-case), childNodes,
// textContent, getAttribute(name). In the browser we build this from
// DOMParser; the test injects a fake parser so no browser globals are used.

function gptDefaultParser() {
  return {
    parse(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.body;
    },
  };
}

function gptInlineToMd(node) {
  if (node.nodeType === 3) return node.textContent;
  const inner = (node.childNodes || []).map(gptInlineToMd).join('');
  switch (node.nodeName) {
    case 'STRONG':
    case 'B':
      return `**${inner}**`;
    case 'EM':
    case 'I':
      return `*${inner}*`;
    case 'CODE':
      return `\`${inner}\``;
    case 'A': {
      const href = node.getAttribute('href') || '';
      return href ? `[${inner}](${href})` : inner;
    }
    case 'BR':
      return '\n';
    default:
      return inner;
  }
}

function gptBlockToMd(node, out) {
  const name = node.nodeName;
  if (node.nodeType === 3) {
    const t = node.textContent.trim();
    if (t) out.push(t, '');
    return;
  }
  if (/^H[1-6]$/.test(name)) {
    const level = Number(name[1]);
    out.push(`${'#'.repeat(level)} ${gptInlineToMd(node).trim()}`, '');
    return;
  }
  switch (name) {
    case 'P':
      out.push(gptInlineToMd(node).trim(), '');
      return;
    case 'HR':
      out.push('---', '');
      return;
    case 'PRE': {
      const code = node.textContent.replace(/\n$/, '');
      out.push('```', code, '```', '');
      return;
    }
    case 'BLOCKQUOTE':
      out.push(gptInlineToMd(node).trim().split('\n').map((l) => `> ${l}`).join('\n'), '');
      return;
    case 'UL':
    case 'OL': {
      let i = 1;
      for (const li of node.childNodes || []) {
        if (li.nodeName !== 'LI') continue;
        const marker = name === 'OL' ? `${i++}.` : '-';
        out.push(`${marker} ${gptInlineToMd(li).trim()}`);
      }
      out.push('');
      return;
    }
    default: {
      // Unknown block: recurse into children so nested content survives.
      for (const child of node.childNodes || []) gptBlockToMd(child, out);
    }
  }
}

function gptHtmlToMarkdown(html, parser) {
  const p = parser || gptDefaultParser();
  const root = p.parse(html);
  const out = [];
  for (const child of root.childNodes || []) gptBlockToMd(child, out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// -------------------------------------------------------------------------

function gptTurnsToMarkdown(project, turns, htmlToMd) {
  const convert = htmlToMd || gptHtmlToMarkdown;
  const lines = [`# ${project.name || 'Conversation'}`, ''];
  for (const turn of turns) {
    if (turn.role === 'user') {
      lines.push('## Vous', '', (turn.text || '').trim(), '');
    } else {
      const body = turn.html ? convert(turn.html) : (turn.text || '');
      lines.push('## ChatGPT', '', body.trim(), '');
    }
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
    lines.push(`- [${conv.title || 'sans-titre'}](${folder}/conversation.md)`);
  }
  lines.push('');
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gptTurnsToMarkdown,
    gptInstructionsMarkdown,
    gptIndexMarkdown,
    gptConvFolderName,
    gptSanitizeFilename,
    gptHtmlToMarkdown,
  };
}
