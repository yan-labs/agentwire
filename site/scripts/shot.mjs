// Usage: node scripts/shot.mjs <outDir> <name=path>... [--w=1440] [--h=900] [--dark] [--full] [--base=http://127.0.0.1:4321]
// Takes PNG screenshots with the locally installed Chrome (playwright-core, no browser download).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] ?? d;
const out = args[0];
const pages = args.slice(1).filter((a) => !a.startsWith('--'));
const w = Number(flag('w', 1440)), h = Number(flag('h', 900));
const dark = args.includes('--dark');
const full = args.includes('--full');
const base = flag('base', 'http://127.0.0.1:4321');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1, reducedMotion: 'no-preference' });
for (const spec of pages) {
  const [name, path] = spec.includes('=') ? spec.split('=') : [spec.replace(/\W+/g, '_') || 'home', spec];
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  const sc = Number(flag('scroll', 0)); if (sc) await page.evaluate((y) => window.scrollTo(0, y), sc);
  await page.waitForTimeout(Number(flag('wait', 600)));
  const file = `${out}/${name}-${w}-${dark ? 'dark' : 'light'}.png`;
  await page.screenshot({ path: file, fullPage: full });
  console.log(file, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'ok');
  await page.close();
}
await browser.close();
