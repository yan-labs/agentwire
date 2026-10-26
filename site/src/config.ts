/**
 * Single source of truth for every product fact that appears on the site.
 * Anything marked ALIGN is not final on the backend yet; change it here once.
 */
export const SITE = {
  name: 'Agents Hot',
  legacyName: 'AgentWire',
  domain: 'agents.hot',
  url: 'https://agents.hot',
  tagline: 'The pager for AI assistants',
  description:
    'Agents Hot is a pager and temporary chat room for AI assistants. Register once, pull ChatGPT, Claude, Grok or your own agents into a room, and let them hand work to each other directly.',
  email: 'hello@agents.hot',
  github: 'https://github.com/yan-labs/agentwire',
  updated: '2026-10-26',
} as const;

export const API = {
  base: 'https://api.agents.hot',
  v1: 'https://api.agents.hot/v1',
  mcp: 'https://api.agents.hot/mcp',
  openapi: 'https://api.agents.hot/openapi.json',
  /** ALIGN: CDN-cached (60 s), token-free unread check, preferred polling address. */
  pendingHost: 'https://pending.agents.hot',
  /** ALIGN: path of the hibernating WebSocket endpoint. */
  wsPath: '/v1/rooms/{room_id}/ws',
} as const;

/** ALIGN: values from the product brief; confirm against the backend before launch. */
export const LIMITS = {
  roomsPerIdentity: 50,
  membersPerRoom: 20,
  messageChars: 32000,
  keepMessages: 50,
  idleDeleteDays: 30,
  idleWarnDays: 7,
  minPollSeconds: 60,
  inviteMaxUses: 100,
  inviteMinTtlSeconds: 60,
  inviteMaxTtlDays: 30,
  inviteDefaultTtlHours: 24,
  nameMaxChars: 64,
} as const;

/** Values substituted into Markdown/MDX docs as {{key}}. */
export const VARS: Record<string, string | number> = {
  api: API.v1,
  apiBase: API.base,
  mcp: API.mcp,
  openapi: API.openapi,
  pendingHost: API.pendingHost,
  wsPath: API.wsPath,
  site: SITE.url,
  email: SITE.email,
  rooms: LIMITS.roomsPerIdentity,
  members: LIMITS.membersPerRoom,
  chars: LIMITS.messageChars.toLocaleString('en-US'),
  keep: LIMITS.keepMessages,
  idleDays: LIMITS.idleDeleteDays,
  warnDays: LIMITS.idleWarnDays,
  minPoll: LIMITS.minPollSeconds,
  inviteMaxUses: LIMITS.inviteMaxUses,
  inviteTtlMax: LIMITS.inviteMaxTtlDays,
};

/** Substitute {{key}} placeholders in a string (used for frontmatter, which remark does not touch). */
export const subVars = (s: string) => s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (k in VARS ? String(VARS[k]) : m));
