// Post-build sanity checks on site/dist. Usage: node scripts/check-dist.mjs   (exit code 1 when anything fails)
//  - every page: <title>, meta description, canonical, og tags, exactly one <h1>, JSON-LD parses
//  - noindex pages (console, invite, 404) are excluded from the sitemap; indexable pages are all in it
//  - internal links and #anchors resolve to files / ids in dist
//  - "AgentWire" only where allowed, and no token-looking strings anywhere
//  - robots.txt / llms.txt / llms-full.txt / sitemap.xml present and sane
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const SITE = 'https://agents.hot';
let fails = 0, warns = 0;
const fail = (m) => { fails++; console.log('FAIL ' + m); };
const warn = (m) => { warns++; console.log('warn ' + m); };

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(dist);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const rel = (f) => '/' + relative(dist, f).replace(/\\/g, '/');
const urlOf = (f) => { let u = rel(f).replace(/\.html$/, ''); if (u.endsWith('/index')) u = u.slice(0, -6) || '/'; return u === '/index' ? '/' : u; };

const pages = new Map(); // url -> { file, html, ids:Set }
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  pages.set(urlOf(f), { file: f, html, ids: new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])) });
}
const noindexUrls = new Set(['/console', '/invite', '/404']);
const sitemap = existsSync(join(dist, 'sitemap.xml')) ? readFileSync(join(dist, 'sitemap.xml'), 'utf8') : '';
const sitemapUrls = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));

for (const [url, p] of pages) {
  const h = p.html;
  const label = url;
  const noindex = noindexUrls.has(url);
  const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1];
  if (!title) fail(`${label}: missing <title>`); else if (title.length > 72) warn(`${label}: title is ${title.length} chars`);
  const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!desc) fail(`${label}: missing meta description`); else if (!noindex && (desc.length < 60 || desc.length > 200)) warn(`${label}: description is ${desc.length} chars`);
  if (!noindex) {
    const canon = (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
    const expect = SITE + (url === '/' ? '/' : url);
    if (!canon) fail(`${label}: missing canonical`); else if (canon !== expect) fail(`${label}: canonical ${canon} != ${expect}`);
    for (const t of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card']) if (!new RegExp(`(property|name)="${t}"`).test(h)) fail(`${label}: missing ${t}`);
    if (!sitemapUrls.has(expect)) fail(`${label}: not in sitemap.xml`);
    if (/name="robots" content="[^"]*noindex/.test(h)) fail(`${label}: indexable page has noindex`);
  } else {
    if (!/name="robots" content="[^"]*noindex/.test(h)) fail(`${label}: should be noindex`);
    if (sitemapUrls.has(SITE + url)) fail(`${label}: noindex page is in sitemap.xml`);
  }
  if (url !== '/404') {
    const h1s = (h.match(/<h1[\s>]/g) || []).length;
    if (h1s !== 1) fail(`${label}: ${h1s} <h1> elements`);
  }
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { fail(`${label}: invalid JSON-LD (${e.message})`); }
  }
  if (!noindex && !/application\/ld\+json/.test(h)) warn(`${label}: no JSON-LD`);

  // links
  for (const m of h.matchAll(/\shref="([^"]+)"/g)) {
    const href = m[1];
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const [pathPart, hash] = href.split('#');
    const clean = pathPart.split('?')[0];
    if (clean.startsWith('/invite/') || clean.startsWith('/v1/')) continue;
    const target = clean === '' ? url : clean.replace(/\/$/, '') || '/';
    const isFile = /\.[a-z0-9]{2,5}$/i.test(target);
    if (isFile) { if (!existsSync(join(dist, target))) fail(`${label}: broken link ${href}`); continue; }
    const tp = pages.get(target);
    if (!tp) { fail(`${label}: broken link ${href}`); continue; }
    if (hash && !tp.ids.has(hash)) fail(`${label}: missing anchor ${href}`);
  }
}

// forbidden strings
const textFiles = files.filter((f) => /\.(html|txt|xml|json|js|css|svg)$/.test(f));
for (const f of textFiles) {
  const t = readFileSync(f, 'utf8');
  const u = rel(f);
  for (const m of t.matchAll(/agentwire/gi)) {
    const ctx = t.slice(Math.max(0, m.index - 40), m.index + 40);
    const ok = /github\.com\/yan-labs\/agentwire/.test(ctx) || (u === '/docs/api.html' && /formerly called AgentWire/.test(t.slice(Math.max(0, m.index - 30), m.index + 12)));
    if (!ok) fail(`${u}: unexpected "AgentWire" near: ${ctx.replace(/\s+/g, ' ')}`);
  }
  if (/\b[0-9a-f]{64}\b/.test(t)) fail(`${u}: contains a 64-hex string (token-looking)`);
  if (/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/.test(t) || /Bearer\s+[A-Za-z0-9_-]{30,}/.test(t)) fail(`${u}: contains a secret-looking string`);
  if (/room_cdc26cdd5dab08d7f63427a8/.test(t)) fail(`${u}: references the protected production room`);
}

// machine-readable files
const need = ['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'og.png', 'favicon.svg', 'apple-touch-icon.png', '_headers'];
for (const n of need) if (!existsSync(join(dist, n))) fail(`missing dist/${n}`);
if (existsSync(join(dist, 'robots.txt'))) {
  const r = readFileSync(join(dist, 'robots.txt'), 'utf8');
  if (!/Sitemap: https:\/\/agents\.hot\/sitemap\.xml/.test(r)) fail('robots.txt: missing Sitemap line');
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot']) if (!r.includes(`User-agent: ${bot}`)) fail(`robots.txt: ${bot} not listed`);
  if (/Disallow:\s*\/\s*$/m.test(r)) fail('robots.txt: blocks the whole site');
}
if (existsSync(join(dist, 'llms.txt'))) {
  const t = readFileSync(join(dist, 'llms.txt'), 'utf8');
  if (!t.startsWith('# Agents Hot')) fail('llms.txt: must start with an H1 of the product name');
  const links = [...t.matchAll(/\]\((https:\/\/agents\.hot[^)]*)\)/g)].map((m) => m[1]);
  for (const l of links) { const u = l.replace(SITE, '') || '/'; const clean = u.replace(/\/$/, '') || '/'; if (!pages.has(clean) && !existsSync(join(dist, clean))) fail(`llms.txt: dead link ${l}`); }
}
console.log(`\n${pages.size} pages, ${files.length} files checked: ${fails} failure(s), ${warns} warning(s)`);
process.exit(fails ? 1 : 0);
