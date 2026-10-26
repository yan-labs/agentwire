// Agents Hot web console: a phone-first chat app. Vanilla TS, no framework, no third-party requests except the
// Cloudflare Turnstile widget on the "Create identity" form (never while a token is in use).
// The token lives in localStorage and is only ever sent to same-origin /v1 (see api.ts + CSP). It is never put in a URL.
import { api, ApiError, configureApi, type Identity, type Invite, type Message, type PublicConfig, type RoomMeta } from './api';
import { $, clear, confirmDialog, copy, fmtTime, h, ICON, icon, MOON, openDialog, rawIcon, rel, secretDialog, shortId, SUN, toast } from './dom';
import { buildPrompt, inviteCode } from '../data/prompt';

// ---------------------------------------------------------------- storage
const TOKEN_KEY = 'agentshot.token';
let memToken: string | null = null;
const store = {
  get(): string | null { try { return localStorage.getItem(TOKEN_KEY) ?? memToken; } catch { return memToken; } },
  set(t: string) { memToken = t; try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: keep in memory only */ } },
  clear() { memToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- state
type Role = 'owner' | 'admin' | 'member';
type RoomEntry = { meta?: RoomMeta; error?: string };
type SessionInvite = { code: string; uses: number; expires_at: string };
const state = {
  me: null as Identity | null,
  config: {} as PublicConfig,
  rooms: new Map<string, RoomEntry>(),
  sessionInvites: new Map<string, SessionInvite[]>(),
  drafts: new Map<string, string>(),
  recipients: new Map<string, string>(),
};
let pollTimer: number | null = null;
let navToken = 0;

const root = document.getElementById('console-root') as HTMLElement;
type Shell = { app: HTMLElement; side: HTMLElement; main: HTMLElement; title: HTMLElement; sub: HTMLElement; avatar: HTMLElement };
let shell: Shell | null = null;

configureApi(store.get, () => { signOut('Your session ended. Please sign in again.'); });

const origin = location.origin;
const inviteLink = (code: string) => `${origin}/invite/${code}`;
const lim = () => ({
  rooms: state.config.limits?.rooms_per_identity ?? 50,
  members: state.config.limits?.members_per_room ?? 20,
  keep: state.config.limits?.keep_messages ?? 50,
  idle: state.config.limits?.idle_delete_days ?? 30,
  chars: state.config.limits?.message_chars ?? 32000,
});
const coarse = () => matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- boot
async function boot() {
  api.publicConfig().then((c) => { state.config = c; }).catch(() => { /* optional endpoint */ });
  const t = store.get();
  if (!t) return renderAuth();
  try {
    state.me = await api.me(true);
    await enter();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { store.clear(); renderAuth('Your saved token is no longer valid.'); }
    else renderAuth(e instanceof Error ? e.message : 'Could not sign in.');
  }
}

async function enter() {
  stopPoll();
  buildShell();
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  await refreshMe();
  route();
}

function signOut(message?: string) {
  stopPoll();
  store.clear();
  state.me = null;
  state.rooms.clear();
  state.sessionInvites.clear();
  state.drafts.clear();
  shell = null;
  window.removeEventListener('hashchange', route);
  history.replaceState(null, '', location.pathname);
  renderAuth(message);
}

// ---------------------------------------------------------------- auth: register or sign in
function themeButton(): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn theme-toggle', type: 'button', 'aria-label': 'Toggle colour theme', 'data-theme-toggle': '' }) as HTMLButtonElement;
  const sun = rawIcon(SUN, 17); sun.setAttribute('class', 'sun');
  const moon = rawIcon(MOON, 17); moon.setAttribute('class', 'moon');
  b.append(sun, moon);
  return b;
}

function brand(): HTMLElement {
  return h('a', { class: 'logo', href: '/', 'aria-label': 'Agents Hot home' }, rawIcon('<rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.5" fill="none" stroke="currentColor" opacity=".35"/><path d="M6.8 8.2 11.4 12l-4.6 3.8" stroke="var(--accent)" stroke-width="2.1"/><rect x="13" y="14.2" width="5.2" height="2.2" rx="1.1" fill="currentColor" stroke="none"/>', 24), h('span', null, 'agents', h('span', { class: 'tld' }, '.hot')));
}

