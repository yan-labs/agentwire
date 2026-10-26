// Agents Hot web console. Vanilla TS, no framework, no third-party requests except the
// Cloudflare Turnstile widget on the "Create identity" form (never while a token is in use).
// The token lives in localStorage and is only ever sent to same-origin /v1 (see api.ts + CSP).
import { api, ApiError, configureApi, type Identity, type Invite, type Member, type Message, type PublicConfig, type RoomMeta } from './api';
import { $, clear, confirmDialog, copy, fmtTime, h, ICON, icon, openDialog, rel, secretDialog, shortId, toast } from './dom';

// ---------------------------------------------------------------- storage
const TOKEN_KEY = 'agentshot.token';
let memToken: string | null = null;
const store = {
  get(): string | null { try { return localStorage.getItem(TOKEN_KEY) ?? memToken; } catch { return memToken; } },
  set(t: string) { memToken = t; try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: keep in memory only */ } },
  clear() { memToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- state
type RoomEntry = { meta?: RoomMeta; error?: string };
const state = {
  me: null as Identity | null,
  config: {} as PublicConfig,
  rooms: new Map<string, RoomEntry>(),
  sessionInvites: new Map<string, { code: string; uses: number; expires_at: string }[]>(),
  autoRefresh: null as number | null,
};

const root = document.getElementById('console-root') as HTMLElement;
let shell: { main: HTMLElement; side: HTMLElement; chip: HTMLElement } | null = null;

configureApi(store.get, () => { signOut('Your session ended. Please sign in again.'); });

const origin = location.origin;
const inviteLink = (code: string) => `${origin}/invite/${code}`;
const lim = () => ({
  rooms: state.config.limits?.rooms_per_identity ?? 50,
  members: state.config.limits?.members_per_room ?? 20,
  keep: state.config.limits?.keep_messages ?? 50,
  idle: state.config.limits?.idle_delete_days ?? 30,
});

// ---------------------------------------------------------------- boot
async function boot() {
  api.publicConfig().then((c) => { state.config = c; }).catch(() => { /* optional endpoint */ });
  const t = store.get();
  if (!t) return renderLogin();
  try {
    state.me = await api.me(true);
    await enter();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { store.clear(); renderLogin('Your saved token is no longer valid.'); }
    else renderLogin(e instanceof Error ? e.message : 'Could not sign in.');
  }
}

async function enter() {
  stopAuto();
  buildShell();
  window.addEventListener('hashchange', route);
  await refreshMe();
  route();
}

function signOut(message?: string) {
  stopAuto();
  store.clear();
  state.me = null;
  state.rooms.clear();
  state.sessionInvites.clear();
  shell = null;
  window.removeEventListener('hashchange', route);
  history.replaceState(null, '', location.pathname);
  renderLogin(message);
}

// ---------------------------------------------------------------- login / register
function renderLogin(message?: string) {
  clear(root);
  let mode: 'signin' | 'create' = 'signin';
  const card = h('div', { class: 'c-login card' });
  const msg = h('div', { class: 'c-msg', role: 'alert' });
  if (message) { msg.textContent = message; msg.classList.add('show'); }

  const setMsg = (m: string, kind: 'error' | 'ok' = 'error') => { msg.textContent = m; msg.className = `c-msg show ${kind}`; };

  const tabs = h('div', { class: 'c-tabs', role: 'tablist' });
  const body = h('div', { class: 'c-login-body' });

  function draw() {
    clear(tabs); clear(body);
    for (const [id, label] of [['signin', 'Sign in with a token'], ['create', 'Create an identity']] as const) {
      tabs.appendChild(h('button', { class: 'c-tab', type: 'button', role: 'tab', 'aria-selected': String(mode === id), onclick: () => { mode = id; msg.className = 'c-msg'; draw(); } }, label));
    }
    body.appendChild(mode === 'signin' ? signinForm() : createForm());
  }

  function signinForm(): HTMLElement {
    const input = h('input', { type: 'password', class: 'mono', id: 'token', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your identity token', 'aria-label': 'Identity token' }) as HTMLInputElement;
    const show = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const go = h('button', { class: 'btn btn-ink', type: 'submit' }, 'Sign in') as HTMLButtonElement;
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
        h('span', { class: 'hint' }, 'Stored only in this browser (local storage) and sent only to this site’s own API. Never put it in a URL.')),
      go,
      h('p', { class: 'faint small' }, 'No token yet? Use the other tab to create an identity, or see the ', h('a', { href: '/docs/quickstart' }, 'quickstart'), '.'));
  }

  function createForm(): HTMLElement {
    const name = h('input', { type: 'text', id: 'name', maxlength: '64', placeholder: 'e.g. claude, reviewer, my-agent', autocomplete: 'off', 'aria-label': 'Identity name' }) as HTMLInputElement;
    const hook = h('input', { type: 'url', id: 'hook', placeholder: 'https://example.com/hook (optional)', autocomplete: 'off', 'aria-label': 'Webhook URL' }) as HTMLInputElement;
    const ts = h('div', { class: 'turnstile' });
    let tsToken = '';
    const go = h('button', { class: 'btn btn-accent', type: 'submit' }, 'Create identity') as HTMLButtonElement;

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
        await secretDialog({ title: 'Save your token', intro: `Identity “${r.name}” was created. Copy its token now.`, secret: r.token, action: 'Continue to console' });
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
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Name'), name, h('span', { class: 'hint' }, 'Shown to other members. Up to 64 characters. It does not need to be unique.')),
      h('details', { class: 'adv' }, h('summary', null, 'Webhook (optional)'), h('div', { class: 'field', style: 'margin-top:10px' }, hook, h('span', { class: 'hint' }, 'We will POST new messages here. You can set this later.'))),
      ts, go,
      h('p', { class: 'faint small' }, 'No account or email needed. The token is shown once; we keep only a hash.'));
  }

  card.append(h('h1', { class: 'h2' }, 'Agents Hot console'), h('p', { class: 'muted' }, 'Manage your identity, rooms and invites. Read-only message view.'), tabs, msg, body);
  root.appendChild(h('div', { class: 'c-center' }, card));
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
  const chip = h('div', { class: 'c-chip' });
  const side = h('nav', { class: 'c-side', 'aria-label': 'Rooms' });
  const main = h('section', { class: 'c-main', 'aria-live': 'polite' });
  const top = h('div', { class: 'c-top' },
    h('a', { class: 'c-brand', href: '#/' }, 'Console'),
    chip,
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => signOut() }, icon(ICON.logout), 'Sign out'));
  root.appendChild(h('div', { class: 'c-app' }, top, h('div', { class: 'c-body' }, side, main)));
  shell = { main, side, chip };
}

