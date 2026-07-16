function isGptHost(url) {
  try {
    return new URL(url).hostname === 'chatgpt.com';
  } catch (e) {
    return false;
  }
}

function gptDetectContext(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { kind: null };
  }
  if (parsed.hostname !== 'chatgpt.com') return { kind: null };

  const path = parsed.pathname;

  if (path === '/projects') return { kind: 'projects' };

  const conv = path.match(/^\/g\/(g-p-[a-f0-9]+)-[^/]*\/c\/([a-f0-9-]+)/);
  if (conv) return { kind: 'conversation', projectId: conv[1], convId: conv[2] };

  const proj = path.match(/^\/g\/(g-p-[a-f0-9]+)(?:-[^/]*)?\/project/);
  if (proj) return { kind: 'project', projectId: proj[1] };

  return { kind: null };
}

// Browser globals + Node export (for the pure-function test).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gptDetectContext, isGptHost };
}
