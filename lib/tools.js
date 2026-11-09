// Tools the research agent can call. Everything here makes real network requests,
// so results can be recorded as "tested" evidence rather than recalled knowledge.
import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'OAuthPathfinder/0.1 (+research bot; contact: see README)';

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// SSRF guard: the agent fetches URLs chosen by an LLM from untrusted pages.
async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) allowed');
  if (!u.hostname.includes('.') && !net.isIP(u.hostname)) throw new Error('blocked host');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('blocked: private address');
  return u;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `${t.replace(/<[^>]+>/g, '')} [${h}]`)
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function get(url, { timeout = 12000, redirects = 4 } = {}) {
  let cur = url;
  for (let i = 0; i <= redirects; i++) {
    await assertPublicUrl(cur);
    const res = await fetch(cur, {
      redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    return { res, finalUrl: cur };
  }
  throw new Error('too many redirects');
}

export async function fetchUrl({ url, max_chars = 9000 }) {
  try {
    const { res, finalUrl } = await get(url);
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = ct.includes('html') ? htmlToText(body) : body;
    return { status: res.status, finalUrl, contentType: ct, text: text.slice(0, Math.min(Math.max(max_chars || 0, 7000), 20000)), truncated: true };
  } catch (e) { return { error: String(e.message || e), url }; }
}

export async function searchWeb({ query }) {
  try {
    // DDG "lite" accepts scripted POSTs; the main html endpoint serves a bot challenge.
    await assertPublicUrl('https://lite.duckduckgo.com/lite/');
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; OAuthPathfinder/0.1)', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(query),
    });
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = re.exec(html)) && out.length < 8) {
      const strip = t => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      out.push({ url: m[1].replace(/&amp;/g, '&'), title: strip(m[2]), snippet: strip(m[3]) });
    }
    return out.length ? { results: out } : { results: [], note: 'no results parsed (search may be rate-limited)' };
  } catch (e) { return { error: String(e.message || e) }; }
}

// Looks for machine-readable OAuth metadata. A hit is hard evidence for endpoints and
// supported features (PKCE, grant types); a miss is only weak evidence.
export async function probeOauth({ domain }) {
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const paths = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];
  const results = [];
  for (const p of paths) {
    const url = `https://${domain}${p}`;
    try {
      const { res, finalUrl } = await get(url, { timeout: 8000 });
      const ct = res.headers.get('content-type') || '';
      let meta = null;
      if (res.ok && ct.includes('json')) {
        const j = await res.json();
        meta = {
          issuer: j.issuer, authorization_endpoint: j.authorization_endpoint, token_endpoint: j.token_endpoint,
          registration_endpoint: j.registration_endpoint, scopes_supported: (j.scopes_supported || []).slice(0, 25),
          code_challenge_methods_supported: j.code_challenge_methods_supported,
          grant_types_supported: j.grant_types_supported, revocation_endpoint: j.revocation_endpoint,
        };
      }
      results.push({ url, finalUrl, status: res.status, found: !!meta, meta });
    } catch (e) { results.push({ url, error: String(e.message || e), found: false }); }
  }
  return { domain, results, checkedAt: new Date().toISOString() };
}

// Checks whether candidate developer-portal URLs resolve. Cheap way to catch dead links in guides.
export async function checkUrls({ urls }) {
  return Promise.all(urls.slice(0, 10).map(async url => {
    try {
      const { res, finalUrl } = await get(url, { timeout: 8000 });
      return { url, status: res.status, finalUrl, ok: res.status < 400 };
    } catch (e) { return { url, error: String(e.message || e), ok: false }; }
  }));
}

export const TOOL_IMPLS = { fetch_url: fetchUrl, search_web: searchWeb, probe_oauth: probeOauth, check_urls: checkUrls };

export const TOOL_DEFS = [
  { name: 'search_web', description: 'Search the web. Use to find the provider\'s developer docs, app registration page, review/approval requirements, and real-world reports of delays or rejections.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'fetch_url', description: 'Fetch a page and return readable text (links shown as "text [href]"). Prefer official provider docs. JS-rendered pages may come back empty.',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' } }, required: ['url'] } },
  { name: 'probe_oauth', description: 'Check a domain for OAuth/OIDC discovery metadata (/.well-known). Returns real endpoints/PKCE support if published. Try the API domain, not only the marketing domain.',
    input_schema: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] } },
  { name: 'check_urls', description: 'HTTP-check up to 10 URLs (developer console, docs) to confirm they resolve before putting them in the guide.',
    input_schema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'] } },
];
