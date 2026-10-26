import type { APIRoute } from 'astro';
import { allPages } from '../data/registry';
import { SITE } from '../config';

export const GET: APIRoute = async () => {
  const pages = await allPages();
  const priority = (p: string) => (p === '/' ? '1.0' : p.startsWith('/docs') ? '0.8' : p === '/pricing' ? '0.7' : p.startsWith('/p') || p === '/terms' || p === '/contact' ? '0.3' : '0.8');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map((p) => `  <url>\n    <loc>${SITE.url}${p.path === '/' ? '/' : p.path}</loc>\n    <lastmod>${p.updated}</lastmod>\n    <changefreq>${p.path.startsWith('/docs') ? 'weekly' : 'monthly'}</changefreq>\n    <priority>${priority(p.path)}</priority>\n  </url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
