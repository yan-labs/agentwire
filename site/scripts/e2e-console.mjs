// Console end-to-end run on a desktop viewport against the LOCAL preview + LOCAL backend (never production).
// Usage: node scripts/e2e-console.mjs [--base=http://127.0.0.1:4321] [--shots=/path/to/dir] [--light]
// Creates throw-away identities on the local backend, drives the console in real Chrome, checks console/CSP errors.
// Covers: register, room, invite + "copy full prompt", people, read, SEND (keyboard, limit, failure + retry, direct), invite landing, sign out/in, delete.
import { chromium } from 'playwright-core';
import { parseArgs, makeApi, makeChecker, watch } from './lib.mjs';

const { base, shots, theme } = parseArgs();
const api = makeApi(base);
const { check, done } = makeChecker();

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
await ctx.addInitScript((t) => { try { localStorage.setItem('ah-theme', t); } catch {} }, theme);
const page = await ctx.newPage();
const w = watch(page);
let step = '';
const S = (n) => { step = n; };
const shot = async (n) => { if (shots) await page.evaluate(() => document.querySelectorAll('.toast:not(.toast-error)').forEach((t) => t.remove())); /* stale toasts would cover content */ if (shots) await page.screenshot({ path: `${shots}/${n}-1440-${theme}.png` }); };
const clip = () => page.evaluate(() => navigator.clipboard.readText());
let secondToken = '', thirdToken = '';

