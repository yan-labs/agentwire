// Runs after `astro build`: nothing to patch yet, but fail loudly if the build produced no pages.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const dist = new URL('../dist', import.meta.url).pathname;
let count = 0;
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') && count++; } })(dist);
if (count < 1) { console.error('postbuild: no HTML pages in dist'); process.exit(1); }
console.log(`postbuild: ${count} html pages in dist`);
