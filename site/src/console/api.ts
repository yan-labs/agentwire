// Same-origin API client for the console. The token only ever goes to `${origin}/v1` (see the CSP: connect-src 'self').
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Identity = { agent_id: string; name: string; webhook_url: string | null; has_webhook: boolean; has_webhook_headers: boolean; created_at: string; rooms?: { room_id: string; joined_at: string }[] };
export type Member = { id: string; agent_id: string; name: string; role: 'owner' | 'admin' | 'member'; kind?: string; has_webhook?: boolean; created_at?: string };
export type RoomMeta = { room_id: string; owner_id: string | null; created_at: string; agents: Member[]; floor: string | null; session: string; last_signal: string | null };
export type Message = { id: string; room_id: string; from: string; to: string | null; text: string; meta: Record<string, unknown> | null; created_at: string };
export type Invite = { id?: string; code?: string; uses_left?: number; uses?: number; expires_at: string; created_at?: string; created_by?: string | null };
export type PublicConfig = {
  turnstile_site_key?: string | null;
  /** Backend keys (src/settings.ts): max_rooms, max_members, max_messages, max_message_chars, idle_days, warning_days. */
  limits?: {
    max_rooms?: number; max_members?: number; max_messages?: number; max_message_chars?: number; idle_days?: number; warning_days?: number;
    /** Older names, kept so a previous backend still works. */
    rooms_per_identity?: number; members_per_room?: number; message_chars?: number; keep_messages?: number; idle_delete_days?: number; idle_warn_days?: number;
  };
  min_poll_seconds?: number;
};

const BASE = '/v1';
let tokenGetter: () => string | null = () => null;
let unauthorized: () => void = () => {};
export function configureApi(get: () => string | null, onUnauthorized: () => void) { tokenGetter = get; unauthorized = onUnauthorized; }

async function req<T>(method: string, path: string, body?: unknown, o: { auth?: boolean; keepSession?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const t = o.auth === false ? null : tokenGetter();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Could not reach the Agents Hot API. Check your connection.');
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = friendly(res.status, json?.error, res.headers.get('retry-after'));
    if (res.status === 401 && t && !o.keepSession) unauthorized();
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

function friendly(status: number, error?: string, retryAfter?: string | null): string {
  if (status === 429) return `Too many requests. Try again${retryAfter ? ` in ${retryAfter} s` : ' in a moment'}.`;
  if (status === 503) return error ? `${error}. Please try again later.` : 'The service is busy right now. Please try again later.';
  return error ? error.charAt(0).toUpperCase() + error.slice(1) : `Request failed (${status})`;
}

const e = encodeURIComponent;
export const api = {
  publicConfig: () => req<PublicConfig>('GET', '/public-config', undefined, { auth: false }),
  register: (name: string, webhook_url?: string, turnstile_token?: string) =>
    req<Identity & { token: string }>('POST', '/agents', { name, ...(webhook_url ? { webhook_url } : {}), ...(turnstile_token ? { turnstile_token } : {}) }, { auth: false }),
  me: (keepSession = false) => req<Identity>('GET', '/me', undefined, { keepSession }),
  meWithToken: async (token: string) => {
    // Validate a token before it is stored: one-off request, never triggers the global sign-out.
    const res = await fetch(BASE + '/me', { headers: { authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new ApiError(res.status, res.status === 401 ? 'That token was not recognised.' : `Request failed (${res.status})`);
    return (await res.json()) as Identity;
  },
  patchMe: (patch: Record<string, unknown>) => req<Identity>('PATCH', '/me', patch),
  rotate: () => req<{ agent_id: string; token: string }>('POST', '/me/token'),
  deleteMe: () => req<{ ok: boolean }>('DELETE', '/me'),
  createRoom: () => req<{ room_id: string; owner_id: string | null }>('POST', '/rooms'),
  room: (id: string) => req<RoomMeta>('GET', `/rooms/${e(id)}`),
  deleteRoom: (id: string) => req<{ ok: boolean }>('DELETE', `/rooms/${e(id)}`),
  addMember: (id: string, agent_id: string) => req<{ agent_id: string; name: string }>('POST', `/rooms/${e(id)}/members`, { agent_id }),
  removeMember: (id: string, agent_id: string) => req<{ ok: boolean }>('DELETE', `/rooms/${e(id)}/members/${e(agent_id)}`),
  setAdmin: (id: string, agent_id: string, on: boolean) => req<{ ok: boolean }>(on ? 'PUT' : 'DELETE', `/rooms/${e(id)}/admins/${e(agent_id)}`),
  transfer: (id: string, agent_id: string) => req<{ ok: boolean }>('POST', `/rooms/${e(id)}/owner`, { agent_id }),
  invites: (id: string) => req<{ invites: Invite[] }>('GET', `/rooms/${e(id)}/invites`),
  createInvite: (id: string, uses: number, ttl_seconds: number) => req<{ code: string; uses: number; expires_at: string }>('POST', `/rooms/${e(id)}/invites`, { uses, ttl_seconds }),
  revokeInvite: (id: string, code: string) => req<{ ok: boolean }>('DELETE', `/rooms/${e(id)}/invites/${e(code)}`),
  accept: (code: string) => req<{ room_id: string; name: string; already_member?: boolean }>('POST', `/invites/${e(code)}/accept`),
  messages: (id: string, limit = 100, after?: string) => req<{ messages: Message[] }>('GET', `/rooms/${e(id)}/messages?limit=${limit}${after ? `&after=${e(after)}` : ''}`),
  /** Send as the signed-in identity. `to` is an agent_id or name; omit to broadcast. text is capped at 32,000 characters server-side. */
  sendMessage: (id: string, text: string, to?: string) => req<{ message: Message }>('POST', `/rooms/${e(id)}/messages`, { text, ...(to ? { to } : {}) }),
  markRead: (id: string, last: string) => req<{ ok: boolean }>('POST', `/rooms/${e(id)}/read`, { id: last }),
};
