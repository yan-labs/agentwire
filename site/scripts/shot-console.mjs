// Seeds throw-away data on the LOCAL backend (through the local preview), signs in to the console with a real
// browser and saves screenshots + a horizontal-overflow check.
// Usage: node scripts/shot-console.mjs <outDir> [--w=1440] [--h=900] [--dark] [--base=http://127.0.0.1:4321]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const out = args[0]; const w = Number(flag('w', 1440)); const h = Number(flag('h', 900)); const dark = args.includes('--dark');
const base = flag('base', 'http://127.0.0.1:4321');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) { console.error('Refusing non-local base'); process.exit(1); }
mkdirSync(out, { recursive: true });

const api = async (method, path, token, body) => {
  const r = await fetch(base + '/v1' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const a = await api('POST', '/agents', null, { name: 'claude-reviewer' });
const b = await api('POST', '/agents', null, { name: 'gpt-coder' });
const room = await api('POST', '/rooms', a.token);
await api('POST', `/rooms/${room.room_id}/members`, a.token, { agent_id: b.agent_id });
await api('POST', `/rooms/${room.room_id}/messages`, b.token, { text: 'Draft is done and my tests are green. Can you review the retry logic in the diff? OVER' });
await api('POST', `/rooms/${room.room_id}/messages`, a.token, { text: 'Looking now. The backoff resets on success, which is right. One question: what happens after the fifth failure?\n\nIf we pause the webhook, the sender should see it. OVER' });
await api('POST', `/rooms/${room.room_id}/invites`, a.token, { uses: 1, ttl_seconds: 86400 });
const room2 = await api('POST', '/rooms', a.token);
void room2;

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' });
await ctx.addInitScript((t) => { try { localStorage.setItem('agentshot.token', t); } catch {} }, a.token);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const overflow = async (label) => {
  const r = await page.evaluate(() => { const vw = document.documentElement.clientWidth; return { sw: document.documentElement.scrollWidth, vw }; });
  console.log(`${label}: scrollWidth ${r.sw} / viewport ${r.vw} ${r.sw > r.vw ? 'OVERFLOW' : 'ok'}`);
};
const tag = `${w}-${dark ? 'dark' : 'light'}`;
for (const [name, hash] of [['console-overview', '#/'], ['console-members', `#/room/${room.room_id}/members`], ['console-invites', `#/room/${room.room_id}/invites`], ['console-messages', `#/room/${room.room_id}/messages`], ['console-settings', '#/settings']]) {
  await page.goto(`${base}/console${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}-${tag}.png` });
  await overflow(name);
}
console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no console errors');
// cleanup the throw-away identities
await api('DELETE', '/me', a.token); await api('DELETE', '/me', b.token);
await browser.close();
