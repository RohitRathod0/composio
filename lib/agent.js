// Research agent, staged to fit small token budgets (Groq free tier: 8,000 tokens per request AND per minute).
//   1. search (code)                              2. model picks which pages to read
//   3. fetch pages (code), model condenses each   4. discovery probes (code)   5. model writes the guide from the notes only
// The source list and its evidence labels are built by code from what actually happened, never by the model.
import { TOOL_IMPLS } from './tools.js';

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const API_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions';
const TPM_BUDGET = Number(process.env.LLM_TPM) || 7000; // stay under the 8k/min cap
const PAGES_TO_READ = 3;
const PAGE_CHARS = 6000;

// Open models often return a string where a list is wanted; accept both and normalise in code.
const LIST = { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] };
const GUIDE_SCHEMA = {
  type: 'object',
  required: ['name', 'summary', 'difficulty', 'time', 'approval', 'steps', 'confidence'],
  properties: {
    name: { type: 'string' }, website: { type: 'string' }, category: { type: 'string' },
    summary: { type: 'string', description: '2-3 sentences: what the path looks like and the biggest risk.' },
    difficulty: { type: 'object', required: ['score', 'label', 'why'], properties: { score: { type: 'integer' }, label: { type: 'string' }, why: { type: 'string' } } },
    time: { type: 'object', required: ['handsOn', 'wait', 'total'], properties: { handsOn: { type: 'string' }, wait: { type: 'string' }, total: { type: 'string' } } },
    approval: { type: 'object', required: ['required', 'type', 'detail'], properties: { required: { type: 'boolean' }, type: { type: 'string' }, detail: { type: 'string' } } },
    agentCan: LIST, youMustDo: LIST,
    steps: { type: 'array', items: { type: 'object', required: ['title', 'who', 'detail', 'src'], properties: { title: { type: 'string' }, who: { enum: ['agent', 'you', 'either'] }, detail: { type: 'string' }, src: { type: 'array', items: { type: 'string' } } } } },
    requirements: LIST,
    gotchas: { type: 'array', items: { type: 'object', required: ['issue', 'detail', 'src'], properties: { issue: { type: 'string' }, detail: { type: 'string' }, src: { type: 'array', items: { type: 'string' } } } } },
    blockers: { type: 'array', items: { type: 'object', required: ['problem', 'fix'], properties: { problem: { type: 'string' }, fix: { type: 'string' } } } },
    confidence: { type: 'string', description: 'What is solid and what is uncertain or missing.' },
  },
};

const WRITER_SYSTEM = `You write OAuth-app setup guides for developers who must register an OAuth app with a provider and get it approved.
Use ONLY the research notes given. "name" is the product name only (e.g. "HubSpot").
Separate two things: (a) what the provider requires before OTHER customers' accounts can authorize your app (approval.required is true only for this), and (b) what is only required to be LISTED in a marketplace (describe it in approval.detail, but do not count it as required).
Do NOT claim that other customers' accounts can authorize the app, or that no review is needed, unless a note says so explicitly; if the notes are silent on who may install before review, set approval.detail to say "sources do not state who can install before review", score difficulty on the documented facts, and lower confidence. List every distribution tier the notes mention (private, beta, unlisted, public) and which need review.
time.total must be derived from the notes; if no source states a duration, write "not published (my estimate: ...)". Never state a duration without a source or the words "my estimate". Cite source ids (like s1, p1) in src arrays. If the notes do not say, write "not published" rather than guessing; any estimate of yours must say "my estimate". Put gaps in confidence.
Mark each step "agent" (code/text an agent can do), "you" (needs the developer's login, payment, identity, video or provider email), or "either".
difficulty.score: 1 = self-serve form, no review; 3 = documented review; 5 = multi-week review with security assessment or partner gating. Be concise (steps 4-8, gotchas 3-5).`;

// --- LLM access with a sliding-window throttle ----------------------------------------------
const spent = []; // {t, tokens}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function throttle(estimate, emit) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].t > 60000) spent.shift();
    const used = spent.reduce((a, b) => a + b.tokens, 0);
    if (used + estimate <= TPM_BUDGET) return;
    const wait = Math.max(2000, 60000 - (now - spent[0].t) + 500);
    emit({ type: 'thought', text: `Pacing for the model's token-per-minute limit: waiting ${Math.ceil(wait / 1000)}s` });
    await sleep(Math.min(wait, 20000));
  }
}

