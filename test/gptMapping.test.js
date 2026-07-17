const assert = require('assert');
const {
  gptStripCitations,
  gptExtractFileReferences,
  gptMappingToTurns,
} = require('../extension/content-gpt.js');

// stripCitations removes 【...】 spans
assert.strictEqual(gptStripCitations('foo【12†bar】 baz'), 'foo baz');

// A small conversation tree: root -> user -> assistant.
const convo = {
  title: 'T',
  mapping: {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: {
      id: 'u1', parent: 'root', children: ['a1'],
      message: {
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['Bonjour GPT'] },
        metadata: {},
      },
    },
    a1: {
      id: 'a1', parent: 'u1', children: [],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['# Titre\n\nRéponse【1†src】.'] },
        metadata: {},
      },
    },
  },
};

const turns = gptMappingToTurns(convo, {});
assert.strictEqual(turns.length, 2, 'two turns');
assert.deepStrictEqual(turns[0], { role: 'user', markdown: 'Bonjour GPT' });
assert.strictEqual(turns[1].role, 'assistant');
assert.ok(turns[1].markdown.includes('# Titre'), 'assistant markdown preserved');
assert.ok(!turns[1].markdown.includes('【'), 'citations stripped');

// system/tool + non-text assistant are skipped
const convo2 = {
  mapping: {
    r: { parent: null, children: ['s', 't', 'x'], message: null },
    s: { parent: 'r', children: [], message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['sys'] }, metadata: {} } },
    t: { parent: 'r', children: [], message: { author: { role: 'tool' }, content: { content_type: 'text', parts: ['tool out'] }, metadata: {} } },
    x: { parent: 'r', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'code', parts: ['print(1)'] }, metadata: {} } },
  },
};
assert.strictEqual(gptMappingToTurns(convo2, {}).length, 0, 'system/tool/non-text skipped');

// image + attachment references, with fileMap producing contenu-gpt/ links
const convo3 = {
  mapping: {
    r: { parent: null, children: ['m'], message: null },
    m: {
      parent: 'r', children: [],
      message: {
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-ABC', metadata: {} },
            'un texte',
          ],
        },
        metadata: { attachments: [{ id: 'file-DOC', name: 'rapport.docx' }] },
      },
    },
  },
};
const refs = gptExtractFileReferences(convo3);
const ids = refs.map((r) => r.fileId).sort();
assert.deepStrictEqual(ids, ['file-ABC', 'file-DOC']);

const fileMap = { 'file-ABC': 'contenu-gpt/image.png', 'file-DOC': 'contenu-gpt/rapport.docx' };
const turns3 = gptMappingToTurns(convo3, fileMap);
assert.ok(turns3[0].markdown.includes('![image](contenu-gpt/image.png)'), 'image link');
assert.ok(turns3[0].markdown.includes('un texte'), 'text part kept');
assert.ok(turns3[0].markdown.includes('📎 [rapport.docx](contenu-gpt/rapport.docx)'), 'attachment link');

console.log('gptMapping: all assertions passed');
