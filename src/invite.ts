import type { Env } from './room';
import { H_TRUSTED_JOIN, H_TRUSTED_LEAVE } from './room';
import { directory } from './d1-directory';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Same join the public accept-invite route performs: redeem, then trusted room membership. */
export async function acceptInvite(env: Env, agent: { id: string; name: string }, code: string): Promise<Response> {
  const dir = directory(env);
  const roomId = await dir.redeemInvite(code);
  if (!roomId) return json({ error: 'invite invalid or expired' }, 404);
  const res = await env.ROOM.getByName(roomId).fetch(new Request(new URL('/internal/members', 'https://internal').toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [H_TRUSTED_JOIN]: '1' },
    body: JSON.stringify({ agent_id: agent.id, name: agent.name }),
  }));
  if (!res.ok) await dir.restoreInvite(code);
  return res;
}

/** Drop a just-created identity when authorization cannot be finished. */
export async function discardIdentity(env: Env, agentId: string): Promise<void> {
  const dir = directory(env);
  const rooms = await dir.rooms(agentId);
  for (const room of rooms) {
    try {
      await env.ROOM.getByName(room.room_id).fetch(new Request(new URL(`/internal/members/${encodeURIComponent(agentId)}`, 'https://internal').toString(), {
        method: 'DELETE',
        headers: { [H_TRUSTED_LEAVE]: '1' },
      }));
    } catch { /* directory delete still removes the identity */ }
  }
  await dir.deleteAgent(agentId);
}
