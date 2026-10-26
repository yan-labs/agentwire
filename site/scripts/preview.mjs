// Local preview that behaves like Workers Static Assets in front of the API:
//   - serves site/dist (clean URLs, /invite/* -> invite page, 404 page)
//   - applies dist/_headers (so the CSP is exercised locally)
//   - proxies /v1/* (and /health) to AW_BACKEND (a LOCAL backend only), with a small shim for
//     endpoints the backend does not have yet (public-config, invite list/revoke). See scripts/shim.mjs.
// Usage: AW_BACKEND=http://127.0.0.1:8787 PORT=4321 node scripts/preview.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shim } from './shim.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const BACKEND = process.env.AW_BACKEND || 'http://127.0.0.1:8787';
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BACKEND)) {
  console.error(`Refusing to proxy to non-local backend: ${BACKEND}`);
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.ico': 'image/x-icon',
};

// minimal _headers parser: "/path/*" followed by indented "Name: value"
async function loadHeaders() {
  try {
    const raw = await readFile(join(dist, '_headers'), 'utf8');
    const rules = [];
    let cur = null;
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); }
      else if (cur) { const i = line.indexOf(':'); cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    }
    return rules;
  } catch { return []; }
}
const matches = (pattern, path) => {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(path);
};

async function exists(p) { try { return (await stat(p)).isFile(); } catch { return false; } }

async function resolveFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.includes('\0')) return null;
  p = normalize(p).replace(/^(\.\.[/\\])+/, '');
  if (p.startsWith('/invite/') && p !== '/invite/') p = '/invite';
  const candidates = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
  for (const c of candidates) { const f = join(dist, c); if (f.startsWith(dist) && (await exists(f))) return f; }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rules = await loadHeaders();
  const applyHeaders = () => { for (const r of rules) if (matches(r.pattern, url.pathname)) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v); };

  if (url.pathname.startsWith('/v1/') || url.pathname === '/health') {
    try {
      if (await shim(req, res, url, BACKEND)) return;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = { ...req.headers, host: new URL(BACKEND).host };
      delete headers['content-length'];
      const r = await fetch(BACKEND + url.pathname + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'local backend unreachable: ' + e.message }));
    }
    return;
  }

  const file = await resolveFile(url.pathname);
  applyHeaders();
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    const nf = join(dist, '404.html');
    res.end((await exists(nf)) ? await readFile(nf) : 'Not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
});

server.listen(PORT, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${PORT}  (api -> ${BACKEND})`));
