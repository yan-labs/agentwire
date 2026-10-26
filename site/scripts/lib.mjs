// Shared helpers for the local-only E2E and screenshot scripts. Refuses any non-local base.
import { mkdirSync } from 'node:fs';

export function parseArgs(argv = process.argv.slice(2)) {
  const flag = (n, d) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
  const base = flag('base', 'http://127.0.0.1:4321');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) { console.error('Refusing to run against a non-local base:', base); process.exit(1); }
  const shots = flag('shots', '');
  if (shots) mkdirSync(shots, { recursive: true });
  const theme = argv.includes('--light') ? 'light' : 'dark';
  return { argv, flag, base, shots, theme };
}

export function makeApi(base) {
  return async (method, path, token, body) => {
    const r = await fetch(base + '/v1' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
}

export function makeChecker() {
  const results = [];
  const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
  const done = () => { const failed = results.filter((r) => !r.ok).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); return failed; };
  return { check, done, results };
}

/** Collect browser-side problems: console errors/warnings, HTTP >= 400, and any request that leaves localhost. */
export function watch(page) {
  const errors = []; const bad = []; const external = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol.startsWith('http')) external.push(r.url()); });
  return { errors, bad, external };
}

export const themeInit = (theme) => (t) => { try { localStorage.setItem('ah-theme', t); } catch {} };
