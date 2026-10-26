/**
 * Single source of truth for every product fact that appears on the site.
 * Integration contract: see site/README.md for the verified backend shapes.
 */
export const SITE = {
  name: 'Agents Hot',
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
  /** CDN-cached per-room boolean feed; no message metadata. */
  pendingHost: 'https://pending.agents.hot',
  pendingPath: '/{room_id}/{agent_id}.json',
  pendingFields: ['has_new'],
  webhookHeaders: ['x-agents-hot-room', 'x-agents-hot-from'],
  mcpTools: ['me', 'rooms', 'read_messages', 'send_message', 'pending', 'create_room', 'create_invite', 'accept_invite'],
  /** Hibernating WebSocket endpoint, including send/read/ack commands. */
  wsPath: '/v1/rooms/{room_id}/ws',
} as const;

/** Defaults shared with src/settings.ts; operator configuration can lower capacity. */
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
