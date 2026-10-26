// Console end-to-end run against the LOCAL preview + LOCAL backend (never production).
// Usage: node scripts/e2e-console.mjs [--base=http://127.0.0.1:4321] [--shots=/path/to/dir]
// Creates throw-away identities on the local backend, drives the console in a real Chrome, checks for console/CSP errors.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const base = flag('base', 'http://127.0.0.1:4321');
const shots = flag('shots', '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) { console.error('Refusing to run against a non-local base:', base); process.exit(1); }
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const api = async (method, path, token, body) => {
  const r = await fetch(base + '/v1' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
const external = [];
page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url()); });
let step = '';
const S = (n) => { step = n; };
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/${n}.png` }); };

try {
  await page.goto(base + '/console', { waitUntil: 'networkidle' });
  check('login card renders', await page.getByRole('heading', { name: 'Agents Hot console' }).isVisible());
  await shot('console-login');

  // --- create identity via the UI
  await page.getByRole('tab', { name: /Create/i }).click();
  await page.locator('#name').fill('e2e-owner');
  await page.getByRole('button', { name: 'Create identity' }).click();
  await page.getByRole('heading', { name: /Save your token/i }).waitFor({ timeout: 8000 });
  const token = (await page.locator('dialog input').first().inputValue()).trim();
  check('identity created and token shown once', /^[0-9a-f]{64}$/.test(token));
  await shot('console-token-dialog');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Continue to console/i }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 8000 });
  check('lands on overview after create', true);
  check('token stored only in localStorage', (await page.evaluate(() => localStorage.getItem('agentshot.token'))) === token && !page.url().includes(token));

  // --- create a room
  S('create room');
  await page.getByRole('button', { name: /New room/ }).first().click();
  await page.getByText('Room created').first().waitFor({ timeout: 8000 });
  check('room created', true);
  const me = await api('GET', '/me', token);
  const roomId = me.body.rooms?.[0]?.room_id;
  check('room visible via API', !!roomId, roomId ? '' : JSON.stringify(me.body).slice(0, 120));
  await page.waitForURL(/#\/room\//, { timeout: 5000 }).catch(() => {});
  await shot('console-room-overview');

  // --- invite create
  S('invites');
  await page.goto(`${base}/console#/room/${roomId}/invites`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Create invite link/ }).click();
  await page.getByText(/invite/i).first().waitFor();
  await page.waitForTimeout(800);
  const inviteList1 = await api('GET', `/rooms/${roomId}/invites`, token);
  check('invite list responds (backend or shim)', inviteList1.status === 200 && (inviteList1.body.invites?.length ?? 0) >= 1, `status ${inviteList1.status}`);
  await shot('console-invites');
  const revokeBtn = page.getByRole('button', { name: 'Revoke' }).first();
  if (await revokeBtn.count()) {
    await revokeBtn.click();
    const confirm = page.locator('dialog').getByRole('button', { name: /Revoke/ });
    if (await confirm.count()) await confirm.click();
    await page.getByText('Invite revoked').first().waitFor({ timeout: 6000 }).catch(() => {});
    const inviteList2 = await api('GET', `/rooms/${roomId}/invites`, token);
    check('invite revoked', (inviteList2.body.invites?.length ?? 1) === 0);
  } else check('invite revoke button present', false);

  // --- second identity
  S('members+message');
  const second = (await api('POST', '/agents', null, { name: 'e2e-second' })).body;
  const secondId = second.agent_id, secondToken = second.token;
  await page.goto(`${base}/console#/room/${roomId}/members`, { waitUntil: 'networkidle' });
  await page.locator('input[placeholder*="agent_"], input[placeholder*="agent id" i]').first().fill(secondId);
  await page.getByRole('button', { name: /^Add/ }).first().click();
  await page.getByText('Member added').first().waitFor({ timeout: 6000 }).catch(() => {});
  const members = await api('GET', `/rooms/${roomId}/members`, token);
  check('second identity added as member', members.body.members?.some((m) => m.agent_id === secondId));
  await shot('console-members');
  const sent = await api('POST', `/rooms/${roomId}/messages`, secondToken, { text: 'Hello from the second agent. OVER' });
  check('second agent sent a message', sent.status === 201 || sent.status === 200, `status ${sent.status}`);
  await page.goto(`${base}/console#/room/${roomId}/messages`, { waitUntil: 'networkidle' });
  await page.getByText('Hello from the second agent').first().waitFor({ timeout: 6000 }).catch(() => {});
  check('message visible in console', await page.getByText('Hello from the second agent').first().isVisible().catch(() => false));
  await shot('console-messages');

  // --- settings, rotate
  S('settings/delete');
  await page.goto(`${base}/console#/settings`, { waitUntil: 'networkidle' });
  await shot('console-settings');
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await page.getByRole('heading', { name: 'Agents Hot console' }).waitFor({ timeout: 5000 });
  check('sign out clears stored token', (await page.evaluate(() => localStorage.getItem('agentshot.token'))) === null);
  await page.locator('#token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 8000 });
  check('sign in with token works', true);

  await page.goto(`${base}/console#/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Delete identity' }).click();
  const field = page.locator('dialog input').first();
  if (await field.count()) await field.fill('e2e-owner');
  await page.locator('dialog').getByRole('button', { name: /Delete/ }).last().click();
  await page.getByRole('heading', { name: 'Agents Hot console' }).waitFor({ timeout: 8000 });
  const gone = await api('GET', '/me', token);
  check('identity deleted on backend', gone.status === 401 || gone.status === 404 || gone.status === 403, `status ${gone.status}`);
  await api('DELETE', '/me', secondToken); // cleanup of the helper identity
} catch (e) {
  check('e2e run completed without throwing', false, `at step "${step}": ` + String(e).split('\n')[0]);
  await shot('console-failure');
}

check('no console errors or CSP violations', errors.length === 0, errors.slice(0, 3).join(' | ') + (bad.length ? ' [HTTP>=400: ' + bad.join(', ') + ']' : ''));
check('no requests left localhost', external.length === 0, external.slice(0, 3).join(' '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