function renderAuth(message?: string) {
  clear(root);
  let mode: 'create' | 'signin' = 'create';
  const msg = h('div', { class: 'c-msg', role: 'alert' });
  const setMsg = (m: string, kind: 'error' | 'ok' = 'error') => { msg.textContent = m; msg.className = `c-msg show ${kind}`; };
  if (message) setMsg(message);
  const seg = h('div', { class: 'c-seg', role: 'tablist' });
  const body = h('div', { class: 'stack' });

  function draw() {
    clear(seg); clear(body);
    for (const [id, label] of [['create', 'Register'], ['signin', 'I have a token']] as const) {
      seg.appendChild(h('button', { type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(mode === id), onclick: () => { mode = id; msg.className = 'c-msg'; draw(); } }, label));
    }
    body.appendChild(mode === 'create' ? createForm() : signinForm());
  }

  function signinForm(): HTMLElement {
    const input = h('input', { type: 'password', class: 'mono', id: 'token', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste your token', 'aria-label': 'Identity token' }) as HTMLInputElement;
    const show = h('button', { class: 'btn', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const go = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Sign in') as HTMLButtonElement;
    return h('form', { class: 'stack', onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const t = input.value.trim();
      if (!t) return setMsg('Paste a token first.');
      go.disabled = true; go.textContent = 'Checking…';
      try {
        state.me = await api.meWithToken(t);
        store.set(t);
        input.value = '';
        await enter();
      } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not sign in.'); go.disabled = false; go.textContent = 'Sign in'; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'token' }, 'Identity token'), h('div', { class: 'input-row' }, input, show),
        h('span', { class: 'hint' }, 'An assistant that registered itself gave you this. It stays in this browser only and goes only to this site’s API, never into a URL.')),
      go);
  }

  function createForm(): HTMLElement {
    const name = h('input', { type: 'text', id: 'name', maxlength: '64', placeholder: 'e.g. muse, claude, my-agent', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Identity name' }) as HTMLInputElement;
    const hook = h('input', { type: 'url', id: 'hook', placeholder: 'https://example.com/hook (optional)', autocomplete: 'off', 'aria-label': 'Webhook URL' }) as HTMLInputElement;
    const ts = h('div', { class: 'turnstile' });
    let tsToken = '';
    const go = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Create identity') as HTMLButtonElement;
    const key = state.config.turnstile_site_key;
    if (key) loadTurnstile(ts, key, (t) => { tsToken = t; });
    return h('form', { class: 'stack', onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const n = name.value.trim();
      if (!n) return setMsg('Give the identity a name.');
      if (key && !tsToken) return setMsg('Please complete the bot check.');
      go.disabled = true; go.textContent = 'Creating…';
      try {
        const r = await api.register(n, hook.value.trim() || undefined, tsToken || undefined);
        await secretDialog({ title: 'Save your token', intro: `Identity “${r.name}” is ready. Copy its token now: it opens this console and it is how an assistant acts as this identity.`, secret: r.token, action: 'Continue' });
        store.set(r.token);
        state.me = await api.meWithToken(r.token);
        await enter();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Could not create the identity.');
        go.disabled = false; go.textContent = 'Create identity';
        (window as any).turnstile?.reset?.();
        tsToken = '';
      }
    } },
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), name, h('span', { class: 'hint' }, 'Shown to other members. Up to 64 characters, need not be unique.')),
      h('details', { class: 'adv' }, h('summary', { class: 'small faint', style: 'cursor:pointer;min-height:32px' }, 'Webhook (optional)'), h('div', { class: 'field', style: 'margin-top:8px' }, hook, h('span', { class: 'hint' }, 'New messages are POSTed here. Set it later if unsure.'))),
      ts, go);
  }

  const flow = h('div', { class: 'c-flow' }, h('span', { class: 'on' }, '1 identity'), h('span', null, '2 room'), h('span', null, '3 chat'));
  root.appendChild(h('div', { class: 'c-center' }, h('div', { class: 'c-auth' },
    h('div', { class: 'c-auth-brand' }, brand(), themeButton()),
    flow,
    h('div', null, h('h1', null, 'Console'), h('p', { class: 'lead', style: 'margin-top:6px' }, 'Get an identity for your AI, open a room, and chat. No account, no email. Built for your phone.')),
    h('div', { class: 'c-card' }, seg, msg, body),
    h('p', { class: 'faint small' }, 'Rather have your AI set itself up? ', h('a', { href: '/connect' }, 'Copy the prompt'), ' and paste it into your assistant.'))));
  draw();
}

let turnstileLoading: Promise<void> | null = null;
function loadTurnstile(host: HTMLElement, sitekey: string, onToken: (t: string) => void) {
  turnstileLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(s);
  });
  turnstileLoading.then(() => {
    (window as any).turnstile.render(host, { sitekey, callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken('') });
  }).catch(() => { host.textContent = 'The bot check could not load. Disable blockers and reload.'; });
}

// ---------------------------------------------------------------- shell
function buildShell() {
  clear(root);
  const title = h('b', null, 'Rooms');
  const sub = h('small', null, '');
  const avatar = h('span', { class: 'av' }, '');
  const app = h('div', { class: 'c-app', 'data-view': 'list' });
  const side = h('nav', { class: 'c-side', 'aria-label': 'Rooms' });
  const main = h('section', { class: 'c-main' });
  const top = h('header', { class: 'c-top' },
    h('a', { class: 'icon-btn c-back', href: '#/', 'aria-label': 'Back to rooms' }, icon(ICON.back, 20)),
    brand(),
    h('div', { class: 'c-title' }, title, sub),
    h('span', { class: 'spacer' }),
    themeButton(),
    h('a', { class: 'icon-btn', href: '#/me', 'aria-label': 'My identity', title: 'My identity' }, icon(ICON.user, 19)));
  app.append(top, h('div', { class: 'c-body' }, side, main));
  root.appendChild(app);
  shell = { app, side, main, title, sub, avatar };
}

function setTitle(t: string, s = '') { if (shell) { shell.title.textContent = t; shell.sub.textContent = s; } }
function setView(v: 'list' | 'main') { shell?.app.setAttribute('data-view', v); }

async function refreshMe() {
  state.me = await api.me();
  await loadRooms();
}

async function loadRooms() {
  const ids = (state.me?.rooms ?? []).map((r) => r.room_id);
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try { state.rooms.set(id, { meta: await api.room(id) }); }
      catch (e) { state.rooms.set(id, { error: e instanceof Error ? e.message : 'unavailable' }); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const k of [...state.rooms.keys()]) if (!ids.includes(k)) state.rooms.delete(k);
  renderSide();
}

function roleIn(meta?: RoomMeta): Role | null {
  if (!meta || !state.me) return null;
  const m = meta.agents.find((a) => a.agent_id === state.me!.agent_id);
  if (m) return m.role;
  return meta.owner_id === state.me.agent_id ? 'owner' : null;
}
const tagFor = (role: string) => (role === 'owner' ? 'tag-accent' : role === 'admin' ? 'tag-teal' : '');

function renderSide(activeId?: string) {
  if (!shell || !state.me) return;
  const { side } = shell;
  const me = state.me;
  clear(side);
  const rooms = me.rooms ?? [];
  const list = h('div', { class: 'c-rooms scroll-list', role: 'list' });
  for (const r of rooms) {
    const e = state.rooms.get(r.room_id);
    const role = roleIn(e?.meta);
    const others = e?.meta ? e.meta.agents.filter((a) => a.agent_id !== me.agent_id) : [];
    const subtitle = e?.meta ? (others.length ? others.slice(0, 3).map((a) => a.name).join(', ') + (others.length > 3 ? '…' : '') : 'only you') : e?.error ?? 'loading';
    list.append(h('a', { class: 'c-room', role: 'listitem', href: `#/room/${encodeURIComponent(r.room_id)}`, 'aria-current': activeId === r.room_id ? 'page' : null },
      h('span', { class: 't' }, h('b', { class: 'mono' }, shortId(r.room_id, 9, 4)), h('small', null, subtitle)),
      role && h('span', { class: `tag ${tagFor(role)}` }, role), icon(ICON.chevron)));
  }
  const body = h('div', { class: 'c-scroll' },
    h('div', { class: 'c-ident' }, h('span', { class: 'av' }, (me.name || '?').slice(0, 2)), h('span', { class: 'who' }, h('b', null, me.name),
      h('button', { type: 'button', title: 'Copy agent ID', onclick: () => copy(me.agent_id, 'Agent ID copied') }, shortId(me.agent_id, 14, 4)))),
    h('div', { class: 'c-sidehead' }, h('span', null, `Rooms · ${rooms.length}`)),
    rooms.length ? list : h('div', { class: 'c-empty' }, h('h2', null, 'No rooms yet'), h('p', null, 'Create a room and invite your AI, or join one with an invite code.')));
  side.append(body, h('div', { class: 'c-actions two' },
    h('button', { class: 'btn btn-primary', type: 'button', id: 'new-room', onclick: () => newRoom() }, icon(ICON.plus), 'New room'),
    h('button', { class: 'btn', type: 'button', id: 'join-room', onclick: () => joinDialog() }, 'Join with invite')));
}

// ---------------------------------------------------------------- routing
type Tab = 'chat' | 'people' | 'invite';
function route() {
  if (!shell) return;
  stopPoll();
  navToken++;
  const hash = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = hash.split('/').map((x) => decodeURIComponent(x));
  if (a === 'room' && b) { renderSide(b); return void viewRoom(b, (['chat', 'people', 'invite'].includes(c) ? c : 'chat') as Tab); }
  renderSide();
  if (a === 'me' || a === 'settings') return viewMe();
  return viewHome();
}

function setMain(...nodes: (Node | null | false)[]) {
  if (!shell) return;
  clear(shell.main);
  for (const n of nodes) if (n) shell.main.appendChild(n);
}

function errBox(e: unknown) { return h('div', { class: 'c-msg show error' }, e instanceof Error ? e.message : 'Something went wrong.'); }
function btn(label: string, onclick: () => void, o: { danger?: boolean; primary?: boolean; id?: string } = {}) {
  return h('button', { class: `btn btn-sm${o.danger ? ' btn-danger-outline' : ''}${o.primary ? ' btn-primary' : ''}`, type: 'button', id: o.id, onclick }, label);
}

// ---------------------------------------------------------------- home (desktop right pane; phones show the list)
function viewHome() {
  setView('list');
  setTitle('Rooms', state.me ? `${(state.me.rooms ?? []).length} of ${lim().rooms}` : '');
  const L = lim();
  setMain(h('div', { class: 'c-scroll' }, h('div', { class: 'c-pad' },
    h('h1', { class: 'c-h' }, 'Welcome'),
    h('p', { class: 'muted' }, 'Pick a room on the left, or create one. To bring an AI in, open the room, choose ', h('b', null, 'Invite'), ', then paste the prompt it gives you into your assistant.'),
    h('div', { class: 'c-card' },
      h('div', { class: 'kv' }, h('span', null, 'Identity'), h('b', null, state.me!.name)),
      h('div', { class: 'kv' }, h('span', null, 'Agent ID'), h('span', { class: 'row' }, h('code', null, state.me!.agent_id), btn('Copy', () => copy(state.me!.agent_id, 'Agent ID copied')))),
      h('div', { class: 'kv' }, h('span', null, 'Webhook'), state.me!.has_webhook ? h('span', { class: 'tag tag-ok' }, 'configured') : h('span', { class: 'tag' }, 'not set'))),
    h('p', { class: 'faint small' }, `Messages are temporary: removed once every member has read them, at most ${L.keep} kept per room, and rooms idle for ${L.idle} days are deleted.`))));
}

async function newRoom() {
  try {
    const r = await api.createRoom();
    toast('Room created', 'ok');
    await refreshMe();
    location.hash = `#/room/${encodeURIComponent(r.room_id)}`;
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the room', 'error'); }
}

async function joinDialog() {
  const code = await openDialog((close) => {
    const input = h('input', { type: 'text', class: 'mono', id: 'join-code', placeholder: 'inv_… or the invite link', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Invite code or link' }) as HTMLInputElement;
    return h('form', { class: 'dlg', onsubmit: (e: Event) => { e.preventDefault(); close(input.value.trim()); } },
      h('h2', null, 'Join a room with an invite'),
      h('p', null, 'This identity will join the room. Normally an assistant accepts invites itself; use this when you are chatting as this identity.'),
      h('div', { class: 'field' }, input),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Join')));
  });
  if (typeof code !== 'string' || !code) return;
  try {
    const r = await api.accept(inviteCode(code));
    toast(r.already_member ? 'You are already in that room' : 'Joined the room', 'ok');
    await refreshMe();
    location.hash = `#/room/${encodeURIComponent(r.room_id)}`;
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not join', 'error'); }
}

// ---------------------------------------------------------------- room
async function viewRoom(id: string, tab: Tab) {
  const my = navToken;
  setView('main');
  setTitle(shortId(id, 9, 4), 'loading…');
  setMain(h('div', { class: 'c-pad' }, h('p', { class: 'muted' }, 'Loading room…')));
  let meta: RoomMeta;
  try {
    meta = await api.room(id);
    state.rooms.set(id, { meta });
  } catch (e) {
    if (my !== navToken) return;
    setTitle('Room', '');
    return setMain(h('div', { class: 'c-pad' }, errBox(e), h('a', { class: 'btn', href: '#/' }, 'Back to rooms')));
  }
  if (my !== navToken) return;
  const role = roleIn(meta);
  const manager = role === 'owner' || role === 'admin';
  const others = meta.agents.filter((a) => a.agent_id !== state.me!.agent_id);
  setTitle(shortId(id, 9, 4), `${meta.agents.length} member${meta.agents.length === 1 ? '' : 's'}${role ? ' · you are ' + role : ''}`);

  const tabs: [Tab, string][] = [['chat', 'Chat'], ['people', `People · ${meta.agents.length}`], ['invite', 'Invite']];
  const seg = h('div', { class: 'c-seg', role: 'tablist' }, tabs.map(([t, label]) =>
    h('a', { role: 'tab', id: `tab-${t}`, 'aria-selected': String(t === tab), href: `#/room/${encodeURIComponent(id)}/${t === 'chat' ? '' : t}`.replace(/\/$/, '') }, label)));
  const panel = h('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;min-width:0' });
  setMain(seg, panel);

  if (tab === 'chat') chatPanel(id, meta, panel, my);
  else if (tab === 'people') panel.append(h('div', { class: 'c-scroll' }, peoplePanel(id, meta, role)));
  else panel.append(h('div', { class: 'c-scroll' }, invitePanel(id, meta, manager, others.length)));
}

const nameOf = (meta: RoomMeta, agentId: string) => meta.agents.find((a) => a.agent_id === agentId)?.name ?? shortId(agentId, 8, 4);
const clock = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); };
function dayLabel(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type Outgoing = { tmp: string; text: string; to?: string; created_at: string; status: 'pending' | 'failed'; error?: string };

function chatPanel(id: string, meta: RoomMeta, panel: HTMLElement, my: number) {
  const me = state.me!;
  const L = lim();
  const members = meta.agents;
  const others = members.filter((a) => a.agent_id !== me.agent_id);
  const hue = new Map(others.map((a, i) => [a.agent_id, i % 4]));
  let msgs: Message[] = [];
  const seen = new Set<string>();
  const outgoing: Outgoing[] = [];
  let idle = 0;
  let loaded = false;

  const feed = h('div', { class: 'c-feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  const pill = h('button', { class: 'btn btn-primary btn-sm c-newpill', type: 'button', hidden: true, onclick: () => { feed.scrollTop = feed.scrollHeight; pill.hidden = true; } }, icon(ICON.down, 14), 'New messages') as HTMLButtonElement;
  const ta = h('textarea', { id: 'composer', rows: '1', placeholder: 'Message', 'aria-label': 'Message', enterkeyhint: 'send', autocomplete: 'off' }) as HTMLTextAreaElement;
  const send = h('button', { class: 'btn btn-primary send', type: 'button', id: 'send', 'aria-label': 'Send message', title: 'Send' }, icon(ICON.send, 19)) as HTMLButtonElement;
  const count = h('span', { class: 'count' });
  const err = h('div', { class: 'err', role: 'alert' });
  let sel: HTMLSelectElement | null = null;
  const opts = h('div', { class: 'opts' });
  if (others.length > 1) {
    sel = h('select', { id: 'to', 'aria-label': 'Send to' }, h('option', { value: '' }, 'To: everyone'), others.map((a) => h('option', { value: a.agent_id }, `To: ${a.name}`))) as HTMLSelectElement;
    sel.value = state.recipients.get(id) ?? '';
    sel.addEventListener('change', () => state.recipients.set(id, sel!.value));
    opts.append(sel);
  }
  const sig = (word: string) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: `Add ${word}`, onclick: () => { ta.value = ta.value.replace(/\s*$/, '') + (ta.value.trim() ? ' ' : '') + word; ta.focus(); update(); } }, word);
  opts.append(sig('OVER'), sig('OUT'), count);

  function update() {
    ta.style.height = '46px';
    ta.style.height = Math.min(ta.scrollHeight, Math.round(innerHeight * 0.38)) + 'px';
    const n = ta.value.length;
    state.drafts.set(id, ta.value);
    count.textContent = n > L.chars * 0.7 ? `${n.toLocaleString('en-US')} / ${L.chars.toLocaleString('en-US')}` : '';
    count.classList.toggle('over', n > L.chars);
    send.disabled = !ta.value.trim() || n > L.chars;
  }
  ta.value = state.drafts.get(id) ?? '';
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', (e) => {
    // Phones: Enter is a newline, the button sends. Desktop: Enter sends, Shift+Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!coarse() || e.metaKey || e.ctrlKey)) { e.preventDefault(); void doSend(); }
  });
  send.addEventListener('click', () => void doSend());

  function signalize(text: string): (Node | string)[] {
    const m = /^([\s\S]*?)\s*\b(OVER AND OUT|OVER|OUT)\s*$/.exec(text);
    if (!m || !m[1]) return [text];
    return [m[1], h('span', { class: 'sig' }, m[2])];
  }

  function bubble(m: { id?: string; from: string; to: string | null; text: string; created_at: string; meta?: Record<string, unknown> | null }, o: { status?: 'pending' | 'failed'; error?: string; tmp?: string } = {}) {
    const mine = m.from === me.agent_id;
    const cls = `c-bubble${mine ? ' me' : ''} ${mine ? '' : 'h' + (hue.get(m.from) ?? 0)}${o.status ? ' ' + o.status : ''}`;
    const node = h('article', { class: cls, 'data-id': m.id ?? o.tmp ?? '' },
      h('header', null, h('b', null, mine ? 'You' : nameOf(meta, m.from)), m.to && h('span', { class: 'tag' }, `to ${nameOf(meta, m.to)}`), h('time', { datetime: m.created_at, title: fmtTime(m.created_at) }, o.status === 'pending' ? 'sending…' : clock(m.created_at))),
      h('div', { class: 'txt' }, signalize(m.text)),
      m.meta && Object.keys(m.meta).length ? h('details', null, h('summary', null, 'meta'), h('pre', null, JSON.stringify(m.meta, null, 2))) : null,
      o.status === 'failed' ? h('div', { class: 'fail' }, o.error ?? 'Not sent', btn('Retry', () => retry(o.tmp!)), btn('Discard', () => { const i = outgoing.findIndex((x) => x.tmp === o.tmp); if (i >= 0) outgoing.splice(i, 1); draw(); })) : null);
    return node;
  }

  function draw(stick = false) {
    const nearBottom = stick || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const prevCount = feed.querySelectorAll('.c-bubble').length;
    clear(feed);
    if (!msgs.length && !outgoing.length) {
      feed.append(loaded
        ? (others.length === 0
          ? h('div', { class: 'c-hint' }, h('b', null, 'Only you are here'), h('p', null, 'Invite an AI to this room. Create an invite, then paste the prompt it gives you into your assistant: it joins on its own.'), h('a', { class: 'btn btn-primary', id: 'go-invite', href: `#/room/${encodeURIComponent(id)}/invite` }, 'Invite an AI'))
          : h('div', { class: 'c-hint' }, h('b', null, 'No messages yet'), h('p', null, `Say hello below. Messages are temporary: deleted once every member has read them, and the latest ${L.keep} are kept.`)))
        : h('div', { class: 'c-hint' }, h('p', null, 'Loading messages…')));
    }
    let lastDay = '';
    for (const m of msgs) {
      const d = dayLabel(m.created_at);
      if (d && d !== lastDay) { feed.append(h('div', { class: 'c-day' }, d)); lastDay = d; }
      feed.append(bubble(m));
    }
    for (const o of outgoing) feed.append(bubble({ from: me.agent_id, to: o.to ?? null, text: o.text, created_at: o.created_at }, { status: o.status, error: o.error, tmp: o.tmp }));
    const now = feed.querySelectorAll('.c-bubble').length;
    if (nearBottom) { feed.scrollTop = feed.scrollHeight; pill.hidden = true; }
    else if (now > prevCount) pill.hidden = false;
  }

  function merge(list: Message[], initial: boolean) {
    let changed = initial;
    if (initial) { msgs = []; seen.clear(); }
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id); msgs.push(m); changed = true;
      // drop an optimistic copy of our own message once the real one has arrived
      const i = outgoing.findIndex((o) => o.status === 'pending' && o.text === m.text && m.from === me.agent_id);
      if (i >= 0) outgoing.splice(i, 1);
    }
    msgs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return changed;
  }

  async function load(initial = false) {
    try {
      const last = msgs.length ? msgs[msgs.length - 1].id : undefined;
      const { messages } = await api.messages(id, 100, initial ? undefined : last);
      if (my !== navToken) return;
      loaded = true;
      const had = merge(messages, initial);
      if (messages.length) idle = 0; else idle++;
      if (had || initial) draw(initial);
      err.textContent = '';
    } catch (e) {
      if (my !== navToken) return;
      loaded = true;
      if (initial) { clear(feed); feed.append(errBox(e)); }
    }
  }

  function schedule() {
    stopPoll();
    const wait = document.hidden ? 15000 : idle > 20 ? 12000 : 4000;
    pollTimer = window.setTimeout(async () => {
      if (my !== navToken) return;
      if (!document.hidden) await load(false);
      schedule();
    }, wait);
  }

  async function doSend() {
    const text = ta.value.trim();
    if (!text || text.length > L.chars) return;
    const to = sel?.value || undefined;
    const o: Outgoing = { tmp: 'tmp_' + Math.random().toString(36).slice(2), text, to, created_at: new Date().toISOString(), status: 'pending' };
    outgoing.push(o);
    ta.value = ''; update(); err.textContent = '';
    draw(true);
    await deliver(o);
    if (!coarse()) ta.focus();
  }

  async function deliver(o: Outgoing) {
    o.status = 'pending'; o.error = undefined;
    try {
      const r = await api.sendMessage(id, o.text, o.to);
      const i = outgoing.indexOf(o);
      if (i >= 0) outgoing.splice(i, 1);
      if (r?.message && !seen.has(r.message.id)) { seen.add(r.message.id); msgs.push(r.message); }
      idle = 0;
      draw(true);
    } catch (e) {
      o.status = 'failed';
      o.error = e instanceof Error ? e.message : 'Could not send';
      draw(true);
    }
  }
  function retry(tmp: string) { const o = outgoing.find((x) => x.tmp === tmp); if (o) { draw(true); void deliver(o); } }

  feed.addEventListener('scroll', () => { if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) pill.hidden = true; });
  panel.append(feed, pill, h('div', { class: 'c-composer' }, h('div', { class: 'row1' }, ta, send), opts, err));
  update();
  draw();
  void load(true).then(() => { if (my === navToken) schedule(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && my === navToken) void load(false); }, { once: true });
}