async function llm(messages, { maxTokens = 900, tools, toolName } = {}, emit = () => {}) {
  const estimate = Math.ceil(JSON.stringify(messages).length / 3.2) + (tools ? 1100 : 0) + maxTokens;
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle(estimate, emit);
    const res = await fetch(API_URL, {
      method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0.2, max_tokens: maxTokens, messages,
        ...(MODEL.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        ...(tools ? { tools, tool_choice: { type: 'function', function: { name: toolName } } } : {}),
      }),
    });
    if (res.status === 429 || res.status === 413) {
      const body = await res.text();
      const wait = Math.min(Number(res.headers.get('retry-after')) || 15, 40);
      spent.push({ t: Date.now(), tokens: TPM_BUDGET }); // we are at the limit; back off a full window if needed
      emit({ type: 'thought', text: `Rate limited (${res.status}); retrying in ${wait}s` });
      if (attempt === 3) throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    spent.push({ t: Date.now(), tokens: j.usage?.total_tokens || estimate });
    return j.choices[0].message;
  }
}

// Model output occasionally arrives as UTF-8 bytes mis-read as Windows-1252 ("â€‘"). Repair, then flatten odd punctuation.
const CP1252 = new Map(Array.from({ length: 32 }, (_, i) => [new TextDecoder('windows-1252').decode(Uint8Array.of(0x80 + i)), 0x80 + i]));
function cleanText(s) {
  if (/[ÂÃâ][-ÿŒœŠšŸŽžƒˆ˜–-›€™]/.test(s)) {
    const bytes = [...s].map(c => CP1252.get(c) ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : null));
    if (!bytes.includes(null)) { try { s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { /* keep as is */ } }
  }
  return s.replace(/[‐-―−]/g, '-').replace(/[   ​]/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
const cleanDeep = v => typeof v === 'string' ? cleanText(v) : Array.isArray(v) ? v.map(cleanDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) : v;

// --- helpers -------------------------------------------------------------------------------
export function slugify(s) { return s.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'app'; }
const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
const baseDomain = h => h.replace(/^(www|api|developers?|docs|dev|support|help|learn)\./, '');

function summarize(tool, out) {
  if (out.error) return out.error;
  if (tool === 'search_web') return `${out.results?.length || 0} results`;
  if (tool === 'fetch_url') return `HTTP ${out.status}, ${out.text?.length || 0} chars`;
  if (tool === 'probe_oauth') return out.results.map(r => `${r.status || 'err'}${r.found ? ' (metadata)' : ''}`).join(', ');
  if (tool === 'check_urls') return out.map(r => r.status || 'err').join(', ');
  return 'ok';
}

export async function generateGuide(query, emit = () => {}) {
  const run = async (tool, input) => {
    emit({ type: 'tool', tool, input });
    let out;
    try { out = await TOOL_IMPLS[tool](input); } catch (e) { out = { error: String(e.message || e) }; }
    emit({ type: 'result', tool, ok: !out.error, summary: summarize(tool, out) });
    return out;
  };

  // 1. Search (code) -------------------------------------------------------------------------
  const isUrl = /\./.test(query) && !/\s/.test(query);
  const qName = isUrl ? baseDomain(query.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) : query;
  const seen = new Map();
  for (const q of [`${qName} OAuth app registration developer docs`, `${qName} API app review approval verification requirements`]) {
    const r = await run('search_web', { query: q });
    for (const h of r.results || []) if (!seen.has(h.url)) seen.set(h.url, h);
  }
  const candidates = [...seen.values()].slice(0, 12);
  if (!process.env.GROQ_API_KEY) return fallbackGuide(query, candidates, run);
  if (!candidates.length) throw new Error("Search returned nothing; cannot research this app right now. Try the app's website address.");

  // 2. Model picks pages to read ------------------------------------------------------------
  const list = candidates.map((c, i) => `${i + 1}. ${c.url}\n   ${c.title} - ${c.snippet.slice(0, 120)}`).join('\n');
  const pick = await llm([{ role: 'user', content: `Developer wants to set up an OAuth app for "${query}". Pick the ${PAGES_TO_READ} URLs most likely to be OFFICIAL provider docs about creating an OAuth app, approval/review/verification, or scopes. Prefer provider-owned domains; skip blogs and third-party tutorials. Reply with only the URLs, one per line.\n\n${list}` }], { maxTokens: 300 }, emit);
  const chosen = [...new Set((pick.content || '').match(/https?:\/\/[^\s)>\]"']+/g) || [])].filter(u => seen.has(u)).slice(0, PAGES_TO_READ);
  for (const c of candidates) if (chosen.length < PAGES_TO_READ && !chosen.includes(c.url)) chosen.push(c.url); // search-rank fallback
  emit({ type: 'thought', text: `Reading: ${chosen.map(host).join(', ')}` });

  // 3. Fetch + condense ---------------------------------------------------------------------
  const sources = [], notes = [];
  for (const [i, url] of chosen.entries()) {
    const id = `s${i + 1}`;
    const page = await run('fetch_url', { url, max_chars: PAGE_CHARS });
    const ok = !page.error && page.status >= 200 && page.status < 300 && (page.text || '').length > 200;
    sources.push({ id, url, title: seen.get(url)?.title || url, status: ok ? 'read' : 'unverified', note: ok ? `Fetched ${new Date().toISOString().slice(0, 10)}; HTTP ${page.status}.` : `Could not read (${page.error || 'HTTP ' + page.status}).` });
    if (!ok) continue;
    const m = await llm([{ role: 'user', content: `Page text from ${url}:\n"""\n${page.text.slice(0, PAGE_CHARS)}\n"""\nList concise bullet facts (max 170 words) from this text ONLY about: how to create/register an OAuth app and its required fields; whether any provider review, approval, certification, partner program or paid plan is needed, whether it is needed for OTHER accounts to authorize the app or only for marketplace listing, and any stated timelines; scope tiers; redirect URI rules; token lifetimes; limits or quotas. Write "not stated" for topics absent. No preamble.` }], { maxTokens: 450 }, emit);
    notes.push(`[${id}] ${url}\n${(m.content || '').trim()}`);
  }

  // 4. Discovery probes (code) --------------------------------------------------------------
  const hosts = [...new Set([isUrl ? query.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null, ...chosen.map(u => baseDomain(host(u)))].filter(Boolean))].slice(0, 3);
  const tested = [];
  for (const [i, d] of hosts.entries()) {
    const p = await run('probe_oauth', { domain: d });
    const found = p.results?.find(r => r.found);
    const line = found ? `Discovery metadata found: authorize=${found.meta.authorization_endpoint}, token=${found.meta.token_endpoint}, PKCE=${(found.meta.code_challenge_methods_supported || ['not listed']).join('/')}, scopes sample=${(found.meta.scopes_supported || []).slice(0, 6).join(' ') || 'none listed'}. CAUTION: may describe sign-in only, not app installs.` : 'No discovery metadata at standard paths.';
    sources.push({ id: `p${i + 1}`, url: found?.url || `https://${d}/.well-known/oauth-authorization-server`, title: `Discovery probe on ${d}`, status: 'tested', note: line });
    tested.push({ what: `Discovery metadata on ${d}`, result: line, at: new Date().toISOString().slice(0, 10) });
    notes.push(`[p${i + 1}] probe ${d}: ${line}`);
  }

  // 5. Model writes the guide ---------------------------------------------------------------
  const tool = [{ type: 'function', function: { name: 'submit_guide', description: 'Submit the finished guide.', parameters: GUIDE_SCHEMA } }];
  const msgs = [{ role: 'system', content: WRITER_SYSTEM }, { role: 'user', content: `App: ${query}\n\nResearch notes:\n${notes.join('\n\n')}\n\nWrite the guide.` }];
  let guide, problem = '';
  for (let attempt = 0; attempt < 3 && !guide; attempt++) {
    let out;
    try { out = await llm(msgs, { maxTokens: 4000, tools: tool, toolName: 'submit_guide' }, emit); }
    catch (e) { // Groq validates tool arguments against the schema and answers 400 when fields are missing
      if (!/validation failed/i.test(e.message)) throw e;
      problem = e.message.slice(0, 700); emit({ type: 'thought', text: 'Model returned an incomplete guide; asking again' });
      msgs.push({ role: 'user', content: 'Your last submit_guide call did not match the schema (a required field was missing). Call it again with every required field, concisely.' });
      continue;
    }
    let args = null;
    try { args = JSON.parse(out.tool_calls?.[0]?.function?.arguments || 'null'); } catch { /* handled below */ }
    const missing = args ? GUIDE_SCHEMA.required.filter(k => args[k] == null) : ['(arguments were not valid JSON)'];
    if (!missing.length) guide = args;
    else { problem = missing.join(', '); msgs.push({ role: 'user', content: `Your submit_guide call was missing/invalid: ${problem}. Call it again, complete and concise.` }); }
  }
  if (!guide) throw new Error(`Model did not return a complete guide (${problem})`);
  guide = cleanDeep(guide);
  const asList = v => Array.isArray(v) ? v : v ? String(v).split(/\n|;\s+|(?<=\.)\s+(?=[A-Z])/).map(x => x.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean) : [];
  for (const k of ['agentCan', 'youMustDo', 'requirements']) guide[k] = asList(guide[k]);
  // The "who does what" split is core to the product: if the model skipped it, derive it from the step owners.
  if (!guide.agentCan.length) guide.agentCan = (guide.steps || []).filter(x => x.who === 'agent').map(x => x.title);
  if (!guide.youMustDo.length) guide.youMustDo = (guide.steps || []).filter(x => x.who === 'you').map(x => x.title);
  for (const k of ['gotchas', 'blockers', 'steps']) if (!Array.isArray(guide[k])) guide[k] = [];
  guide.steps = guide.steps.filter(x => x && typeof x === 'object').map(x => ({ ...x, src: Array.isArray(x.src) ? x.src : [] }));
  guide.gotchas = guide.gotchas.filter(x => x && typeof x === 'object').map(x => ({ ...x, src: Array.isArray(x.src) ? x.src : [] }));

  // Evidence is code-built; the model may only cite ids that exist.
  const ids = new Set(sources.map(s => s.id));
  let dropped = 0;
  for (const list of [guide.steps, guide.gotchas]) for (const it of list || []) {
    dropped += (it.src || []).filter(i => !ids.has(i)).length;
    it.src = (it.src || []).filter(i => ids.has(i));
  }
  const uncited = (guide.steps || []).filter(s => !s.src.length).length;
  const auditNotes = [];
  if (dropped) auditNotes.push(`Removed ${dropped} citation(s) to sources that don't exist.`);
  if (uncited) auditNotes.push(`${uncited} step(s) cite no source and are the model's own inference.`);
  if (!sources.some(s => s.status === 'read')) auditNotes.push('No documentation page could be read; this guide has no read sources.');

  return { slug: slugify(isUrl ? qName : query), mode: 'live', generatedAt: new Date().toISOString().slice(0, 10), query, ...guide, sources, tested,
    meta: { auditNotes, model: MODEL, pagesRead: sources.filter(s => s.status === 'read').length } };
}

// No API key: report only what code could establish. Deliberately minimal and labeled as such.
async function fallbackGuide(query, candidates, run) {
  const isUrl = /\./.test(query) && !/\s/.test(query);
  const domain = isUrl ? query.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : (candidates[0] ? host(candidates[0].url) : null);
  let hits = candidates;
  if (!hits.length && domain) {
    const base = baseDomain(domain);
    hits = [`https://developers.${base}`, `https://${base}/developers`, `https://developer.${base}`, `https://docs.${base}`].map(url => ({ url, title: `Guessed docs location: ${url}`, snippet: 'Guessed from common patterns.' }));
  }
  const probe = domain ? await run('probe_oauth', { domain }) : null;
  const found = probe?.results.find(r => r.found);
  const checked = hits.length ? await run('check_urls', { urls: hits.slice(0, 5).map(h => h.url) }) : [];
  hits = hits.filter(h => !h.snippet?.startsWith('Guessed') || checked.find(c => c.url === h.url)?.ok);
  const sources = [
    ...hits.slice(0, 5).map((h, i) => ({ id: `s${i}`, url: h.url, title: h.title, status: checked.find(c => c.url === h.url)?.ok ? 'tested' : 'unverified', note: h.snippet || 'Search result; content not read.' })),
    ...(probe ? [{ id: 'probe', url: `https://${domain}/.well-known/oauth-authorization-server`, title: `Discovery probe on ${domain}`, status: 'tested', note: found ? 'Metadata found.' : 'No discovery metadata at the standard paths.' }] : []),
  ];
  return { slug: slugify(query), mode: 'probe-only', generatedAt: new Date().toISOString().slice(0, 10), query,
    name: query, website: domain ? `https://${domain}` : hits[0]?.url, category: 'Unknown',
    summary: 'Probe-only result. GROQ_API_KEY is not set on this server, so nothing was read or interpreted. Treat as a list of links, not a guide.',
    difficulty: { score: 0, label: 'Unknown', why: 'Not assessed without a model.' }, time: { handsOn: 'Unknown', wait: 'Unknown', total: 'Unknown' },
    approval: { required: false, type: 'Unknown', detail: 'Not assessed. Check the linked docs for review or partner requirements.' },
    endpoints: found ? { authorize: found.meta.authorization_endpoint, token: found.meta.token_endpoint, pkce: (found.meta.code_challenge_methods_supported || ['not listed']).join(', '), discovery: found.url } : { discovery: 'None found at standard paths' },
    agentCan: ['Run full research once GROQ_API_KEY is set on the server'], youMustDo: ['Read the linked sources'], steps: [], requirements: [],
    gotchas: [{ issue: 'Probe-only mode', detail: 'Search snippets are not documentation. Discovery metadata can describe a sign-in flow rather than app installs (seen with Slack).', src: [] }], blockers: [],
    sources, confidence: 'Very low. Only link reachability and discovery metadata were checked.', meta: { auditNotes: [] } };
}
