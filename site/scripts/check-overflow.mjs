// Mobile layout check: reports pages whose document is wider than a 390px viewport and the elements that stick out.
// Usage: node scripts/check-overflow.mjs /path ...   (needs the preview server on :4321)
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:4321';
const paths = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
for (const p of paths) {
  const page = await ctx.newPage();
  await page.goto(base + p, { waitUntil: 'networkidle' });
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.right > vw + 1 && b.width > 0) {
        // skip elements inside an overflow-scrolling ancestor
        let a = el.parentElement, clipped = false;
        while (a && a !== document.body) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX)) { clipped = true; break; } a = a.parentElement; }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${(el.className && el.className.toString().split(' ')[0]) || ''} right=${Math.round(b.right)} w=${Math.round(b.width)}`);
      }
    }
    return { sw: document.documentElement.scrollWidth, vw, out: out.slice(0, 8) };
  });
  console.log(p, r.sw > r.vw || r.out.length ? 'OVERFLOW' : 'ok', r.sw, r.vw, r.out.join(' | '));
  await page.close();
}
await b.close();