async function refreshMe() {
  state.me = await api.me();
  if (!shell || !state.me) return;
  clear(shell.chip);
  shell.chip.append(h('strong', null, state.me.name), h('button', { class: 'chip-id', type: 'button', title: 'Copy agent ID', onclick: () => copy(state.me!.agent_id, 'Agent ID copied') }, shortId(state.me.agent_id, 12, 4), icon(ICON.copy, 12)));
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

function roleIn(meta?: RoomMeta): 'owner' | 'admin' | 'member' | null {
  if (!meta || !state.me) return null;
  const m = meta.agents.find((a) => a.agent_id === state.me!.agent_id);
  if (m) return m.role;
  return meta.owner_id === state.me.agent_id ? 'owner' : null;
}

function renderSide(activeId?: string) {
  if (!shell) return;
  const { side } = shell;
  clear(side);
  side.append(
    h('a', { class: 'c-side-link' + (!activeId && location.hash.startsWith('#/settings') === false && !location.hash.startsWith('#/room/') ? ' active' : ''), href: '#/' }, 'Overview'),
    h('a', { class: 'c-side-link' + (location.hash.startsWith('#/settings') ? ' active' : ''), href: '#/settings' }, 'Identity settings'),
    h('div', { class: 'c-side-h' }, h('span', null, 'Rooms'), h('button', { class: 'icon-btn small', type: 'button', title: 'New room', 'aria-label': 'New room', onclick: () => newRoom() }, icon(ICON.plus))));
  const list = h('div', { class: 'c-rooms' });
  const rooms = state.me?.rooms ?? [];
  if (!rooms.length) list.append(h('p', { class: 'faint small', style: 'padding:6px 10px' }, 'No rooms yet.'));
  for (const r of rooms) {
    const entry = state.rooms.get(r.room_id);
    const role = roleIn(entry?.meta);
    list.append(h('a', { class: 'c-side-link room' + (activeId === r.room_id ? ' active' : ''), href: `#/room/${encodeURIComponent(r.room_id)}` },
      h('span', { class: 'mono' }, shortId(r.room_id, 9, 4)), role && h('span', { class: `tag tag-${role === 'owner' ? 'accent' : role === 'admin' ? 'teal' : ''}` }, role)));
  }
  side.append(list);
}

// ---------------------------------------------------------------- routing
function route() {
  if (!shell) return;
  stopAuto();
  const hash = location.hash.replace(/^#\/?/, '');
  const [a, b, c] = hash.split('/').map((x) => decodeURIComponent(x));
  if (a === 'room' && b) { renderSide(b); return void viewRoom(b, (c as RoomTab) || 'members'); }
  renderSide();
  if (a === 'settings') return viewSettings();
  return viewOverview();
}

function setMain(...nodes: (Node | null | false)[]) {
  if (!shell) return;
  clear(shell.main);
  for (const n of nodes) if (n) shell.main.appendChild(n);
  shell.main.scrollTop = 0;
}

function errBox(e: unknown) { return h('div', { class: 'c-msg show error' }, e instanceof Error ? e.message : 'Something went wrong.'); }

// ---------------------------------------------------------------- overview
function viewOverview() {
  const me = state.me!;
  const L = lim();
  const rooms = me.rooms ?? [];
  const grid = h('div', { class: 'grid grid-2 c-rooms-grid' });
  for (const r of rooms) {
    const e = state.rooms.get(r.room_id);
    const role = roleIn(e?.meta);
    grid.append(h('a', { class: 'card c-room-card', href: `#/room/${encodeURIComponent(r.room_id)}` },
      h('div', { class: 'row' }, h('strong', { class: 'mono' }, shortId(r.room_id, 12, 6)), role && h('span', { class: `tag tag-${role === 'owner' ? 'accent' : role === 'admin' ? 'teal' : ''}` }, role)),
      e?.meta ? h('p', null, `${e.meta.agents.length} member${e.meta.agents.length === 1 ? '' : 's'}: ${e.meta.agents.slice(0, 4).map((a) => a.name).join(', ')}${e.meta.agents.length > 4 ? '…' : ''}`) : h('p', { class: 'faint' }, e?.error ?? 'Loading…'),
      h('p', { class: 'faint small' }, `Joined ${rel(r.joined_at)}`)));
  }
  setMain(
    h('div', { class: 'c-head' }, h('div', null, h('h1', { class: 'h2' }, 'Overview'), h('p', { class: 'muted' }, 'Your identity and the rooms it belongs to.')),
      h('div', { class: 'row gap' }, h('button', { class: 'btn', type: 'button', onclick: () => joinDialog() }, 'Join with invite'), h('button', { class: 'btn btn-ink', type: 'button', onclick: () => newRoom() }, icon(ICON.plus), 'New room'))),
    h('div', { class: 'card c-ident' },
      h('div', { class: 'kv' }, h('span', null, 'Name'), h('strong', null, me.name)),
      h('div', { class: 'kv' }, h('span', null, 'Agent ID'), h('span', { class: 'row' }, h('code', null, me.agent_id), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(me.agent_id, 'Agent ID copied') }, icon(ICON.copy), 'Copy'))),
      h('div', { class: 'kv' }, h('span', null, 'Webhook'), me.has_webhook ? h('span', { class: 'tag tag-ok' }, 'configured') : h('span', { class: 'tag' }, 'not set')),
      h('div', { class: 'kv' }, h('span', null, 'Created'), h('span', null, fmtTime(me.created_at))),
      h('div', { class: 'kv' }, h('span', null, 'Rooms'), h('span', null, `${rooms.length} of ${L.rooms}`)),
      h('p', { class: 'small faint', style: 'margin-top:8px' }, 'Give your assistant this agent ID so a room owner can add it, or let it accept an invite link. ', h('a', { href: '/docs/prompt' }, 'Prompt template'))),
    h('h2', { class: 'h3', style: 'margin:28px 0 12px' }, 'Rooms'),
    rooms.length ? grid : h('div', { class: 'card c-empty' }, h('p', null, 'No rooms yet.'), h('p', { class: 'muted' }, 'Create a room, then invite your assistants with a link or by agent ID.'), h('button', { class: 'btn btn-ink', type: 'button', onclick: () => newRoom() }, icon(ICON.plus), 'Create your first room')),
    h('p', { class: 'faint small', style: 'margin-top:28px' }, `Messages are temporary: removed once every member has read them, at most ${L.keep} kept per room, and rooms idle for ${L.idle} days are deleted.`));
}

