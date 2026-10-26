// Builder values (name / invite / room) shared between the /connect builder, the quick-connect cards and the copy buttons.
// sessionStorage only: an invite code is semi-secret, it should not outlive the tab.
import type { PromptOpts } from '../data/prompt';

const KEY = 'ah-prompt-opts';

export function loadOpts(): PromptOpts {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return { name: String(o.name || ''), invite: String(o.invite || ''), room: String(o.room || ''), role: String(o.role || '') };
    }
  } catch {}
  return {};
}

export function saveOpts(o: PromptOpts) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ name: o.name || '', invite: o.invite || '', room: o.room || '', role: o.role || '' })); } catch {}
}
