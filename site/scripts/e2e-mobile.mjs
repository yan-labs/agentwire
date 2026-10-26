// Phone flow end to end (390x844, touch, coarse pointer) against the LOCAL preview + LOCAL backend:
// register an identity -> create a room -> invite an AI (copy full prompt) -> the AI joins and answers -> read and send -> people -> me.
// Usage: node scripts/e2e-mobile.mjs --shots=/path/to/dir [--light] [--base=http://127.0.0.1:4321]
import { chromium } from 'playwright-core';
import { parseArgs, makeApi, makeChecker, watch } from './lib.mjs';

const { base, shots, theme } = parseArgs();
const api = makeApi(base);
const { check, done } = makeChecker();
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
await ctx.addInitScript((t) => { try { localStorage.setItem('ah-theme', t); } catch {} }, theme);
const page = await ctx.newPage();
const w = watch(page);
let n = 0, step = '';
const shot = async (name) => { n++; if (shots) await page.screenshot({ path: `${shots}/mobile-flow-${String(n).padStart(2, '0')}-${name}-390-${theme}.png` }); };
const overflow = async (label) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  check(`no horizontal overflow: ${label}`, r.sw <= r.vw, `${r.sw}/${r.vw}`);
};
const big = async (loc, label, min = 44) => { const b = await loc.boundingBox(); check(`touch target >= ${min}px: ${label}`, !!b && b.height >= min - 0.5 && b.width >= min - 0.5, b ? `${Math.round(b.width)}x${Math.round(b.height)}` : 'missing'); };
const inViewport = async (loc, label) => { const b = await loc.boundingBox(); check(`inside the viewport: ${label}`, !!b && b.y >= 0 && b.y + b.height <= 844 + 0.5, b ? `y ${Math.round(b.y)}-${Math.round(b.y + b.height)}` : 'missing'); };
let token = '', secondToken = '';

try {
  step = 'register';
  await page.goto(base + '/console', { waitUntil: 'networkidle' });
  check('phone matches the coarse pointer media query', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
  await overflow('register screen');
  await big(page.locator('#name'), 'name field');
  await big(page.getByRole('button', { name: 'Create identity' }), 'Create identity');
  await shot('register');
  await page.locator('#name').fill('muse');
  await page.getByRole('button', { name: 'Create identity' }).tap();
  await page.getByRole('heading', { name: /Save your token/i }).waitFor({ timeout: 8000 });
  token = (await page.locator('dialog input.secret').inputValue()).trim();
  check('token shown once in a bottom sheet', token.length >= 24);
  await shot('token');
  await page.locator('#ack-saved').check();
  await page.getByRole('button', { name: 'Continue' }).tap();

  step = 'rooms';
  await page.locator('#new-room').waitFor({ timeout: 8000 });
  check('token in localStorage, not in the URL', (await page.evaluate(() => localStorage.getItem('agentshot.token'))) === token && !page.url().includes(token));
  await inViewport(page.locator('#new-room'), 'New room button');
  await big(page.locator('#new-room'), 'New room', 44);
  await overflow('empty rooms list');
  await shot('rooms-empty');

  step = 'new room';
  await page.locator('#new-room').tap();
  await page.waitForURL(/#\/room\/room_/, { timeout: 8000 });
  const roomId = decodeURIComponent(page.url().split('#/room/')[1].split('/')[0]);
  await page.getByText('Only you are here').waitFor({ timeout: 8000 });
  check('new room opens straight into the chat', await page.locator('#composer').isVisible());
  await inViewport(page.locator('#composer'), 'composer');
  await overflow('empty room chat');
  await shot('chat-empty');

  step = 'invite';
  await page.locator('#go-invite').tap();
  await page.locator('#ai-name').fill('claude');
  await page.locator('#create-invite').tap();
  await page.locator('#new-invite').waitFor({ timeout: 8000 });
  await page.locator('#copy-full-prompt').scrollIntoViewIfNeeded();
  await big(page.locator('#copy-full-prompt'), 'Copy full prompt', 44);
  await page.locator('#copy-full-prompt').tap();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const link = await page.locator('#new-invite input[aria-label="Invite link"]').inputValue();
  const code = link.split('/').pop();
  check('full prompt with the invite code is on the clipboard', copied.includes(code) && copied.includes(roomId) && copied.includes('Your name:   claude'));
  await overflow('invite panel');
  await page.evaluate(() => document.querySelector('.c-scroll')?.scrollTo(0, 0));
  await shot('invite');

  step = 'ai joins';
  const second = (await api('POST', '/agents', null, { name: 'claude' })).body;
  secondToken = second.token;
  const acc = await api('POST', `/invites/${code}/accept`, secondToken);
  check('an AI accepts the invite made on the phone', acc.status === 201 || acc.status === 200, `status ${acc.status}`);
  await api('POST', `/rooms/${roomId}/messages`, secondToken, { text: 'Hi, I just joined from your invite. What should we work on? OVER' });
  await page.getByRole('tab', { name: 'Chat' }).tap();
  await page.getByText('I just joined from your invite').waitFor({ timeout: 12000 });
  check('the AI’s message shows up in the stream', true);
  await shot('chat-reply');

  step = 'send';
  const ta = page.locator('#composer');
  await ta.tap();
  await ta.fill('Review the retry logic in the diff, then reply with a summary.');
  await ta.press('Enter');
  check('Enter is a newline on a phone, not send', (await page.locator('.c-bubble.me').count()) === 0 && (await ta.inputValue()).endsWith('\n'));
  await ta.fill('Review the retry logic in the diff, then reply with a summary. OVER');
  await big(page.locator('#send'), 'Send button', 44);
  await inViewport(page.locator('#send'), 'Send button');
  await shot('composing');
  await page.locator('#send').tap();
  await page.locator('.c-bubble.me', { hasText: 'Review the retry logic' }).waitFor({ timeout: 8000 });
  const got = await api('GET', `/rooms/${roomId}/messages`, secondToken);
  check('the sent message reached the AI', got.body.messages?.some((m) => m.text.startsWith('Review the retry logic')));
  await overflow('chat with messages');
  await inViewport(page.locator('#composer'), 'composer after sending');
  await shot('sent');

  step = 'people + me';
  await page.getByRole('tab', { name: /People/ }).tap();
  await page.getByText('claude').first().waitFor();
  await overflow('people');
  await shot('people');
  await page.locator('.c-back').tap();
  await page.locator('#new-room').waitFor();
  check('back arrow returns to the room list', (await page.locator('.c-room').count()) === 1);
  await overflow('room list with a room');
  await shot('rooms');
  await page.locator('a[href="#/me"]').tap();
  await page.locator('#sign-out').waitFor();
  await overflow('my identity');
  await shot('me');
} catch (e) {
  check('mobile flow completed without throwing', false, `at "${step}": ` + String(e).split('\n')[0]);
  if (shots) await page.screenshot({ path: `${shots}/mobile-failure-${theme}.png` });
}
if (token) await api('DELETE', '/me', token);
if (secondToken) await api('DELETE', '/me', secondToken);
const real = w.errors.filter((e) => !/net::ERR_FAILED/.test(e));
check('no console errors or CSP violations', real.length === 0, real.slice(0, 3).join(' | '));
check('no requests left localhost', w.external.length === 0, w.external.slice(0, 3).join(' '));
await browser.close();
process.exit(done() ? 1 : 0);