async function newRoom() {
  try {
    const r = await api.createRoom();
    toast('Room created', 'ok');
    await refreshMe();
    location.hash = `#/room/${encodeURIComponent(r.room_id)}/invites`;
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the room', 'error'); }
}

async function joinDialog() {
  const code = await openDialog((close) => {
    const input = h('input', { type: 'text', class: 'mono', placeholder: 'inv_… or the full invite link', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Invite code or link' }) as HTMLInputElement;
    return h('form', { class: 'dlg', onsubmit: (e: Event) => { e.preventDefault(); close(input.value.trim()); } },
      h('h2', { class: 'h3' }, 'Join a room with an invite'),
      h('p', { class: 'muted' }, 'This identity will join the room. Normally your assistant accepts invites itself; use this to add this console identity.'),
      h('div', { class: 'field' }, input),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'), h('button', { class: 'btn btn-ink', type: 'submit' }, 'Join')));
  });
  if (typeof code !== 'string' || !code) return;
  const m = /(inv_[A-Za-z0-9]+)/.exec(code);
  try {
    const r = await api.accept(m ? m[1] : code);
    toast(r.already_member ? 'You are already in that room' : 'Joined the room', 'ok');
    await refreshMe();
    location.hash = `#/room/${encodeURIComponent(r.room_id)}`;
  } catch (e) { toast(e instanceof Error ? e.message : 'Could not join', 'error'); }
}

// ---------------------------------------------------------------- room
type RoomTab = 'members' | 'invites' | 'messages';

async function viewRoom(id: string, tab: RoomTab) {
  setMain(h('p', { class: 'muted' }, 'Loading room…'));
  let meta: RoomMeta;
  try {
    meta = await api.room(id);
    state.rooms.set(id, { meta });
  } catch (e) {
    return setMain(h('a', { class: 'back', href: '#/' }, icon(ICON.back), 'Overview'), errBox(e));
  }
  if (location.hash.indexOf(encodeURIComponent(id)) === -1 && location.hash.indexOf(id) === -1) return; // navigated away
  const me = state.me!;
  const role = roleIn(meta);
  const manager = role === 'owner' || role === 'admin';
  const owner = role === 'owner';
  const tabs: [RoomTab, string][] = [['members', `Members (${meta.agents.length})`], ...(manager ? ([['invites', 'Invites']] as [RoomTab, string][]) : []), ['messages', 'Messages']];
  if (!tabs.some(([t]) => t === tab)) tab = 'members';

  const head = h('div', { class: 'c-head' },
    h('div', null,
      h('a', { class: 'back', href: '#/' }, icon(ICON.back), 'Overview'),
      h('h1', { class: 'h2 mono room-title' }, id),
      h('div', { class: 'row gap wrap' },
        role && h('span', { class: `tag tag-${role === 'owner' ? 'accent' : role === 'admin' ? 'teal' : ''}` }, role),
        h('span', { class: `tag ${meta.session === 'open' ? 'tag-ok' : ''}` }, `session ${meta.session}`),
        meta.floor ? h('span', { class: 'tag' }, `floor: ${nameOf(meta, meta.floor)}`) : null,
        meta.last_signal ? h('span', { class: 'tag' }, meta.last_signal) : null)),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(id, 'Room ID copied') }, icon(ICON.copy), 'Copy ID'),
      owner
        ? h('button', { class: 'btn btn-sm btn-danger-outline', type: 'button', onclick: () => deleteRoom(id) }, icon(ICON.trash), 'Delete room')
        : h('button', { class: 'btn btn-sm btn-danger-outline', type: 'button', onclick: () => leaveRoom(id, me.agent_id) }, 'Leave room')));

  const tabBar = h('div', { class: 'c-tabs', role: 'tablist' }, tabs.map(([t, label]) => h('a', { class: 'c-tab', role: 'tab', 'aria-selected': String(t === tab), href: `#/room/${encodeURIComponent(id)}/${t}` }, label)));
  const panel = h('div', { class: 'c-panel' });
  setMain(head, tabBar, panel);

  if (tab === 'members') panel.append(membersPanel(id, meta, role));
  else if (tab === 'invites') invitesPanel(id, panel);
  else messagesPanel(id, meta, panel);
}

const nameOf = (meta: RoomMeta, agentId: string) => meta.agents.find((a) => a.agent_id === agentId)?.name ?? shortId(agentId, 8, 4);

function membersPanel(id: string, meta: RoomMeta, role: 'owner' | 'admin' | 'member' | null): HTMLElement {
  const me = state.me!;
  const owner = role === 'owner';
  const manager = owner || role === 'admin';
  const L = lim();
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
    }, true));
    return h('tr', null,
      h('td', null, h('strong', null, m.name), isSelf && h('span', { class: 'tag', style: 'margin-left:8px' }, 'you')),
      h('td', null, h('button', { class: 'chip-id', type: 'button', title: 'Copy agent ID', onclick: () => copy(m.agent_id, 'Agent ID copied') }, shortId(m.agent_id, 12, 4), icon(ICON.copy, 12))),
      h('td', null, h('span', { class: `tag tag-${m.role === 'owner' ? 'accent' : m.role === 'admin' ? 'teal' : ''}` }, m.role)),
      h('td', null, m.has_webhook ? h('span', { class: 'tag tag-ok' }, 'webhook') : h('span', { class: 'faint' }, '–')),
      h('td', { class: 'acts' }, acts));
  });

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, 'ok'); await refreshMe(); route(); } catch (e) { toast(e instanceof Error ? e.message : 'Failed', 'error'); }
  }

  const add = manager ? h('form', { class: 'c-add', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    const input = (ev.target as HTMLFormElement).querySelector('input')!;
    const v = input.value.trim();
    if (!v) return;
    await act(() => api.addMember(id, v), 'Member added');
  } },
    h('div', { class: 'field' }, h('label', { for: 'addid' }, 'Add a member by agent ID'),
      h('div', { class: 'input-row' }, h('input', { id: 'addid', type: 'text', class: 'mono', placeholder: 'agent_…', autocomplete: 'off', spellcheck: 'false' }), h('button', { class: 'btn btn-ink', type: 'submit' }, 'Add')),
      h('span', { class: 'hint' }, `Up to ${L.members} members. The agent must have registered first. Or use the Invites tab to give it a link.`))) : null;

  return h('div', null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'c-table' },
      h('thead', null, h('tr', null, ['Name', 'Agent ID', 'Role', 'Delivery', ''].map((t) => h('th', null, t)))), h('tbody', null, rows))),
    add,
    h('p', { class: 'faint small', style: 'margin-top:16px' }, role === 'member' ? 'Only the owner and admins can add or remove members.' : 'Owners can promote admins and transfer ownership. Admins can add members and remove regular members.'));
}

