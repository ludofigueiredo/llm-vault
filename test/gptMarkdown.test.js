const assert = require('assert');

const {
  gptTurnsToMarkdown,
  gptInstructionsMarkdown,
  gptIndexMarkdown,
  gptConvFolderName,
} = require('../extension/lib/gptMarkdown.js');

// turns are now {role, markdown} — written as-is under the role heading
const md = gptTurnsToMarkdown(
  { name: 'CV 2026' },
  [
    { role: 'user', markdown: 'Salut GPT' },
    { role: 'assistant', markdown: '# Titre\n\n**gras** et `code`.' },
  ]
);
assert.ok(md.includes('## Vous'), 'has user heading');
assert.ok(md.includes('Salut GPT'), 'has user text');
assert.ok(md.includes('## ChatGPT'), 'has assistant heading');
assert.ok(md.includes('# Titre'), 'assistant markdown written as-is');
assert.ok(md.includes('**gras** et `code`.'), 'assistant markdown untouched');

// instructions
const instr = gptInstructionsMarkdown({ name: 'CV 2026', instructions: 'Réponds en FR.' });
assert.ok(instr.includes('CV 2026'));
assert.ok(instr.includes('Réponds en FR.'));

// index
const idx = gptIndexMarkdown(
  { name: 'CV 2026' },
  [{ title: 'Avis CV', convId: '692955e1-3d78-8325-b019-7a4326ada801' }]
);
assert.ok(idx.includes('Avis CV'));
assert.ok(idx.includes('692955e1'));

// folder name
assert.strictEqual(
  gptConvFolderName({ title: 'Avis: CV/2026', convId: '692955e1-3d78-8325-b019-7a4326ada801' }),
  'Avis_ CV_2026_692955e1'
);

// gptHtmlToMarkdown must no longer be exported
const mod = require('../extension/lib/gptMarkdown.js');
assert.strictEqual(mod.gptHtmlToMarkdown, undefined, 'gptHtmlToMarkdown removed');

console.log('gptMarkdown: all assertions passed');
