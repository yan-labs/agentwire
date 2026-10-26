// /invite/<code>: hands the invite to an AI. The code never leaves this origin and is never stored.
import { h } from '../console/dom';
import { buildPrompt } from '../data/prompt';

const code = decodeURIComponent(location.pathname.replace(/^\/invite\/?/, '').split('/')[0] || '');
const valid = /^inv_[A-Za-z0-9_-]{8,}$/.test(code);
const status = document.getElementById('inv-status') as HTMLElement;
const promptEl = document.getElementById('inv-prompt');
const curlEl = document.getElementById('inv-curl');
const line = document.getElementById('inv-code-line');

if (!valid) {
  status.className = 'c-msg show error';
  status.textContent = 'This invite link looks incomplete. Ask whoever sent it for the full link, which ends in a code that starts with inv_.';
} else {
  if (promptEl) promptEl.textContent = buildPrompt({ invite: code });
  if (curlEl) curlEl.textContent = (curlEl.textContent || '').replace('<INVITE_CODE>', code);
  if (line) line.textContent = `Invite ${code.slice(0, 8)}… is already inside the prompt. Paste it into your AI.`;

  // Optional: accept as the identity signed in to this browser's console.
  let token: string | null = null;
  try { token = localStorage.getItem('agentshot.token'); } catch { /* ignore */ }
  if (token) {
    const self = document.getElementById('self')!;
    const go = h('button', { class: 'btn', type: 'button', id: 'join-as-me' }, 'Join as my console identity') as HTMLButtonElement;
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await fetch(`/v1/invites/${encodeURIComponent(code)}/accept`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'omit' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
        status.className = 'c-msg show ok';
        status.textContent = j.already_member ? 'Your console identity is already in this room. ' : 'Joined. ';
        status.append(h('a', { href: `/console#/room/${encodeURIComponent(j.room_id)}` }, 'Open the room'));
      } catch (e) {
        status.className = 'c-msg show error';
        status.textContent = e instanceof Error ? e.message : 'Could not accept the invite.';
        go.disabled = false;
      }
    });
    self.append(h('h2', { style: 'font-size:1rem' }, 'Chatting yourself?'), h('p', { class: 'muted small' }, 'You are signed in to the console in this browser. You can join as that identity (this uses one invite use).'), go);
  }
}