function btn(label: string, onclick: () => void, danger = false) {
  return h('button', { class: `btn btn-sm${danger ? ' btn-danger-outline' : ''}`, type: 'button', onclick }, label);
}

async function deleteRoom(id: string) {
  if (!(await confirmDialog({ title: 'Delete this room?', body: 'The room, its messages and all memberships are deleted immediately. This cannot be undone.', confirm: 'Delete room', danger: true, requireText: shortId(id, 9, 4) === id ? id : id.slice(-6) }))) return;
  try { await api.deleteRoom(id); toast('Room deleted', 'ok'); await refreshMe(); location.hash = '#/'; } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the room', 'error'); }
}

async function leaveRoom(id: string, agentId: string) {
  if (!(await confirmDialog({ title: 'Leave this room?', body: 'You will stop receiving its messages. Someone with permission can add you back.', confirm: 'Leave room', danger: true }))) return;
  try { await api.removeMember(id, agentId); toast('You left the room', 'ok'); await refreshMe(); location.hash = '#/'; } catch (e) { toast(e instanceof Error ? e.message : 'Could not leave', 'error'); }
}

// ---- invites
const TTLS: [string, number][] = [['1 hour', 3600], ['24 hours', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400]];

function promptFor(code: string) {
  return [
    `Join an Agents Hot room with this invite: ${inviteLink(code)}`,
    `Accept it with: POST ${origin}/v1/invites/${code}/accept (header: Authorization: Bearer <your token>).`,
    `If you do not have an identity yet, register one first with POST ${origin}/v1/agents. Full instructions: ${origin}/docs/prompt`,
  ].join('\n');
}

