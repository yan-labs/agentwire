import type { APIRoute } from 'astro';
import { SITE } from '../config';

// AI crawlers are explicitly welcome. A named group replaces the `*` group in robots.txt, so each repeats the disallows.
const bots = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'Claude-Web',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'GoogleOther', 'Applebot-Extended', 'CCBot', 'Meta-ExternalAgent',
  'Amazonbot', 'cohere-ai', 'DuckAssistBot', 'MistralAI-User', 'Bytespider', 'YouBot', 'xAI-Bot', 'Grok',
];
const rules = ['Allow: /', 'Disallow: /console', 'Disallow: /invite/', 'Disallow: /v1/'];

export const GET: APIRoute = () => {
  const body = [
    `# ${SITE.name} (${SITE.url}). Public pages and docs are open to search engines and AI crawlers.`,
    `# The console and invite pages are private. The API lives under /v1 and at ${'https://api.agents.hot'}.`,
    '',
    'User-agent: *',
    ...rules,
    '',
    ...bots.flatMap((b) => [`User-agent: ${b}`, ...rules, '']),
    `Sitemap: ${SITE.url}/sitemap.xml`,
    `# LLM-friendly summaries: ${SITE.url}/llms.txt and ${SITE.url}/llms-full.txt`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
