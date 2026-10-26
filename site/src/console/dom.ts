// Tiny DOM helpers. All user and network data goes in through textContent, never innerHTML.
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'dataset') Object.assign(el.dataset, v as object);
      else if (k === 'value') (el as unknown as HTMLInputElement).value = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el: Element) => { while (el.firstChild) el.removeChild(el.firstChild); };
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

export function icon(path: string, size = 16): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  s.appendChild(p);
  return s;
}
/** Build an svg from a static, developer-written inner markup string (never user data). */
export function rawIcon(inner: string, size = 18): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
}
export const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
export const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>';

export const ICON = {
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  chevron: 'M9 6l6 6-6 6',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  share: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13',
  down: 'M6 9l6 6 6-6',
  copy: 'M9 9h11v11H9zM5 15V5h10',
  refresh: 'M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  back: 'M15 6l-6 6 6 6',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2',
};

// ---------- toast
let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info', ms = kind === 'error' ? 5200 : 2400) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- clipboard
export async function copy(text: string, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(label, 'ok', 1600);
}

// ---------- dialogs
export type DialogResult<T> = { ok: boolean; value?: T };

export function openDialog(build: (close: (v?: unknown) => void) => HTMLElement, opts: { dismissible?: boolean; wide?: boolean } = {}): Promise<unknown> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'c-dialog' + (opts.wide ? ' wide' : '');
    const close = (v?: unknown) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.appendChild(build(close));
    if (opts.dismissible !== false) {
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
      dlg.addEventListener('click', (e) => { if (e.target === dlg) close(undefined); });
    } else {
      dlg.addEventListener('cancel', (e) => e.preventDefault());
    }
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export async function confirmDialog(o: { title: string; body: string | Node; confirm: string; danger?: boolean; requireText?: string }): Promise<boolean> {
  const r = await openDialog((close) => {
    const input = o.requireText ? (h('input', { type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type to confirm' }) as HTMLInputElement) : null;
    const go = h('button', { class: `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => close(true) }, o.confirm) as HTMLButtonElement;
    if (input) { go.disabled = true; input.addEventListener('input', () => { go.disabled = input.value.trim() !== o.requireText; }); }
    return h('div', { class: 'dlg' },
      h('h2', { class: 'h3' }, o.title),
      h('div', { class: 'dlg-body' }, typeof o.body === 'string' ? h('p', null, o.body) : o.body),
      o.requireText && h('div', { class: 'field' }, h('label', null, ['Type ', h('code', null, o.requireText), ' to confirm']), input),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'), go));
  });
  return r === true;
}

/** Shows a secret exactly once. Resolves when the user confirms they saved it. */
export function secretDialog(o: { title: string; intro: string; secret: string; label?: string; action?: string }): Promise<void> {
  return openDialog((close) => {
    const cont = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, onclick: () => close(true) }, o.action ?? 'Continue') as HTMLButtonElement;
    const box = h('input', { type: 'text', class: 'mono secret', readonly: true, value: o.secret, 'aria-label': o.label ?? 'Token', onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
    const ack = h('input', { type: 'checkbox', id: 'ack-saved', onchange: (e: Event) => { cont.disabled = !(e.target as HTMLInputElement).checked; } });
    return h('div', { class: 'dlg' },
      h('h2', { class: 'h3' }, o.title),
      h('p', null, o.intro),
      h('div', { class: 'secret-row' }, box, h('button', { class: 'btn', type: 'button', onclick: () => copy(o.secret, 'Token copied') }, icon(ICON.copy), 'Copy')),
      h('p', { class: 'callout' }, h('strong', null, 'Shown once. '), 'We only keep a hash, so it cannot be shown again. Store it in a password manager or your assistant’s secret store.'),
      h('label', { class: 'check', for: 'ack-saved' }, ack, ' I have saved this token'),
      h('div', { class: 'dlg-actions' }, cont));
  }, { dismissible: false }).then(() => undefined);
}

// ---------- formatting
export const shortId = (id: string, head = 10, tail = 4) => (id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id);
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function rel(iso: string): string {
  const d = new Date(iso).getTime();
  if (isNaN(d)) return iso;
  const s = Math.round((d - Date.now()) / 1000);
  const f = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const a = Math.abs(s);
  if (a < 60) return f.format(s, 'second');
  if (a < 3600) return f.format(Math.round(s / 60), 'minute');
  if (a < 86400) return f.format(Math.round(s / 3600), 'hour');
  return f.format(Math.round(s / 86400), 'day');
}
