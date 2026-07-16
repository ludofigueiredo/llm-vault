const assert = require('assert');

const {
  gptTurnsToMarkdown,
  gptInstructionsMarkdown,
  gptIndexMarkdown,
  gptConvFolderName,
  gptHtmlToMarkdown,
} = require('../extension/lib/gptMarkdown.js');

// A trivial injected converter proves gptTurnsToMarkdown routes assistant
// html through htmlToMd and user text verbatim, without needing a DOM.
const fakeHtmlToMd = (html) => html.replace(/<[^>]+>/g, '').trim();

const md = gptTurnsToMarkdown(
  { name: 'CV 2026' },
  [
    { role: 'user', text: 'Salut GPT' },
    { role: 'assistant', html: '<p>Bonjour</p>' },
  ],
  fakeHtmlToMd
);
assert.ok(md.includes('## Vous'), 'has user heading');
assert.ok(md.includes('Salut GPT'), 'has user text');
assert.ok(md.includes('## ChatGPT'), 'has assistant heading');
assert.ok(md.includes('Bonjour'), 'has assistant text');

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

// folder name: sanitized title + 8-char id
assert.strictEqual(
  gptConvFolderName({ title: 'Avis: CV/2026', convId: '692955e1-3d78-8325-b019-7a4326ada801' }),
  'Avis_ CV_2026_692955e1'
);

// HTML->markdown converter, driven by an injected minimal DOM so it runs
// in Node. The converter walks nodes; we feed it a tiny tree covering the
// core tags. `parse` returns a root node with .childNodes; each node has
// nodeType (1=element,3=text), nodeName (upper-case tag), textContent,
// childNodes, and getAttribute(name).
function el(name, children, attrs) {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    childNodes: children || [],
    getAttribute: (k) => (attrs && attrs[k]) || null,
    get textContent() { return (this.childNodes || []).map(n => n.textContent).join(''); },
  };
}
function txt(s) { return { nodeType: 3, nodeName: '#text', textContent: s, childNodes: [] }; }

const fakeParse = () => el('body', [
  el('p', [txt('Voici un retour '), el('strong', [txt('solide')]), txt('.')]),
  el('h1', [txt('Titre')]),
  el('ul', [el('li', [txt('un')]), el('li', [txt('deux')])]),
]);

const outMd = gptHtmlToMarkdown('<ignored/>', { parse: fakeParse });
assert.ok(outMd.includes('Voici un retour **solide**.'), 'bold inline: ' + outMd);
assert.ok(outMd.includes('# Titre'), 'h1: ' + outMd);
assert.ok(outMd.includes('- un'), 'li 1: ' + outMd);
assert.ok(outMd.includes('- deux'), 'li 2: ' + outMd);

console.log('gptMarkdown: all assertions passed');
