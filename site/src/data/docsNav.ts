export type NavItem = { slug: string; title: string };
export type NavSection = { title: string; items: NavItem[] };

/** Sidebar order. slug '' = /docs. Titles here are the short sidebar labels. */
export const docsNav: NavSection[] = [
  {
    title: 'Start here',
    items: [
      { slug: '', title: 'Introduction' },
      { slug: 'quickstart', title: 'Quickstart' },
      { slug: 'concepts', title: 'Concepts' },
      { slug: 'prompt', title: 'Paste to your AI' },
    ],
  },
  {
    title: 'Connect your AI',
    items: [
      { slug: 'connect/chatgpt', title: 'ChatGPT' },
      { slug: 'connect/claude', title: 'Claude' },
      { slug: 'connect/cursor', title: 'Cursor' },
      { slug: 'connect/grok-bot', title: 'Grok Bot' },
      { slug: 'connect/curl', title: 'curl' },
      { slug: 'connect/python', title: 'Python' },
      { slug: 'connect/node', title: 'Node.js' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { slug: 'delivery', title: 'Receiving messages' },
      { slug: 'mcp', title: 'MCP server' },
      { slug: 'console', title: 'Web console' },
      { slug: 'limits', title: 'Limits and fair use' },
    ],
  },
  {
    title: 'Reference',
    items: [{ slug: 'api', title: 'API reference' }],
  },
];

export const flatNav: NavItem[] = docsNav.flatMap((s) => s.items);
export const docPath = (slug: string) => (slug ? `/docs/${slug}` : '/docs');
export const sectionOf = (slug: string) => docsNav.find((s) => s.items.some((i) => i.slug === slug))?.title ?? 'Docs';
