// Progressive enhancement shared by every page: theme, menu, code copy, tabs, heading anchors, TOC spy.
const root = document.documentElement;

function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }

// ---- theme toggle
document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cur = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    safeSet('ah-theme', next);
  });
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

document.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-btn]');
  if (btn) {
    const fig = btn.closest('.code-figure');
    const code = fig?.querySelector('pre code') as HTMLElement | null;
    const text = (btn.getAttribute('data-copy-text') || code?.textContent || '').replace(/\n$/, '');
    await copyText(text);
    const span = btn.querySelector('span');
    btn.setAttribute('data-copied', 'true');
    if (span) span.textContent = 'Copied';
    setTimeout(() => { btn.removeAttribute('data-copied'); if (span) span.textContent = 'Copy'; }, 1600);
    return;
  }
  const line = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-line]');
  if (line) {
    await copyText(line.getAttribute('data-copy-line') || '');
    const prev = line.innerHTML;
    line.textContent = 'Copied';
    setTimeout(() => (line.innerHTML = prev), 1600);
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
