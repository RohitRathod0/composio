// Runs the real pipeline against a scripted fake Groq API and stubbed tools (no network).
// Verifies: model page-picking, code-built evidence labels, citation pruning, retry on an incomplete guide.
// Run: node test/agent.test.mjs
import assert from 'node:assert/strict';
process.env.GROQ_API_KEY = 'test-key';

const { TOOL_IMPLS } = await import('../lib/tools.js');
TOOL_IMPLS.search_web = async () => ({ results: [
  { url: 'https://docs.fake.com/oauth', title: 'Fake OAuth docs', snippet: 'create an app' },
  { url: 'https://docs.fake.com/review', title: 'Fake review', snippet: 'review process' },
  { url: 'https://blog.example.org/post', title: 'Blog', snippet: 'tutorial' },
  { url: 'https://docs.fake.com/dead', title: 'Dead page', snippet: 'x' }] });
TOOL_IMPLS.fetch_url = async ({ url }) => url.endsWith('/dead') ? { status: 404, text: '' } : { status: 200, text: 'x'.repeat(500) };
TOOL_IMPLS.probe_oauth = async ({ domain }) => ({ domain, results: [{ url: `https://${domain}/.well-known/openid-configuration`, found: false, status: 404 }] });

const good = {
  name: 'Fake App', summary: 's', difficulty: { score: 2, label: 'Easy', why: 'w' }, time: { handsOn: '1h', wait: 'none', total: '1h' },
  approval: { required: false, type: 'none', detail: 'd' }, agentCan: [], youMustDo: [], gotchas: [{ issue: 'g', detail: 'd', src: ['s1', 'bogus'] }], blockers: [], confidence: 'c',
  steps: [{ title: 'cited', who: 'agent', detail: 'd', src: ['s1', 'ghost'] }, { title: 'uncited', who: 'you', detail: 'd', src: [] }],
  sources: [{ id: 'x', url: 'https://evil.example', title: 'model-invented source', status: 'tested', note: '' }], // must be ignored
};
const calls = { total: 0, writer: 0 };
const msg = (content, tool_calls) => new Response(JSON.stringify({ choices: [{ message: { content, tool_calls } }], usage: { total_tokens: 100 } }));
globalThis.fetch = async (url, opts) => {
  assert.ok(String(url).startsWith('https://api.groq.com'), 'only the LLM is called via fetch');
  const body = JSON.parse(opts.body); calls.total++;
  const text = JSON.stringify(body.messages);
  if (body.tools) {
    calls.writer++;
    const args = calls.writer === 1 ? { name: 'incomplete' } : good; // first attempt incomplete -> retry
    return msg(null, [{ id: 'c', type: 'function', function: { name: 'submit_guide', arguments: JSON.stringify(args) } }]);
  }
  if (text.includes('Pick the')) return msg('https://docs.fake.com/oauth\nhttps://docs.fake.com/dead\nhttps://not-in-results.example/x'); // 3rd must be ignored
  return msg('- bullet facts');
};

const { generateGuide } = await import('../lib/agent.js');
const events = [];
const g = await generateGuide('fake app', e => events.push(e));
const by = Object.fromEntries(g.sources.map(s => [s.id, s]));

assert.equal(g.mode, 'live');
assert.equal(by.s1.url, 'https://docs.fake.com/oauth'); assert.equal(by.s1.status, 'read');
assert.equal(by.s2.url, 'https://docs.fake.com/dead'); assert.equal(by.s2.status, 'unverified', '404 page is never labeled read');
assert.ok(!g.sources.some(s => s.url.includes('evil.example') || s.url.includes('not-in-results')), 'model cannot add sources');
assert.equal(by.p1.status, 'tested');
assert.deepEqual(g.steps[0].src, ['s1'], 'dangling citation removed');
assert.equal(calls.writer, 2, 'incomplete guide triggers one retry');
assert.ok(g.meta.auditNotes.some(n => /uncited|cite no source/.test(n)) && g.meta.auditNotes.some(n => /Removed/.test(n)));
console.log('agent tests passed;', g.sources.length, 'sources,', calls.total, 'model calls\n ', g.meta.auditNotes.join('\n  '));
