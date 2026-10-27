// Progressive enhancement shared by every page: theme, menu, code copy, tabs, heading anchors, TOC spy.
import { buildPrompt, type Flavor } from '../data/prompt';
import { loadOpts } from './promptState';

const root = document.documentElement;

function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }

// ---- theme toggle (delegated, so buttons created later by the console work too)
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-theme-toggle]')) return;
  // Dark is the default. Light is opt-in and remembered; there is no OS-preference auto switch.
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  safeSet('ah-theme', next);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', next === 'light' ? '#f3f4f8' : '#04050b');
});

// ---- mobile menu
document.querySelectorAll<HTMLButtonElement>('[data-menu-toggle]').forEach((btn) => {
  const nav = document.getElementById(btn.getAttribute('aria-controls') || '');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    nav?.setAttribute('data-open', String(open));
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-docs-menu]').forEach((btn) => {
  const nav = document.getElementById('docs-nav');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    nav?.setAttribute('data-open', String(open));
  });
});

// ---- code blocks: wrap markdown <pre> in a figure with a copy button
const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

function makeCopyButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-btn';
  b.setAttribute('data-copy-btn', '');
  b.innerHTML = copyIcon + '<span>Copy</span>';
  return b;
}

function enhanceCode(scope: ParentNode = document) {
  scope.querySelectorAll<HTMLPreElement>('pre.astro-code').forEach((pre) => {
    if (pre.closest('.code-figure')) return;
    const fig = document.createElement('figure');
    fig.className = 'code-figure';
    const title = pre.getAttribute('data-title');
    pre.parentNode?.insertBefore(fig, pre);
    if (title) {
      const head = document.createElement('div');
      head.className = 'code-head';
      const t = document.createElement('span');
      t.className = 'title';
      t.textContent = title;
      const lang = document.createElement('span');
      lang.className = 'lang';
      lang.textContent = pre.getAttribute('data-lang') || '';
      head.append(t, lang, makeCopyButton());
      fig.append(head);
    } else {
      fig.classList.add('nohead');
      fig.append(makeCopyButton());
    }
    fig.append(pre);
  });
}
enhanceCode();

function flash(btn: HTMLElement, done = 'Copied') {
  const span = btn.querySelector('span') as HTMLElement | null;
  const target = span ?? btn;
  if (!btn.dataset.label) btn.dataset.label = target.textContent || '';
  btn.setAttribute('data-copied', 'true');
  target.textContent = done;
  setTimeout(() => { btn.removeAttribute('data-copied'); target.textContent = btn.dataset.label || 'Copy'; }, 1600);
}

document.addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  // Copy the master prompt, tailored for one assistant, with whatever the builder currently holds.
  const pbtn = el.closest<HTMLElement>('[data-copy-prompt]');
  if (pbtn) {
    const flavor = (pbtn.getAttribute('data-copy-prompt') || 'generic') as Flavor;
    await copyText(buildPrompt({ ...loadOpts(), flavor }));
    flash(pbtn);
    return;
  }
  const from = el.closest<HTMLElement>('[data-copy-from]');
  if (from) {
    const src = document.querySelector(from.getAttribute('data-copy-from') || '') as HTMLElement | null;
    await copyText((src?.textContent || '').replace(/\n$/, ''));
    flash(from);
    return;
  }
  const btn = el.closest<HTMLButtonElement>('[data-copy-btn], [data-copy-text]');
  if (btn) {
    const fig = btn.closest('.code-figure');
    const code = fig?.querySelector('pre code') as HTMLElement | null;
    const text = (btn.getAttribute('data-copy-text') || code?.textContent || '').replace(/\n$/, '');
    await copyText(text);
    flash(btn);
    return;
  }
  const line = el.closest<HTMLButtonElement>('[data-copy-line]');
  if (line) {
    await copyText(line.getAttribute('data-copy-line') || '');
    flash(line);
  }
});

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
}

// ---- tabs
document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((tabs) => {
  const buttons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = Array.from(tabs.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  const select = (id: string, focus = false) => {
    buttons.forEach((b) => { const on = b.dataset.tab === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    panels.forEach((p) => (p.hidden = p.dataset.panel !== id));
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(b.dataset.tab!));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[n].dataset.tab!, true);
    });
  });
});

// ---- heading anchors + TOC spy
document.querySelectorAll<HTMLElement>('.prose h2[id], .prose h3[id]').forEach((h) => {
  const a = document.createElement('a');
  a.className = 'anchor';
  a.href = '#' + h.id;
  a.setAttribute('aria-label', 'Link to this section');
  a.textContent = '#';
  h.append(a);
});
const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]'));
if (tocLinks.length && 'IntersectionObserver' in window) {
  const map = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const heads = Array.from(map.keys()).map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        tocLinks.forEach((a) => a.removeAttribute('data-active'));
        map.get(en.target.id)?.setAttribute('data-active', 'true');
      }
    });
  }, { rootMargin: '-72px 0px -70% 0px' });
  heads.forEach((h) => io.observe(h));
}

// ---- prose: scrollable tables, warning callouts
document.querySelectorAll<HTMLTableElement>('.prose table').forEach((t) => {
  if (t.parentElement?.classList.contains('table-wrap')) return;
  const w = document.createElement('div');
  w.className = 'table-wrap';
  t.parentNode?.insertBefore(w, t);
  w.append(t);
});
document.querySelectorAll<HTMLElement>('.prose blockquote').forEach((b) => {
  const first = b.querySelector('strong')?.textContent?.toLowerCase() || '';
  if (/^(warning|important|caution)/.test(first)) b.classList.add('warn');
});

// ---- v3: glass header once scrolled, reveal-on-scroll, pointer light on cards
const header = document.querySelector<HTMLElement>('.site-header');
if (header) {
  const onScroll = () => header.setAttribute('data-scrolled', String(scrollY > 8));
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}
const revealables = document.querySelectorAll<HTMLElement>('[data-reveal]');
if (revealables.length && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  revealables.forEach((el) => io.observe(el));
} else revealables.forEach((el) => el.classList.add('in'));
document.addEventListener('pointermove', (e) => {
  const card = (e.target as HTMLElement).closest?.<HTMLElement>('.qcard');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });
