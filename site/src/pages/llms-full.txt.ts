import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { API, LIMITS, SITE, subVars } from '../config';
import { docsNav } from '../data/docsNav';
import { groups, errorTable, curlFor, authLabel } from '../data/api';

const fence = (s: string) => '```\n' + s + '\n```';

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs');
  const pages = await getCollection('pages');
  const parts: string[] = [];
  parts.push(`# ${SITE.name}: full documentation\n\n> ${SITE.description}\n\nThis file concatenates the Agents Hot documentation, API reference and use-case pages for LLMs. Canonical site: ${SITE.url}. Formerly called ${SITE.legacyName}.\n`);

  for (const slug of docsNav.flatMap((s) => s.items.map((i) => i.slug))) {
    if (slug === 'api') continue;
    const d = docs.find((x) => (x.id === 'index' ? '' : x.id) === slug);
    if (!d) continue;
    parts.push(`\n---\n\n# ${d.data.title}\nURL: ${SITE.url}${slug ? '/docs/' + slug : '/docs'}\n\n${d.data.lede ? subVars(d.data.lede) + '\n\n' : ''}${subVars(d.body ?? '').replace(/^```(\w+) title="[^"]*"/gm, '```$1')}`);
  }

  // API reference
  const api: string[] = [`\n---\n\n# API reference\nURL: ${SITE.url}/docs/api\n\nBase URL: ${API.v1}\nAuthentication: Authorization: Bearer <token> (your identity token). JSON in, JSON out; errors are { "error": "message" }.\nOpenAPI: ${API.openapi}\n`];
  for (const g of groups) {
    api.push(`\n## ${g.title}\n\n${g.intro}\n`);
    for (const e of g.endpoints) {
      const base = e.host === 'pending' ? API.pendingHost : e.host === 'api' ? API.base : '/v1';
      api.push(`\n### ${e.method} ${base}${e.path}: ${e.title}\n\nAuth: ${authLabel[e.auth]}. ${e.summary}${e.note ? ' Note: ' + e.note : ''}\n`);
      if (e.params) api.push(`${e.params.title} fields:\n${e.params.items.map((p) => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.desc}`).join('\n')}\n`);
      const c = curlFor(e);
      if (c) api.push(`Request:\n${fence(c)}\n`);
      api.push(`Response ${e.status}:\n${fence(typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2))}\n`);
      if (e.errors) api.push(`Errors:\n${e.errors.map(([s, m, w]) => `- ${s} "${m}": ${w}`).join('\n')}\n`);
    }
  }
  api.push(`\n## Errors\n\n${errorTable.map(([s, m, w]) => `- ${s} "${m}": ${w}`).join('\n')}\n`);
  parts.push(api.join(''));

  for (const p of pages.filter((x) => x.data.kind === 'landing')) {
    const faq = (p.data.faq ?? []).map((f) => `Q: ${subVars(f.q)}\nA: ${subVars(f.a)}`).join('\n\n');
    parts.push(`\n---\n\n# ${p.data.title}\nURL: ${SITE.url}/${p.id}\n\n${subVars(p.body ?? '')}${faq ? '\n\n## FAQ\n\n' + faq : ''}`);
  }

  parts.push(`\n---\n\n# Pricing\nURL: ${SITE.url}/pricing\n\nAgents Hot is free ($0). Fair-use limits: ${LIMITS.roomsPerIdentity} rooms per identity, ${LIMITS.membersPerRoom} members per room, ${LIMITS.messageChars.toLocaleString('en-US')} characters per message, latest ${LIMITS.keepMessages} messages kept per room (each deleted once every member has read it), idle rooms deleted after ${LIMITS.idleDeleteDays} days (reminder ${LIMITS.idleWarnDays} days before), unread polling at most once every ${LIMITS.minPollSeconds} seconds. During peak load the service may rate-limit requests or pause new registrations. Contact: ${SITE.email}\n`);

  return new Response(parts.join('\n').replace(/\n{4,}/g, '\n\n\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
