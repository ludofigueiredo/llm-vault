const assert = require('assert');
const { gptDetectContext, isGptHost } = require('../extension/lib/gptDetect.js');

// projects listing
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/projects'),
  { kind: 'projects' }
);

// project page
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/g/g-p-6921c94ec8fc8191b6224125ec8794c3/project'),
  { kind: 'project', projectId: 'g-p-6921c94ec8fc8191b6224125ec8794c3' }
);

// conversation page (project slug + convId)
assert.deepStrictEqual(
  gptDetectContext('https://chatgpt.com/g/g-p-6921c94ec8fc8191b6224125ec8794c3-cv-2026/c/692955e1-3d78-8325-b019-7a4326ada801'),
  { kind: 'conversation', projectId: 'g-p-6921c94ec8fc8191b6224125ec8794c3', convId: '692955e1-3d78-8325-b019-7a4326ada801' }
);

// unrelated
assert.deepStrictEqual(gptDetectContext('https://chatgpt.com/'), { kind: null });
assert.strictEqual(isGptHost('https://chatgpt.com/projects'), true);
assert.strictEqual(isGptHost('https://claude.ai/projects'), false);

console.log('gptDetect: all assertions passed');
