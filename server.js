import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Auto-load .env so plain `node server.js` works without setting env vars manually.
try {
  const envFile = new URL('.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — env vars must be set externally, which is fine */ }

import { generateGuide } from './lib/agent.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const GEN_DIR = path.join(root, 'data', 'generated');
fs.mkdirSync(GEN_DIR, { recursive: true });
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function allGuides() {
  const curated = fs.readdirSync(path.join(root, 'guides')).filter(f => f.endsWith('.json')).map(f => readJson(path.join(root, 'guides', f)));
  const generated = fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.json')).map(f => readJson(path.join(GEN_DIR, f)));
  return [...curated, ...generated];
}
const card = g => ({ slug: g.slug, name: g.name, category: g.category, mode: g.mode, difficulty: g.difficulty, time: g.time, approval: { required: g.approval?.required, type: g.approval?.type } });

// Simple per-IP limiter: generation spends LLM tokens and makes outbound requests.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > (Number(process.env.GEN_PER_HOUR) || 10);
}

const inflight = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/guides') return json(res, allGuides().map(card));
    if (url.pathname.startsWith('/api/guides/')) {
      const g = allGuides().find(g => g.slug === url.pathname.split('/')[3]);
      return g ? json(res, g) : json(res, { error: 'not found' }, 404);
    }
    if (url.pathname === '/api/status') return json(res, { llm: !!process.env.GROQ_API_KEY });
    if (url.pathname === '/api/generate' && req.method === 'POST') return generate(req, res);
    if (url.pathname.startsWith('/g/') || url.pathname === '/') return serveFile(res, path.join(root, 'public', 'index.html'));
    const f = path.join(root, 'public', path.normalize(url.pathname).replace(/^(\.\.[\\/])+/, ''));
    if (f.startsWith(path.join(root, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f);
    res.writeHead(404).end('not found');
  } catch (e) { json(res, { error: String(e.message || e) }, 500); }
});

function serveFile(res, f) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(res); }
function json(res, o, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }

async function generate(req, res) {
  let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
  const q = (JSON.parse(body || '{}').q || '').trim().slice(0, 120);
  if (!q) return json(res, { error: 'Enter an app name or website' }, 400);
  if (limited(req.socket.remoteAddress)) return json(res, { error: 'Rate limit reached, try again later' }, 429);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  try {
    const guide = await generateGuide(q, send);
    // Never overwrite a curated guide.
    if (allGuides().some(g => g.slug === guide.slug && g.mode === 'curated')) guide.slug += '-live';
    fs.writeFileSync(path.join(GEN_DIR, guide.slug + '.json'), JSON.stringify(guide, null, 1));
    send({ type: 'done', slug: guide.slug });
  } catch (e) { send({ type: 'error', message: String(e.message || e) }); }
  res.end();
}

server.listen(PORT, () => console.log(`OAuth Pathfinder on http://localhost:${PORT}  (LLM: ${process.env.GROQ_API_KEY ? 'on' : 'off, probe-only mode'})`));
