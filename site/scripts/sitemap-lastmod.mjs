import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('..', import.meta.url));
const sitemap = resolve(site, 'dist/sitemap.xml');
const filesFor = (entry, seen = new Set()) => {
  const file = resolve(site, entry);
  if (seen.has(file) || !existsSync(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  if (file.endsWith('.md')) {
    if (source.includes('{{')) filesFor('src/config.ts', seen);
    if (source.includes('{{promptText}}')) filesFor('src/data/prompt.ts', seen);
  } else {
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), match[1]);
      const dependency = [base, ...['.astro', '.ts', '.tsx', '.js', '.mjs'].map((ext) => base + ext)].find(existsSync);
      if (dependency) filesFor(dependency, seen);
    }
  }
  return seen;
};
const datesByFile = new Map();
const dateFor = (file) => {
  if (!datesByFile.has(file)) datesByFile.set(file, execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: site, encoding: 'utf8' }).trim());
  return datesByFile.get(file);
};
const xml = readFileSync(sitemap, 'utf8').replace(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g, (match, loc, updated) => {
  const path = new URL(loc).pathname;
  const entries = path === '/' ? ['src/pages/index.astro']
    : path === '/connect' || path === '/pricing' ? [`src/pages${path}.astro`]
    : path === '/docs/api' ? ['src/pages/docs/api.astro']
    : path === '/docs' || path.startsWith('/docs/') ? ['src/pages/docs/[...slug].astro', `src/content/docs/${path === '/docs' ? 'index' : path.slice(6)}.md`]
    : ['src/pages/[slug].astro', `src/content/pages/${path.slice(1)}.md`];
  const files = new Set();
  for (const entry of entries) filesFor(entry, files);
  const dates = [...files].map(dateFor);
  return match.replace(`<lastmod>${updated}</lastmod>`, `<lastmod>${[updated, ...dates].sort().at(-1)}</lastmod>`);
});
writeFileSync(sitemap, xml);
