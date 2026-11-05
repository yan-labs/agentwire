import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: resolve(site, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const source = (commit, file) => { try { return git('show', `${commit}:site/${file}`); } catch { return ''; } };
const history = (files) => git('log', '--format=%H %cs', '--', ...files.map((f) => `site/${f}`)).split('\n').filter(Boolean).map((line) => line.split(' '));
const url = (text) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`;

// Compare the content a page actually uses across commits, rather than whole shared files.
async function changed(files, value) {
  let previous;
  let latestDate = '';
  for (const [commit, date] of history(files)) {
    const current = await value(commit);
    if (previous !== undefined && current !== previous) break;
    previous = current;
    latestDate = date;
  }
  return latestDate;
}
const cleanPage = (s) => s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
const fileDate = (file) => changed([file], (commit) => source(commit, file));
const pageDate = (file) => changed([file], (commit) => cleanPage(source(commit, file)));
const shared = ['src/config.ts', 'src/data/prompt.ts', 'src/data/connect.ts', 'src/data/faq.ts', 'src/data/snippets.ts', 'src/data/api.ts'];
const snapshots = new Map();
async function snapshot(commit) {
  if (!snapshots.has(commit)) {
    const config = source(commit, shared[0]);
    if (!config) return null;
    const configUrl = url(config);
    const load = async (file) => {
      const text = source(commit, file);
      if (!text) return null;
      return import(url(text.replace(/(['"])\.\.\/config\1/g, JSON.stringify(configUrl))));
    };
    const configData = await import(configUrl);
    snapshots.set(commit, { config: configData, load });
  }
  return snapshots.get(commit);
}
const sitemap = resolve(site, 'dist/sitemap.xml');
let xml = readFileSync(sitemap, 'utf8');
for (const match of [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]) {
  const path = new URL(match[1]).pathname;
  const content = path === '/docs' || (path.startsWith('/docs/') && path !== '/docs/api')
    ? `src/content/docs/${path === '/docs' ? 'index' : path.slice(6)}.md`
    : !['/', '/connect', '/pricing', '/docs/api'].includes(path) ? `src/content/pages/${path.slice(1)}.md` : null;
  const page = path === '/' ? 'src/pages/index.astro' : path === '/connect' || path === '/pricing' ? `src/pages${path}.astro` : path === '/docs/api' ? 'src/pages/docs/api.astro' : null;
  const text = readFileSync(resolve(site, content || page), 'utf8');
  const vars = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  const fields = [...text.matchAll(/\b(SITE|API|LIMITS)\.(\w+)/g)].map((m) => [m[1], m[2]]);
  const contentDate = content ? await fileDate(content) : await pageDate(page);
  const sharedDate = await changed(shared, async (commit) => {
    const s = await snapshot(commit);
    if (!s) return '';
    const prompt = (vars.includes('promptText') || path === '/' || path === '/connect') ? await s.load(shared[1]) : null;
    const connect = path === '/' || path === '/connect' ? await s.load(shared[2]) : null;
    const faq = path === '/' ? await s.load(shared[3]) : null;
    const snippets = path === '/' ? await s.load(shared[4]) : null;
    const api = path === '/docs/api' ? await s.load(shared[5]) : null;
    const values = [vars.map((key) => key === 'promptText' ? prompt?.defaultPrompt : s.config.VARS?.[key]), fields.map(([obj, key]) => s.config[obj]?.[key])];
    if (path === '/') values.push(prompt?.defaultPrompt?.split('\n').slice(0, 16).join('\n'), faq?.homeFaq, ['register', 'accept', 'send'].map((key) => snippets?.snippets?.[key]), snippets?.heroCopyLine, connect?.cards?.map(({ id, mark, name, sub, quick }) => ({ id, mark, name, sub, quick })));
    if (path === '/connect') values.push(prompt?.defaultPrompt, connect?.cards, connect?.oneLiner);
    if (path === '/docs/api') values.push(api?.groups, api?.errorTable, api?.authLabel, api?.groups?.flatMap((group) => group.endpoints.map((endpoint) => api.curlFor(endpoint))));
    return JSON.stringify(values);
  });
  xml = xml.replace(match[0], match[0].replace(`<lastmod>${match[2]}</lastmod>`, `<lastmod>${[match[2], contentDate, sharedDate].sort().at(-1)}</lastmod>`));
}
writeFileSync(sitemap, xml);
