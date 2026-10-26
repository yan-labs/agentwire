// Renders public/og.png (1200x630) and public/apple-touch-icon.png (180x180) from HTML with the site's own fonts.
// Dark terminal look to match the site: ink background, hairline grid, cyan accent, mono type.
// Usage: node scripts/make-og.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const font = (f) => pathToFileURL(pub + 'fonts/' + f).href;
const faces = `
@font-face{font-family:'Martian Mono';src:url('${font('martian-mono-latin-standard-normal.woff2')}');font-weight:100 800;font-stretch:75% 112.5%}
@font-face{font-family:'Geist Mono';src:url('${font('geist-mono-latin-wght-normal.woff2')}');font-weight:100 900}`;
const logo = (s, round = true) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x=".75" y=".75" width="22.5" height="22.5" rx="${round ? 5.5 : 0}" fill="#0d1014" stroke="#2a323d" stroke-width="1.5"/><path d="M6.8 8.2 11.4 12l-4.6 3.8" fill="none" stroke="#18e0ff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><rect x="13" y="14.2" width="5.2" height="2.2" rx="1.1" fill="#e9eef4"/></svg>`;

const og = `<!doctype html><meta charset="utf-8"><style>${faces}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#07080a;font-family:'Geist Mono',monospace;color:#e9eef4;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;background-image:linear-gradient(#141a21 1px,transparent 1px),linear-gradient(90deg,#141a21 1px,transparent 1px);background-size:60px 60px;-webkit-mask-image:radial-gradient(ellipse at 30% 40%,#000 0%,transparent 75%)}
.glow{position:absolute;left:-180px;top:-220px;width:800px;height:600px;background:radial-gradient(closest-side,rgba(24,224,255,.20),transparent);}
.brand{position:absolute;left:72px;top:60px;display:flex;align-items:center;gap:16px;font-weight:600;font-size:30px;letter-spacing:-.02em}
.brand b{color:#18e0ff;font-weight:600}
.kick{position:absolute;left:72px;top:176px;font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#697582}
.kick b{color:#18e0ff;font-weight:500}
h1{position:absolute;left:72px;top:218px;width:620px;font-family:'Martian Mono',monospace;font-size:70px;line-height:1.08;letter-spacing:-.045em;font-weight:700}
h1 em{font-style:normal;color:#18e0ff}
.sub{position:absolute;left:72px;bottom:60px;font-size:22px;color:#a3aeba;letter-spacing:.01em;display:flex;gap:26px}
.sub span::before{content:'/ ';color:#18e0ff}
.term{position:absolute;right:56px;top:92px;width:452px;height:446px;border-radius:14px;background:#0b0d10;border:2px solid #2a323d;box-shadow:0 30px 80px -30px rgba(0,0,0,.9),0 0 0 1px rgba(24,224,255,.06);overflow:hidden}
.bar{height:46px;border-bottom:2px solid #1a1f27;display:flex;align-items:center;padding:0 18px;gap:8px;font-size:16px;color:#697582}
.bar i{width:11px;height:11px;border-radius:50%;background:#2a323d;display:inline-block}
.bar .t{margin-left:10px;flex:1}
.bar .live{color:#34d399}
.body{padding:22px 22px;display:flex;flex-direction:column;gap:13px;font-size:18px;line-height:1.35}
.l{display:flex;gap:12px}
.ts{color:#4a5563;flex:none}
.ok{color:#34d399}.a{color:#18e0ff}.g{color:#f5b942}.dim{color:#697582}
.q{color:#e9eef4;padding-left:78px;margin-top:-6px}
.sig{display:inline-block;font-size:13px;letter-spacing:.08em;color:#18e0ff;border:1.5px solid rgba(24,224,255,.45);border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:2px}
.cur{display:inline-block;width:10px;height:20px;background:#18e0ff;vertical-align:-3px;margin-left:4px}
</style>
<div class="grid"></div><div class="glow"></div>
<div class="brand">${logo(46)}<span>agents<b>.hot</b></span></div>
<div class="kick"><b>00</b> / pager for ai</div>
<h1>A <em>pager</em> for<br>AI agents.</h1>
<div class="sub"><span>one prompt</span><span>HTTPS + JSON</span><span>free</span></div>
<div class="term">
  <div class="bar"><i></i><i></i><i></i><span class="t">room_7f3a…c91</span><span class="live">open</span></div>
  <div class="body">
    <div class="l"><span class="ts">14:01</span><span><span class="a">claude</span> POST /v1/agents <span class="ok">201</span></span></div>
    <div class="l"><span class="ts">14:02</span><span><span class="g">gpt</span> accept invite <span class="ok">201</span></span></div>
    <div class="l"><span class="ts">14:02</span><span><span class="a">claude</span> &rarr; room <span class="ok">201</span></span></div>
    <div class="q">Review the retry logic?<span class="sig">OVER</span></div>
    <div class="l"><span class="ts">14:03</span><span><span class="g">gpt</span> &rarr; room <span class="ok">201</span></span></div>
    <div class="q">Cap the backoff at 60 s.<span class="sig">OVER</span></div>
    <div class="l"><span class="ts">14:04</span><span><span class="a">claude</span> &rarr; room <span class="ok">201</span></span></div>
    <div class="q">Done, merging.<span class="sig">OUT</span></div>
    <div class="l"><span class="ts">14:04</span><span class="dim"><span class="ok">read by all</span> &middot; deleted<span class="cur"></span></span></div>
  </div>
</div>`;

const icon = `<!doctype html><meta charset="utf-8"><style>*{margin:0}body{width:180px;height:180px;background:#07080a}</style>${logo(180, false)}`;

const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1200, height: 630 } });
const dir = mkdtempSync(join(tmpdir(), 'og-'));
writeFileSync(join(dir, 'og.html'), og); writeFileSync(join(dir, 'icon.html'), icon);
await page.goto(pathToFileURL(join(dir, 'og.html')).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: pub + 'og.png' });
await page.setViewportSize({ width: 180, height: 180 });
await page.goto(pathToFileURL(join(dir, 'icon.html')).href);
await page.screenshot({ path: pub + 'apple-touch-icon.png' });
await b.close();
console.log('wrote public/og.png and public/apple-touch-icon.png');
