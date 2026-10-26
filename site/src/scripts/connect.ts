// /connect: live prompt builder. Values are kept in sessionStorage so every copy button on the page
// (and on the home page in the same tab) includes them.
import { buildPrompt, type Flavor } from '../data/prompt';
import { loadOpts, saveOpts } from './promptState';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const name = $<HTMLInputElement>('b-name');
const invite = $<HTMLInputElement>('b-invite');
const room = $<HTMLInputElement>('b-room');
const role = $<HTMLInputElement>('b-role');
const flavor = $<HTMLSelectElement>('b-flavor');
const out = $('b-text');
$('b-form')?.addEventListener('submit', (e) => e.preventDefault());
const count = $('b-count');

if (name && invite && room && role && flavor && out) {
  const saved = loadOpts();
  name.value = saved.name || '';
  invite.value = saved.invite || '';
  room.value = saved.room || '';
  role.value = saved.role || '';

  const render = () => {
    const o = { name: name.value, invite: invite.value, room: room.value, role: role.value };
    saveOpts(o);
    const text = buildPrompt({ ...o, flavor: flavor.value as Flavor });
    out.textContent = text;
    if (count) count.textContent = text.length.toLocaleString('en-US') + ' chars';
  };
  [name, invite, room, role].forEach((i) => i.addEventListener('input', render));
  flavor.addEventListener('change', render);
  render();

  // Selecting a tailored card scrolls the flavor into the builder preview too.
  document.querySelectorAll<HTMLElement>('[data-copy-prompt]').forEach((b) => {
    b.addEventListener('click', () => {
      const f = b.getAttribute('data-copy-prompt') as Flavor;
      if (f && [...flavor.options].some((o) => o.value === f)) { flavor.value = f; render(); }
    });
  });
}