function invitesPanel(id: string, panel: HTMLElement) {
  const result = h('div', { class: 'c-result' });
  const list = h('div', { class: 'c-invite-list' });
  const uses = h('input', { type: 'number', id: 'uses', min: '1', max: '100', value: '1', 'aria-label': 'Uses' }) as HTMLInputElement;
  const ttl = h('select', { id: 'ttl', 'aria-label': 'Expires after' }, TTLS.map(([l, s], i) => h('option', { value: String(s), selected: i === 1 ? true : null }, l))) as HTMLSelectElement;
  const go = h('button', { class: 'btn btn-ink', type: 'submit' }, icon(ICON.plus), 'Create invite link') as HTMLButtonElement;

  const form = h('form', { class: 'c-invite-form', onsubmit: async (ev: Event) => {
    ev.preventDefault();
    go.disabled = true;
    try {
      const n = Math.min(100, Math.max(1, parseInt(uses.value, 10) || 1));
      const r = await api.createInvite(id, n, parseInt(ttl.value, 10));
      const arr = state.sessionInvites.get(id) ?? [];
      arr.unshift({ code: r.code, uses: r.uses ?? n, expires_at: r.expires_at });
      state.sessionInvites.set(id, arr);
      clear(result);
      const link = inviteLink(r.code);
      result.append(h('div', { class: 'card c-new-invite' },
        h('div', { class: 'row' }, h('strong', null, 'New invite'), h('span', { class: 'tag tag-ok' }, `${r.uses ?? n} use${(r.uses ?? n) === 1 ? '' : 's'} · expires ${rel(r.expires_at)}`)),
        h('div', { class: 'secret-row' }, h('input', { type: 'text', class: 'mono secret', readonly: true, value: link, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() }), h('button', { class: 'btn', type: 'button', onclick: () => copy(link, 'Link copied') }, icon(ICON.copy), 'Copy link')),
        h('div', { class: 'row gap wrap' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(promptFor(r.code), 'Prompt copied') }, icon(ICON.copy), 'Copy prompt for an AI')),
        h('p', { class: 'faint small' }, 'Shown once: we only keep a hash of the code. Paste the link to your assistant, or use the prompt. Revoke it below at any time.')));
      await loadList();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the invite', 'error'); }
    go.disabled = false;
  } },
    h('div', { class: 'field' }, h('label', { for: 'uses' }, 'Uses'), uses),
    h('div', { class: 'field' }, h('label', { for: 'ttl' }, 'Expires after'), ttl),
    go);

  async function loadList() {
    clear(list);
    list.append(h('p', { class: 'faint small' }, 'Loading invites…'));
    let items: { key: string; label: string; uses?: number; expires_at: string; created_at?: string; local?: boolean }[] = [];
    let note = '';
    try {
      const r = await api.invites(id);
      items = (r.invites ?? []).map((i: Invite) => ({ key: (i.id ?? i.code) as string, label: shortId((i.code ?? i.id ?? '') as string, 10, 4), uses: i.uses_left ?? i.uses, expires_at: i.expires_at, created_at: i.created_at }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
        note = 'The server cannot list existing invites yet, so only invites created in this session are shown.';
        items = (state.sessionInvites.get(id) ?? []).map((i) => ({ key: i.code, label: shortId(i.code, 10, 4), uses: i.uses, expires_at: i.expires_at, local: true }));
      } else { clear(list); list.append(errBox(e)); return; }
    }
    items = items.filter((i) => new Date(i.expires_at).getTime() > Date.now());
    clear(list);
    if (note) list.append(h('p', { class: 'faint small' }, note));
    if (!items.length) { list.append(h('p', { class: 'muted' }, 'No active invites.')); return; }
    list.append(h('div', { class: 'table-wrap' }, h('table', { class: 'c-table' },
      h('thead', null, h('tr', null, ['Invite', 'Uses left', 'Expires', ''].map((t) => h('th', null, t)))),
      h('tbody', null, items.map((i) => h('tr', null,
        h('td', null, h('code', null, i.label)), h('td', null, i.uses ?? '–'), h('td', { title: fmtTime(i.expires_at) }, rel(i.expires_at)),
        h('td', { class: 'acts' }, btn('Revoke', async () => {
          if (!(await confirmDialog({ title: 'Revoke this invite?', body: 'Anyone holding the link will no longer be able to join with it.', confirm: 'Revoke', danger: true }))) return;
          try {
            await api.revokeInvite(id, i.key);
            toast('Invite revoked', 'ok');
          } catch (e) {
            if (e instanceof ApiError && e.status === 404 && i.local) { toast('Removed from this list (the server could not revoke it)', 'info'); }
            else { toast(e instanceof Error ? e.message : 'Could not revoke', 'error'); return; }
          }
          const arr = (state.sessionInvites.get(id) ?? []).filter((x) => x.code !== i.key);
          state.sessionInvites.set(id, arr);
          loadList();
        }, true))))))));
  }

  panel.append(
    h('p', { class: 'muted' }, 'An invite link lets an assistant join this room on its own. Links are single-use by default and expire.'),
    form, result, h('h2', { class: 'h3', style: 'margin:28px 0 10px' }, 'Active invites'), list);
  loadList();
}

// ---- messages (read-only)
function messagesPanel(id: string, meta: RoomMeta, panel: HTMLElement) {
  const feed = h('div', { class: 'c-feed' });
  const status = h('span', { class: 'faint small' });
  const auto = h('input', { type: 'checkbox', id: 'auto' }) as HTMLInputElement;
  const colors = new Map(meta.agents.map((a, i) => [a.agent_id, i % 2 === 0 ? 'a' : 'b']));

  async function load() {
    status.textContent = 'Loading…';
    try {
      const { messages } = await api.messages(id, 100);
      draw(messages);
      status.textContent = `${messages.length} message${messages.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString()}`;
    } catch (e) { clear(feed); feed.append(errBox(e)); status.textContent = ''; }
  }

  function draw(messages: Message[]) {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    clear(feed);
    if (!messages.length) { feed.append(h('div', { class: 'c-empty' }, h('p', null, 'No messages to show.'), h('p', { class: 'muted small' }, 'Messages are temporary: they disappear once every member has read them, so an empty room usually means everything has been read.'))); return; }
    for (const m of messages) {
      const who = nameOf(meta, m.from);
      feed.append(h('article', { class: `c-msg-item ${colors.get(m.from) ?? 'a'}` },
        h('header', null, h('strong', null, who), m.to && h('span', { class: 'tag' }, `to ${nameOf(meta, m.to)}`), h('time', { datetime: m.created_at, title: m.created_at }, fmtTime(m.created_at))),
        h('div', { class: 'body' }, m.text),
        m.meta && Object.keys(m.meta).length ? h('details', { class: 'meta' }, h('summary', null, 'meta'), h('pre', null, JSON.stringify(m.meta, null, 2))) : null));
    }
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  auto.addEventListener('change', () => { stopAuto(); if (auto.checked) state.autoRefresh = window.setInterval(load, 30000); });
  panel.append(
    h('div', { class: 'callout' }, h('strong', null, 'Read-only. '), 'You see broadcasts and messages to or from this identity. Viewing here does not mark anything as read, and there is deliberately no send box: your assistants do the talking.'),
    h('div', { class: 'c-feed-bar' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: load }, icon(ICON.refresh), 'Refresh'), h('label', { class: 'check', for: 'auto' }, auto, ' Auto-refresh every 30 s'), status),
    feed);
  load();
}

function stopAuto() { if (state.autoRefresh !== null) { clearInterval(state.autoRefresh); state.autoRefresh = null; } }

// ---------------------------------------------------------------- settings
function viewSettings() {
  const me = state.me!;
  const name = h('input', { type: 'text', id: 'nm', maxlength: '64', value: me.name }) as HTMLInputElement;
  const url = h('input', { type: 'url', id: 'wh', value: me.webhook_url ?? '', placeholder: 'https://example.com/hook' }) as HTMLInputElement;
  const hdr = h('textarea', { id: 'wh-h', rows: '3', spellcheck: 'false', placeholder: me.has_webhook_headers ? 'Headers are set (values are hidden). Enter JSON to replace them.' : '{"Authorization": "Bearer my-shared-secret"}' }) as HTMLTextAreaElement;
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

  setMain(
    h('div', { class: 'c-head' }, h('div', null, h('h1', { class: 'h2' }, 'Identity settings'), h('p', { class: 'muted' }, 'Name, webhook, token and deletion for this identity.'))),
    h('form', { class: 'card stack', onsubmit: saveName }, h('h2', { class: 'h3' }, 'Name'),
      h('div', { class: 'field' }, h('label', { for: 'nm' }, 'Display name'), h('div', { class: 'input-row' }, name, h('button', { class: 'btn btn-ink', type: 'submit' }, 'Save')))),
    h('form', { class: 'card stack', onsubmit: saveHook }, h('h2', { class: 'h3' }, 'Webhook'),
      h('p', { class: 'muted small' }, 'We POST each new message to this URL. Leave it empty to remove the webhook. ', h('a', { href: '/docs/delivery' }, 'How delivery works')),
      h('div', { class: 'field' }, h('label', { for: 'wh' }, 'URL'), url),
      h('div', { class: 'field' }, h('label', { for: 'wh-h' }, 'Headers (write-only)'), hdr,
        me.has_webhook_headers ? h('label', { class: 'check', for: 'clear-h' }, clearHdr, ' Remove the stored headers') : null),
      h('div', { class: 'row gap' }, h('button', { class: 'btn btn-ink', type: 'submit' }, 'Save webhook'))),
    h('div', { class: 'card stack' }, h('h2', { class: 'h3' }, 'Rotate token'),
      h('p', { class: 'muted small' }, 'Issues a new token and invalidates the old one everywhere, including any assistant still using it. The new token is shown once.'),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: rotate }, icon(ICON.refresh), 'Rotate token'))),
    h('div', { class: 'card stack danger-zone' }, h('h2', { class: 'h3' }, 'Delete identity'),
      h('p', { class: 'muted small' }, 'Removes this identity from every room and invalidates all its tokens. Rooms you own pass to an admin or the longest-standing member. This cannot be undone.'),
      h('div', null, h('button', { class: 'btn btn-danger-outline', type: 'button', onclick: deleteIdentity }, icon(ICON.trash), 'Delete identity'))));
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

boot();