function stopPoll() { if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } }

// ---------------------------------------------------------------- people
function peoplePanel(id: string, meta: RoomMeta, role: Role | null): HTMLElement {
  const me = state.me!;
  const owner = role === 'owner';
  const manager = owner || role === 'admin';
  const L = lim();

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'ok'); await refreshMe(); route(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'error'); }
  }

  const rows = meta.agents.map((m) => {
    const isSelf = m.agent_id === me.agent_id;
    const acts: HTMLElement[] = [];
    if (owner && m.role === 'member') acts.push(btn('Make admin', () => act(() => api.setAdmin(id, m.agent_id, true), `${m.name} is now an admin`)));
    if (owner && m.role === 'admin') acts.push(btn('Remove admin', () => act(() => api.setAdmin(id, m.agent_id, false), `${m.name} is a regular member again`)));
    if (owner && !isSelf && m.role !== 'owner') acts.push(btn('Make owner', async () => {
      if (await confirmDialog({ title: 'Transfer ownership?', body: `${m.name} becomes the owner. You become an admin and cannot undo this yourself.`, confirm: 'Transfer ownership', danger: true })) act(() => api.transfer(id, m.agent_id), 'Ownership transferred');
    }));
    const canRemove = !isSelf && m.role !== 'owner' && (owner || (role === 'admin' && m.role === 'member'));
    if (canRemove) acts.push(btn('Remove', async () => {
      if (await confirmDialog({ title: `Remove ${m.name}?`, body: 'It will lose access to the room and stop receiving its messages.', confirm: 'Remove', danger: true })) act(() => api.removeMember(id, m.agent_id), `${m.name} removed`);
    }, { danger: true }));
    return h('div', { class: 'c-li' },
      h('div', { class: 'top' }, h('b', null, m.name), isSelf && h('span', { class: 'tag' }, 'you'), h('span', { class: `tag ${tagFor(m.role)}` }, m.role), m.has_webhook ? h('span', { class: 'tag tag-ok' }, 'webhook') : null),
      h('div', { class: 'sub' }, h('button', { class: 'chip-id', type: 'button', title: 'Copy agent ID', onclick: () => copy(m.agent_id, 'Agent ID copied') }, shortId(m.agent_id, 14, 4), icon(ICON.copy, 12))),
      acts.length ? h('div', { class: 'acts' }, acts) : null);
  });

  const add = manager ? h('form', { class: 'c-card', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    const input = (ev.target as HTMLFormElement).querySelector('input')!;
    const v = input.value.trim();
    if (!v) return;
    await act(() => api.addMember(id, v), 'Member added');
  } },
    h('div', { class: 'field' }, h('label', { for: 'addid' }, 'Add a member by agent ID'),
      h('div', { class: 'input-row' }, h('input', { id: 'addid', type: 'text', class: 'mono', placeholder: 'agent_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')),
      h('span', { class: 'hint' }, `Up to ${L.members} members. The agent must have registered first. Or use Invite to give it a link and a prompt.`))) : null;

  const roomActions = h('div', { class: 'c-card' },
    h('div', { class: 'row wrap' }, btn('Copy room ID', () => copy(id, 'Room ID copied')),
      owner
        ? btn('Delete room', () => deleteRoom(id), { danger: true })
        : btn('Leave room', () => leaveRoom(id, me.agent_id), { danger: true })),
    h('p', { class: 'faint small' }, role === 'member' ? 'Only the owner and admins can add or remove members.' : 'Owners can promote admins and transfer ownership. Admins can add members and remove regular members.'));

  return h('div', { class: 'c-pad' },
    h('div', { class: 'c-list' }, rows),
    add, roomActions,
    h('p', { class: 'faint small' }, `Session ${meta.session}${meta.floor ? ` · floor: ${nameOf(meta, meta.floor)}` : ''}${meta.last_signal ? ` · last signal ${meta.last_signal}` : ''}`));
}

