// Renders the share images from HTML with the site's own fonts and generated key art (Deep Field look):
//   public/og.png (home), public/og/<page>.png (one per key page), public/apple-touch-icon.png (180x180).
// Usage: node scripts/make-og.mjs   (uses the locally installed Chrome through playwright-core)
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const url = (p) => pathToFileURL(p).href;
const faces = `
@font-face{font-family:'Geist';src:url('${url(pub + 'fonts/geist-latin-wght-normal.woff2')}');font-weight:100 900}
@font-face{font-family:'Geist Mono';src:url('${url(pub + 'fonts/geist-mono-latin-wght-normal.woff2')}');font-weight:100 900}`;
const mark = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><defs><radialGradient id="a" cx=".4" cy=".36" r=".64"><stop offset="0" stop-color="#fff"/><stop offset=".42" stop-color="#7fd8ff"/><stop offset="1" stop-color="#2bb8f0" stop-opacity=".25"/></radialGradient><radialGradient id="b" cx=".4" cy=".36" r=".64"><stop offset="0" stop-color="#fff"/><stop offset=".42" stop-color="#ffb070"/><stop offset="1" stop-color="#f0803c" stop-opacity=".25"/></radialGradient></defs><path d="M7.6 12.6C8.9 7.4 13.2 5.6 16.4 7.2" fill="none" stroke="#f4f7ff" stroke-opacity=".6" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="0.01 2.6"/><circle cx="6.4" cy="16.2" r="4.1" fill="url(#a)"/><circle cx="18" cy="8" r="3.4" fill="url(#b)"/></svg>`;

// art: [file, css for the <img>] — the art sits right, the title left
const art = {
  lights: [here + 'og-art/two-lights.webp', 'right:-40px;top:0;width:1000px;height:630px;object-fit:cover;object-position:80% 50%'],
  constellation: [pub + 'images/constellation-1600.webp', 'right:-260px;top:-40px;width:1200px'],
  room: [pub + 'images/room-1600.webp', 'right:-220px;top:-120px;width:1150px'],
  dissolve: [pub + 'images/dissolve-1600.webp', 'right:-420px;top:-90px;width:1250px'],
  horizon: [pub + 'images/horizon-bright-1600.webp', 'left:-200px;bottom:-330px;width:1600px'],
};
const pages = [
  { out: 'og.png', kick: 'The pager for AI assistants', title: 'A pager for <em>AI agents.</em>', art: 'lights' },
  { out: 'og/connect.png', kick: 'Connect', title: 'Connect <em>your AI.</em>', art: 'constellation' },
  { out: 'og/pricing.png', kick: 'Pricing', title: 'Free, with <em>fair use.</em>', art: 'horizon' },
  { out: 'og/docs.png', kick: 'Documentation', title: 'Docs and <em>API reference.</em>', art: 'room' },
  { out: 'og/multi-agent-chat.png', kick: 'Multi-agent chat', title: 'One room for <em>all your AI agents.</em>', art: 'constellation' },
  { out: 'og/agent-to-agent-communication.png', kick: 'Agent-to-agent', title: 'Let agents <em>talk directly.</em>', art: 'room' },
  { out: 'og/connect-chatgpt-and-claude.png', kick: 'ChatGPT + Claude', title: 'Make ChatGPT and <em>Claude talk.</em>', art: 'dissolve' },
];
const html = (p) => {
  const [src, css] = art[p.art];
  return `<!doctype html><meta charset="utf-8"><style>${faces}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#04050b;font-family:'Geist',sans-serif;color:#eef1f8;position:relative;overflow:hidden}
.art{position:absolute;${css}}
.fade{position:absolute;inset:0;background:linear-gradient(90deg,#04050b 0%,rgba(4,5,11,.92) 34%,rgba(4,5,11,.2) 62%,transparent 80%)}
.brand{position:absolute;left:76px;top:64px;display:flex;align-items:center;gap:14px;font-weight:600;font-size:30px;letter-spacing:-.03em}
.brand span{color:#7d85a1;font-weight:500}
.kick{position:absolute;left:76px;top:206px;display:flex;align-items:center;gap:12px;font-family:'Geist Mono',monospace;font-size:18px;letter-spacing:.16em;text-transform:uppercase;color:#aab1c5}
.kick i{width:10px;height:10px;border-radius:50%;background:#7fd8ff;box-shadow:0 0 16px #7fd8ff}
h1{position:absolute;left:72px;top:252px;width:640px;font-size:84px;line-height:.96;letter-spacing:-.055em;font-weight:530}
h1 em{font-style:normal;background:linear-gradient(100deg,#7fd8ff,#cfe9ff 42%,#ffd9b8 62%,#ffb070);-webkit-background-clip:text;background-clip:text;color:transparent}
.foot{position:absolute;left:76px;bottom:62px;font-family:'Geist Mono',monospace;font-size:19px;color:#7d85a1;display:flex;gap:28px}
</style>
<img class="art" src="${url(src)}"><div class="fade"></div>
<div class="brand">${mark(40)}agents<span>.hot</span></div>
<div class="kick"><i></i>${p.kick}</div>
<h1>${p.title}</h1>
<div class="foot"><span>Free</span><span>No SDK</span><span>Deleted once read</span></div>`;
};
const icon = `<!doctype html><style>*{margin:0}body{width:180px;height:180px;background:radial-gradient(circle at 30% 20%,#0d1426,#04050b 70%);display:grid;place-items:center}</style>${mark(132)}`;

const dir = mkdtempSync(join(tmpdir(), 'og-'));
mkdirSync(pub + 'og', { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1200, height: 630 } });
for (const p of pages) {
  const f = join(dir, p.out.replace('/', '_') + '.html');
  writeFileSync(f, html(p));
  await page.goto(url(f), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: pub + p.out });
  console.log('wrote public/' + p.out);
}
await page.setViewportSize({ width: 180, height: 180 });
writeFileSync(join(dir, 'icon.html'), icon);
await page.goto(url(join(dir, 'icon.html')));
await page.screenshot({ path: pub + 'apple-touch-icon.png' });
console.log('wrote public/apple-touch-icon.png');
await b.close();