try {
  S('login');
  await page.goto(base + '/console', { waitUntil: 'networkidle' });
  check('login card renders', await page.getByRole('heading', { name: 'Console', exact: true }).isVisible());
  await shot('console-login');

  S('register');
  await page.locator('#name').fill('e2e-owner');
  await page.getByRole('button', { name: 'Create identity' }).click();
  await page.getByRole('heading', { name: /Save your token/i }).waitFor({ timeout: 8000 });
  const token = (await page.locator('dialog input.secret').inputValue()).trim();
  check('identity created and token shown once', token.length >= 24, `len ${token.length}`);
  await shot('console-token-dialog');
  await page.locator('#ack-saved').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#new-room').waitFor({ timeout: 8000 });
  check('lands in the console after registering', true);
  check('token stored only in localStorage, never in the URL', (await page.evaluate(() => localStorage.getItem('agentshot.token'))) === token && !page.url().includes(token));
  await shot('console-home');

  S('create room');
  await page.locator('#new-room').click();
  await page.waitForURL(/#\/room\/room_/, { timeout: 8000 });
  const roomId = decodeURIComponent(page.url().split('#/room/')[1].split('/')[0]);
  check('room created and opened', roomId.startsWith('room_'));
  await page.getByText('Only you are here').waitFor({ timeout: 8000 });
  check('empty room invites you to add an AI', await page.getByText('Only you are here').isVisible());
  await shot('console-room-empty');

  S('invite');
  await page.locator('#go-invite').click();
  await page.locator('#ai-name').fill('muse');
  await page.locator('#create-invite').click();
  await page.locator('#new-invite').waitFor({ timeout: 8000 });
  const code = await page.locator('#new-invite input[aria-label="Invite link"]').inputValue();
  const inviteCode = code.split('/').pop();
  check('invite link created', /\/invite\/inv_/.test(code));
  await page.locator('#copy-full-prompt').click();
  const copied = await clip();
  check('"Copy full prompt" copies the onboarding prompt with the invite code, room and name', copied.includes('Agents Hot onboarding') && copied.includes(inviteCode) && copied.includes(roomId) && copied.includes('Your name:   muse'), `len ${copied.length}`);
  check('copied prompt contains no token', !copied.includes(token));
  await shot('console-invite');
  const list1 = await api('GET', `/rooms/${roomId}/invites`, token);
  check('invite list responds (backend or shim)', list1.status === 200 && (list1.body.invites?.length ?? 0) >= 1, `status ${list1.status}`);
  const revoke = page.getByRole('button', { name: 'Revoke' }).first();
  await revoke.click();
  await page.locator('dialog').getByRole('button', { name: 'Revoke' }).click();
  await page.getByText('Invite revoked').first().waitFor({ timeout: 6000 }).catch(() => {});
  const list2 = await api('GET', `/rooms/${roomId}/invites`, token);
  check('invite revoked', (list2.body.invites?.length ?? 1) === 0);

  S('people');
  const second = (await api('POST', '/agents', null, { name: 'e2e-second' })).body;
  const third = (await api('POST', '/agents', null, { name: 'e2e-third' })).body;
  secondToken = second.token; thirdToken = third.token;
  await page.getByRole('tab', { name: /People/ }).click();
  await page.locator('#addid').fill(second.agent_id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('tab', { name: 'People · 2' }).waitFor({ timeout: 8000 });
  await page.locator('#addid').fill(third.agent_id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('tab', { name: 'People · 3' }).waitFor({ timeout: 8000 });
  const members = await api('GET', `/rooms/${roomId}/members`, token);
  check('second and third identities added from the console', members.body.members?.some((m) => m.agent_id === second.agent_id) && members.body.members?.some((m) => m.agent_id === third.agent_id));
  await shot('console-people');

  S('read');
  await page.getByRole('tab', { name: 'Chat' }).click();
  const hello = await api('POST', `/rooms/${roomId}/messages`, secondToken, { text: 'Hello from the second agent. OVER' });
  check('second agent sent a message (API)', hello.status === 201 || hello.status === 200, `status ${hello.status}`);
  await page.getByText('Hello from the second agent').first().waitFor({ timeout: 12000 }).catch(() => {});
  check('incoming message appears in the stream without reloading', await page.getByText('Hello from the second agent').first().isVisible().catch(() => false));
  check('OVER is rendered as a signal chip', (await page.locator('.c-bubble .sig', { hasText: 'OVER' }).count()) >= 1);
  await shot('console-chat');

  S('send');
  const composer = page.locator('#composer');
  await composer.fill('Reply from the console, via the send box.');
  await page.locator('#send').click();
  await page.locator('.c-bubble.me', { hasText: 'Reply from the console' }).waitFor({ timeout: 8000 });
  let got = await api('GET', `/rooms/${roomId}/messages`, secondToken);
  const mine = got.body.messages?.find((m) => m.text === 'Reply from the console, via the send box.');
  check('console message was stored and is visible to the other member', !!mine && mine.from === (await api('GET', '/me', token)).body.agent_id);
  check('composer cleared after sending', (await composer.inputValue()) === '');

  await composer.fill('Enter sends on desktop.');
  await composer.press('Enter');
  await page.locator('.c-bubble.me', { hasText: 'Enter sends on desktop' }).waitFor({ timeout: 8000 });
  check('Enter sends on desktop', true);
  await composer.fill('line one');
  await composer.press('Shift+Enter');
  await composer.type('line two');
  check('Shift+Enter inserts a newline', (await composer.inputValue()) === 'line one\nline two');
  await composer.fill('');

  S('limit');
  await composer.fill('x'.repeat(32001));
  check('32,001 characters: counter shows and send is disabled', (await page.locator('#send').isDisabled()) && (await page.locator('.c-composer .count.over').count()) === 1);
  await composer.fill('y'.repeat(32000));
  check('32,000 characters: send is enabled', !(await page.locator('#send').isDisabled()));
  await page.locator('#send').click();
  await page.locator('.c-bubble.me', { hasText: 'yyyyyyyyyy' }).waitFor({ timeout: 10000 });
  got = await api('GET', `/rooms/${roomId}/messages`, secondToken);
  check('a 32,000-character message is accepted by the backend', got.body.messages?.some((m) => m.text.length === 32000));

  S('failure + retry');
  let fail = true;
  await page.route('**/v1/rooms/*/messages', async (route) => {
    if (route.request().method() === 'POST' && fail) return route.abort('failed');
    return route.continue();
  });
  await composer.fill('This one fails first.');
  await page.locator('#send').click();
  await page.locator('.c-bubble.failed').waitFor({ timeout: 6000 });
  check('a failed send stays visible with Retry and keeps the text', (await page.getByRole('button', { name: 'Retry' }).count()) === 1 && (await page.locator('.c-bubble.failed').innerText()).includes('This one fails first.'));
  await shot('console-send-failed');
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.locator('.c-bubble.me:not(.failed):not(.pending)', { hasText: 'This one fails first.' }).waitFor({ timeout: 8000 });
  check('Retry delivers the message', true);
  await page.unroute('**/v1/rooms/*/messages');

  S('direct message');
  await page.locator('#to').selectOption({ label: 'To: e2e-third' });
  await composer.fill('Only for the third agent.');
  await page.locator('#send').click();
  await page.locator('.c-bubble.me', { hasText: 'Only for the third agent.' }).waitFor({ timeout: 8000 });
  const forSecond = await api('GET', `/rooms/${roomId}/messages`, secondToken);
  const forThird = await api('GET', `/rooms/${roomId}/messages`, thirdToken);
  check('a direct message reaches only its recipient', !forSecond.body.messages?.some((m) => m.text === 'Only for the third agent.') && forThird.body.messages?.some((m) => m.text === 'Only for the third agent.'));
  await shot('console-chat-sent');

  S('invite landing');
  const inv = (await api('POST', `/rooms/${roomId}/invites`, token, { uses: 1, ttl_seconds: 3600 })).body;
  const anon = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
  await anon.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
  await anon.addInitScript((t) => { try { localStorage.setItem('ah-theme', t); } catch {} }, theme);
  const ap = await anon.newPage();
  await ap.goto(`${base}/invite/${inv.code}`, { waitUntil: 'networkidle' });
  const promptText = await ap.locator('#inv-prompt').innerText();
  check('invite page prompt has the invite code filled in', promptText.includes(inv.code) && !promptText.includes('<INVITE_CODE>'));
  await ap.locator('#inv-copy').click();
  check('invite page copy button copies that prompt', (await ap.evaluate(() => navigator.clipboard.readText())).includes(inv.code));
  check('invite page has no join button when signed out', (await ap.locator('#join-as-me').count()) === 0);
  if (shots) await ap.screenshot({ path: `${shots}/invite-page-1280-${theme}.png` });
  await anon.close();
  const joiner = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await joiner.addInitScript((t) => { try { localStorage.setItem('agentshot.token', t); } catch {} }, thirdToken);
  const jp = await joiner.newPage();
  await jp.goto(`${base}/invite/${inv.code}`, { waitUntil: 'networkidle' });
  await jp.locator('#join-as-me').click();
  await jp.getByText(/Already in|already in this room|^Joined/).first().waitFor({ timeout: 6000 }).catch(() => {});
  check('a signed-in identity can accept from the invite page', (await jp.locator('#inv-status').innerText()).length > 0);
  await joiner.close();

  S('me, sign out, sign in, delete');
  await page.goto(`${base}/console#/me`, { waitUntil: 'networkidle' });
  await shot('console-me');
  await page.locator('#sign-out').click();
  await page.getByRole('heading', { name: 'Console', exact: true }).waitFor({ timeout: 5000 });
  check('sign out clears the stored token', (await page.evaluate(() => localStorage.getItem('agentshot.token'))) === null);
  await page.getByRole('tab', { name: 'I have a token' }).click();
  await page.locator('#token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#new-room').waitFor({ timeout: 8000 });
  check('sign in with a token works', true);
  await page.goto(`${base}/console#/me`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Delete identity' }).click();
  await page.locator('dialog input').first().fill('e2e-owner');
  await page.locator('dialog').getByRole('button', { name: 'Delete identity' }).click();
  await page.getByRole('heading', { name: 'Console', exact: true }).waitFor({ timeout: 8000 });
  const gone = await api('GET', '/me', token);
  check('identity deleted on the backend', [401, 403, 404].includes(gone.status), `status ${gone.status}`);
} catch (e) {
  check('e2e run completed without throwing', false, `at step "${step}": ` + String(e).split('\n')[0]);
  await shot('console-failure');
}
for (const t of [secondToken, thirdToken]) if (t) await api('DELETE', '/me', t);
const realErrors = w.errors.filter((e) => !/Failed to load resource: net::ERR_FAILED/.test(e)); // the deliberate aborted POST in the failure test
check('no console errors or CSP violations', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') + (realErrors.length && w.bad.length ? ' [HTTP>=400: ' + w.bad.join(', ') + ']' : ''));
check('no requests left localhost', w.external.length === 0, w.external.slice(0, 3).join(' '));
await browser.close();
process.exit(done() ? 1 : 0);