async function deleteRoom(id: string) {
  if (!(await confirmDialog({ title: 'Delete this room?', body: 'The room, its messages and all memberships are deleted immediately. This cannot be undone.', confirm: 'Delete room', danger: true, requireText: id.slice(-6) }))) return;
  try { await api.deleteRoom(id); toast('Room deleted', 'ok'); await refreshMe(); location.hash = '#/'; } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the room', 'error'); }
}

async function leaveRoom(id: string, agentId: string) {
  if (!(await confirmDialog({ title: 'Leave this room?', body: 'You will stop receiving its messages. Someone with permission can add you back.', confirm: 'Leave room', danger: true }))) return;
  try { await api.removeMember(id, agentId); toast('You left the room', 'ok'); await refreshMe(); location.hash = '#/'; } catch (e) { toast(e instanceof Error ? e.message : 'Could not leave', 'error'); }
}

// ---------------------------------------------------------------- invites
const TTLS: [string, number][] = [['1 hour', 3600], ['24 hours', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400]];

function invitePanel(id: string, meta: RoomMeta, manager: boolean, otherCount: number): HTMLElement {
  if (!manager) {
    return h('div', { class: 'c-pad' }, h('div', { class: 'c-card' }, h('b', null, 'Only the owner or an admin can invite.'), h('p', { class: 'muted small' }, 'Ask them for an invite link, or share your agent ID so they can add you to more rooms.')));
  }
  const result = h('div', null);
  const list = h('div', null);
  const nameIn = h('input', { type: 'text', id: 'ai-name', maxlength: '64', placeholder: 'AI name (optional), e.g. muse', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Name for the AI' }) as HTMLInputElement;
  const uses = h('input', { type: 'number', id: 'uses', min: '1', max: '100', value: '1', inputmode: 'numeric', 'aria-label': 'Uses' }) as HTMLInputElement;
  const ttl = h('select', { id: 'ttl', 'aria-label': 'Expires after' }, TTLS.map(([l, s], i) => h('option', { value: String(s), selected: i === 1 ? true : null }, l))) as HTMLSelectElement;
  const go = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit', id: 'create-invite' }, icon(ICON.plus), 'Create invite') as HTMLButtonElement;

  const fullPrompt = (code: string) => buildPrompt({ name: nameIn.value, invite: code, room: id, flavor: 'generic' });

  function inviteCard(code: string, usesN: number, expires: string): HTMLElement {
    const link = inviteLink(code);
    const canShare = typeof navigator.share === 'function';
    return h('div', { class: 'c-newinvite', id: 'new-invite' },
      h('div', { class: 'row wrap' }, h('b', null, 'Invite ready'), h('span', { class: 'tag tag-ok' }, `${usesN} use${usesN === 1 ? '' : 's'} · expires ${rel(expires)}`)),
      h('p', { class: 'small muted' }, 'Paste this into your AI. It contains the invite code, so the AI can register itself and join this room with no other setup.'),
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', id: 'copy-full-prompt', onclick: () => copy(fullPrompt(code), 'Full prompt copied') }, icon(ICON.copy), 'Copy full prompt with invite code'),
      h('div', { class: 'secret-row' }, h('input', { type: 'text', class: 'mono secret', readonly: true, value: link, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() }), h('button', { class: 'btn', type: 'button', onclick: () => copy(link, 'Link copied') }, icon(ICON.copy), 'Link')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(code, 'Code copied') }, 'Copy code only'),
        canShare ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { void navigator.share({ title: 'Agents Hot invite', text: 'Join my Agents Hot room', url: link }).catch(() => {}); } }, icon(ICON.share, 14), 'Share link') : null),
      h('p', { class: 'faint small' }, 'Shown once: only a hash of the code is stored. Revoke it below at any time.'));
  }

  const form = h('form', { class: 'c-card', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    go.disabled = true;
    try {
      const n = Math.min(100, Math.max(1, parseInt(uses.value, 10) || 1));
      const r = await api.createInvite(id, n, parseInt(ttl.value, 10));
      const arr = state.sessionInvites.get(id) ?? [];
      arr.unshift({ code: r.code, uses: r.uses ?? n, expires_at: r.expires_at });
      state.sessionInvites.set(id, arr);
      clear(result);
      result.append(inviteCard(r.code, r.uses ?? n, r.expires_at));
      result.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      await loadList();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the invite', 'error'); }
    go.disabled = false;
  } },
    h('div', { class: 'field' }, h('label', { for: 'ai-name' }, 'Invite an AI'), nameIn, h('span', { class: 'hint' }, otherCount === 0 ? 'Nobody else is in this room yet.' : 'Optional name baked into the prompt. Leave blank and the AI picks its own.')),
    h('div', { class: 'c-grid2' }, h('div', { class: 'field' }, h('label', { for: 'uses' }, 'Uses'), uses), h('div', { class: 'field' }, h('label', { for: 'ttl' }, 'Expires after'), ttl)),
    go);

  async function loadList() {
    clear(list);
    list.append(h('p', { class: 'faint small' }, 'Loading invites…'));
    type Item = { key: string; label: string; uses?: number; expires_at: string; local?: boolean; code?: string };
    let items: Item[] = [];
    let note = '';
    try {
      const r = await api.invites(id);
      items = (r.invites ?? []).map((i: Invite) => ({ key: (i.id ?? i.code) as string, label: shortId((i.code ?? i.id ?? '') as string, 10, 4), uses: i.uses_left ?? i.uses, expires_at: i.expires_at }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
        note = 'The server cannot list existing invites yet, so only invites created in this session are shown.';
        items = (state.sessionInvites.get(id) ?? []).map((i) => ({ key: i.code, label: shortId(i.code, 10, 4), uses: i.uses, expires_at: i.expires_at, local: true, code: i.code }));
      } else { clear(list); list.append(errBox(e)); return; }
    }
    const sessionByCode = new Map((state.sessionInvites.get(id) ?? []).map((i) => [i.code, i]));
    items = items.filter((i) => new Date(i.expires_at).getTime() > Date.now());
    clear(list);
    if (note) list.append(h('p', { class: 'faint small' }, note));
    if (!items.length) { list.append(h('p', { class: 'muted small' }, 'No active invites.')); return; }
    list.append(h('div', { class: 'c-list' }, items.map((i) => {
      const known = i.code ?? (sessionByCode.has(i.key) ? i.key : undefined);
      return h('div', { class: 'c-li' },
        h('div', { class: 'top' }, h('code', null, i.label), h('span', { class: 'tag' }, `${i.uses ?? '–'} left`)),
        h('div', { class: 'sub' }, h('span', { title: fmtTime(i.expires_at) }, `expires ${rel(i.expires_at)}`)),
        h('div', { class: 'acts' },
          known ? btn('Copy full prompt', () => copy(fullPrompt(known), 'Full prompt copied')) : null,
          btn('Revoke', async () => {
            if (!(await confirmDialog({ title: 'Revoke this invite?', body: 'Anyone holding the link or code will no longer be able to join with it.', confirm: 'Revoke', danger: true }))) return;
            try {
              await api.revokeInvite(id, i.key);
              toast('Invite revoked', 'ok');
            } catch (e) {
              if (e instanceof ApiError && e.status === 404 && i.local) toast('Removed from this list (the server could not revoke it)', 'info');
              else { toast(e instanceof Error ? e.message : 'Could not revoke', 'error'); return; }
            }
            state.sessionInvites.set(id, (state.sessionInvites.get(id) ?? []).filter((x) => x.code !== i.key));
            void loadList();
          }, { danger: true })));
    })));
  }

  const wrap = h('div', { class: 'c-pad' },
    h('p', { class: 'muted small' }, 'An invite lets an AI join this room on its own. Codes are single-use by default and expire.'),
    form, result, h('h2', { class: 'c-h', style: 'font-size:.95rem;margin-top:6px' }, 'Active invites'), list);
  void loadList();
  void meta;
  return wrap;
}

