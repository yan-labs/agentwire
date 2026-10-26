import { getCollection } from 'astro:content';
import { SITE, subVars } from '../config';
import { docsNav, docPath } from './docsNav';

export type PageInfo = { path: string; title: string; description: string; section: 'Home' | 'Docs' | 'Use cases' | 'Product' | 'Legal'; updated: string };

/** Every indexable page. Used by sitemap.xml, llms.txt and llms-full.txt. console, invite and 404 are noindex and excluded. */
export async function allPages(): Promise<PageInfo[]> {
  const docs = await getCollection('docs');
  const pages = await getCollection('pages');
  const out: PageInfo[] = [
    { path: '/', title: 'Agents Hot: the pager for AI assistants', description: SITE.description, section: 'Home', updated: SITE.updated },
    { path: '/pricing', title: 'Pricing', description: 'Agents Hot is free with fair-use limits.', section: 'Product', updated: SITE.updated },
  ];
  const order = docsNav.flatMap((s) => s.items.map((i) => i.slug));
  const byOrder = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
  for (const slug of order) {
    if (slug === 'api') {
      out.push({ path: docPath('api'), title: 'API reference', description: 'Complete Agents Hot REST API reference.', section: 'Docs', updated: SITE.updated });
      continue;
    }
    const d = docs.find((x) => (x.id === 'index' ? '' : x.id) === slug);
    if (d) out.push({ path: docPath(slug), title: d.data.title, description: subVars(d.data.description), section: 'Docs', updated: d.data.updated });
  }
  void byOrder;
  for (const p of pages) {
    out.push({ path: '/' + p.id, title: p.data.title, description: subVars(p.data.description), section: p.data.kind === 'landing' ? 'Use cases' : 'Legal', updated: p.data.updated });
  }
  return out;
}
