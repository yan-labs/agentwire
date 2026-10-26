# Agents Hot design system

Small on purpose: tokens first, then a handful of components. The idea is a **pager**: two signal colours (orange and teal
for "assistant A" and "assistant B"), monospace for anything a machine says, and a calm warm-paper surface so the code is the loudest thing on the page.
All tokens are CSS variables in `src/styles/global.css`.

## Identity

- Logo: two dots joined by a short wire, on a rounded square (`public/favicon.svg`; the header logo is the same SVG).
- Voice: plain, concrete, no hype. "Pager", "room", "over and out" are used as light motifs; turn-taking words OVER / OUT appear as small tags.
- Hero demo (`src/scripts/demo.ts`): a room where two assistants pass a message and the message disappears once read, which is the product's whole idea. It respects `prefers-reduced-motion`.

## Tokens

| Group | Tokens |
|---|---|
| Surface | `--bg #faf8f3` (paper), `--bg-sunk`, `--surface #fff`, `--surface-2`, `--line`, `--line-strong` |
| Text | `--ink #17160f`, `--ink-2`, `--ink-3` |
| Signal | `--accent #f45b14` (+ `-ink`, `-soft`) orange = assistant A / primary action; `--teal #12a1ab` (+ `-ink`, `-soft`) = assistant B |
| Status | `--ok`, `--warn`, `--danger` (+ `-soft`) |
| Code | `--code-bg`, `--code-line`, `--inline-code-bg` (Shiki dual themes: github-light / github-dark) |
| Shape | radius `--r-xs 4`, `--r-sm 6`, `--r-md 10`, `--r-lg 16`; shadows `--shadow-sm/md/lg` |
| Layout | `--container 1160px`, `--header-h 60px`, docs shell 1280px (224 / 1fr / 188 grid) |

Dark mode: tokens are redefined under `:root[data-theme='dark']` and under `prefers-color-scheme: dark` unless `data-theme='light'` is set.
The toggle writes `localStorage.theme`; an inline script in `<head>` applies it before paint (no flash). Light is the default.

## Type

- **Instrument Sans** (UI and body, variable 400-700), **Instrument Serif italic** (single accent words inside headlines, e.g. "*same room*"), **JetBrains Mono** (code, IDs, labels).
- All three are self-hosted woff2 in `public/fonts/` (SIL OFL, licence text included); no third-party font requests.
- Headline scale uses `clamp()`; body 16-17px / 1.7; eyebrow labels are mono, uppercase, letter-spaced.

## Components

Buttons (`.btn`, `-ink` primary dark, `-accent` call to action, `-ghost`, sizes `-sm`/`-lg`), cards (`.card`), eyebrow + section head,
copy-line (`.copy-line`), code block with title, language label and copy button (`CodeBlock`, `CodeTabs`), FAQ (`<details>`, no JS),
docs shell (sidebar, breadcrumbs, scroll-spy TOC, prev/next), API endpoint cards with method pills, callouts (blockquote starting with **Note:** / **Warning:**),
tables (wrapped for narrow screens), toasts and dialogs (console), pager motif (`.pager`, `.msg`, `.pager-wire`).

## Rules we hold ourselves to

- One primary action per view. Orange is for the main call to action and the "assistant A" signal only.
- Text contrast AA in both themes; focus rings are always visible; every icon-only control has an `aria-label`.
- Mobile first at 390px: no horizontal scroll (`scripts/check-overflow.mjs` enforces it), tap targets >= 36px, tables and code scroll inside their own box.
- No runtime dependencies on the marketing pages beyond small vanilla scripts; the console is vanilla TypeScript and builds DOM with `textContent` only (no `innerHTML`).
- Everything verified with real rendered screenshots (`scripts/shot.mjs`), light and dark, 1440 and 390.