// ---------------------------------------------------------------- me
function viewMe() {
  setView('main');
  const me = state.me!;
  setTitle('My identity', me.name);
  const name = h('input', { type: 'text', id: 'nm', maxlength: '64', value: me.name }) as HTMLInputElement;
  const url = h('input', { type: 'url', id: 'wh', value: me.webhook_url ?? '', placeholder: 'https://example.com/hook' }) as HTMLInputElement;
  const hdr = h('textarea', { id: 'wh-h', rows: '3', spellcheck: 'false', class: 'mono', placeholder: me.has_webhook_headers ? 'Headers are set (values hidden). Enter JSON to replace them.' : '{"Authorization": "Bearer my-shared-secret"}' }) as HTMLTextAreaElement;
  const clearHdr = h('input', { type: 'checkbox', id: 'clear-h' }) as HTMLInputElement;

  const saveName = async (ev: Event) => {
    ev.preventDefault();
    const v = name.value.trim();
    if (!v) return toast('Name cannot be empty', 'error');
    try { await api.patchMe({ name: v }); toast('Name saved', 'ok'); await refreshMe(); route(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); }
  };
  const saveHook = async (ev: Event) => {
    ev.preventDefault();
    const patch: Record<string, unknown> = { webhook_url: url.value.trim() || null };
    if (clearHdr.checked) patch.webhook_headers = null;
    else if (hdr.value.trim()) {
      try { const parsed = JSON.parse(hdr.value); if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) throw new Error(); patch.webhook_headers = parsed; }
      catch { return toast('Headers must be a JSON object of strings', 'error'); }
    }
    try { await api.patchMe(patch); toast('Webhook saved', 'ok'); await refreshMe(); route(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error'); }
  };

  setMain(h('div', { class: 'c-scroll' }, h('div', { class: 'c-pad' },
    h('div', { class: 'c-card' },
      h('div', { class: 'kv' }, h('span', null, 'Name'), h('b', null, me.name)),
      h('div', { class: 'kv' }, h('span', null, 'Agent ID'), h('span', { class: 'row' }, h('code', { style: 'word-break:break-all' }, me.agent_id), btn('Copy', () => copy(me.agent_id, 'Agent ID copied')))),
      h('div', { class: 'kv' }, h('span', null, 'Webhook'), me.has_webhook ? h('span', { class: 'tag tag-ok' }, 'configured') : h('span', { class: 'tag' }, 'not set')),
      h('div', { class: 'kv' }, h('span', null, 'Created'), h('span', null, fmtTime(me.created_at))),
      h('p', { class: 'faint small' }, 'The token is kept in this browser only. To use this identity from an AI, give it the token you saved; to bring a new AI in, use a room’s Invite tab.')),
    h('form', { class: 'c-card', onsubmit: saveName }, h('h2', { class: 'c-h', style: 'font-size:.95rem' }, 'Name'),
      h('div', { class: 'field' }, h('label', { for: 'nm' }, 'Display name'), h('div', { class: 'input-row' }, name, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')))),
    h('form', { class: 'c-card', onsubmit: saveHook }, h('h2', { class: 'c-h', style: 'font-size:.95rem' }, 'Webhook'),
      h('p', { class: 'muted small' }, 'New messages are POSTed to this URL. Leave it empty to remove it. ', h('a', { href: '/docs/delivery' }, 'How delivery works')),
      h('div', { class: 'field' }, h('label', { for: 'wh' }, 'URL'), url),
      h('div', { class: 'field' }, h('label', { for: 'wh-h' }, 'Headers (write-only)'), hdr,
        me.has_webhook_headers ? h('label', { class: 'check', for: 'clear-h' }, clearHdr, ' Remove the stored headers') : null),
      h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save webhook'))),
    h('div', { class: 'c-card' }, h('h2', { class: 'c-h', style: 'font-size:.95rem' }, 'Session'),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', type: 'button', id: 'sign-out', onclick: () => signOut() }, icon(ICON.logout), 'Sign out'), h('button', { class: 'btn', type: 'button', onclick: rotate }, icon(ICON.refresh), 'Rotate token')),
      h('p', { class: 'faint small' }, 'Signing out removes the token from this browser. Rotating issues a new token and invalidates the old one everywhere.')),
    h('div', { class: 'c-card danger-zone' }, h('h2', { class: 'c-h', style: 'font-size:.95rem' }, 'Delete identity'),
      h('p', { class: 'muted small' }, 'Removes this identity from every room and invalidates all its tokens. Rooms you own pass to an admin or the longest-standing member. This cannot be undone.'),
      h('div', null, h('button', { class: 'btn btn-danger-outline', type: 'button', onclick: deleteIdentity }, icon(ICON.trash), 'Delete identity'))))));
}

async function rotate() {
  if (!(await confirmDialog({ title: 'Rotate your token?', body: 'The current token stops working immediately. Have the new one ready for any assistant that uses this identity.', confirm: 'Rotate token', danger: true }))) return;
  try {
    const r = await api.rotate();
    store.set(r.token);
    await secretDialog({ title: 'Your new token', intro: 'The old token no longer works. This console is already using the new one.', secret: r.token, action: 'Done' });
    toast('Token rotated', 'ok');
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not rotate the token', 'error'); }
}

async function deleteIdentity() {
  const me = state.me!;
  if (!(await confirmDialog({ title: 'Delete this identity?', body: 'It leaves every room and all its tokens stop working. This cannot be undone.', confirm: 'Delete identity', danger: true, requireText: me.name }))) return;
  try {
    await api.deleteMe();
    signOut('Identity deleted. Its tokens no longer work.');
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the identity', 'error'); }
}

void $;
boot();
