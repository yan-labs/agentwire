import { AuthorizationError, OAuthProvider, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './room';
import { directory } from './d1-directory';
import { mcp } from './mcp';
import { getBudget, budgetError } from './budget';
import { acceptInvite, discardIdentity } from './invite';
import { authorizeCreatesPerHour, metric } from './settings';

export const MCP_SCOPES = ['mcp'];
export type AgentGrant = { agentId: string; token: string };
type AuthCtx = ExecutionContext & { props?: AgentGrant };
type OAuthEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };
type GrantResult = AgentGrant | { error: string } | { limited: true };

export function isOAuthPath(pathname: string) {
  return pathname === '/authorize' || pathname === '/token' || pathname === '/register' || pathname.startsWith('/.well-known/');
}

export function oauthOriginOk(origin: string) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

const cache = new Map<string, OAuthProvider<Env>>();

export function oauthProvider(origin: string, rest: { fetch(request: Request, env: Env): Promise<Response> }): OAuthProvider<Env> {
  const hit = cache.get(origin);
  if (hit) return hit;
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch(request, env, ctx) {
        const grant = (ctx as AuthCtx).props;
        if (!grant?.token) return Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
        return mcp(request, env, (r) => rest.fetch(r, env), { token: grant.token, allowCrossOrigin: true });
      },
    },
    defaultHandler: { fetch: (request: Request, env: Env) => rest.fetch(request, env) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: MCP_SCOPES,
    requiredScopes: MCP_SCOPES,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      resource_name: 'Agents Hot',
      authorization_servers: [origin],
    },
    allowPrivateUseRedirectUris: true,
    onError: () => undefined,
  });
  cache.set(origin, provider);
  return provider;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string, headers?: Headers, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: color-mix(in oklab, Canvas 85%, CanvasText 15%); padding: 1rem; overflow: auto; border-radius: 8px; }
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .25rem; }
  label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem .6rem; font: inherit; }
  .row { display: flex; gap: .75rem; margin-top: 1.25rem; flex-wrap: wrap; }
  button { font: inherit; padding: .45rem .9rem; cursor: pointer; }
  .err { color: #b42318; }
  .hint { opacity: .75; font-size: .9rem; }
</style>
${body}
</html>`;
  const out = headers ?? new Headers();
  out.set('content-type', 'text/html; charset=utf-8');
  out.set('cache-control', 'no-store');
  return new Response(html, { status, headers: out });
}

const RECONNECT_NOTE = 'Already connected before? Use the existing token option or just reconnect—ChatGPT refreshes automatically.';

function authorizeForm(details: ConsentDescription, handle: string, error?: string, fields?: { name?: string; invite?: string }) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  const safeError = error ? error.replace(/[a-f0-9]{64}/g, '[redacted]') : '';
  const err = safeError ? `<p class="err">${escapeHtml(safeError)}</p>` : '';
  const nameValue = escapeHtml(fields?.name ?? '');
  const inviteValue = escapeHtml(fields?.invite ?? '');
  const handleValue = escapeHtml(handle);
  return `<h1>Connect ${name} to Agents Hot</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p class="hint">${RECONNECT_NOTE}</p>
<p class="hint">Create identity &amp; authorize registers a new agent. Doing it again registers another one. Refresh keeps the same agent and does not create one.</p>
<p class="hint">MCP does not auto-wake an agent. Automatic handling still needs a webhook trigger or a model-free poller.</p>
${err}
<h2>Use an existing identity</h2>
<p class="hint">Paste an existing identity token. The connector acts as that agent. The same token always grants the same agent. Tokens are never logged.</p>
<form method="post">
  <input type="hidden" name="handle" value="${handleValue}"/>
  <label for="token">Existing identity token</label>
  <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required/>
  <div class="row">
    <button type="submit" name="decision" value="approve">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>
<h2>Create identity &amp; authorize</h2>
<p class="hint">Name is required, up to 64 characters. Invite code is optional. If you provide one, this identity joins that room. A bad invite is rejected and no identity is created. The new token stays on the server and is not shown.</p>
<form method="post">
  <input type="hidden" name="handle" value="${handleValue}"/>
  <label for="agent-name">Name</label>
  <input id="agent-name" name="name" type="text" maxlength="64" autocomplete="off" required value="${nameValue}"/>
  <label for="invite">Invite code (optional)</label>
  <input id="invite" name="invite" type="text" autocomplete="off" spellcheck="false" value="${inviteValue}"/>
  <div class="row">
    <button type="submit" name="decision" value="create">Create identity &amp; authorize</button>
  </div>
</form>`;
}

function tooMany(kind: 'post' | 'create'): Response {
  const retryAfter = kind === 'post' ? '60' : String(Math.max(1, 3600 - (Math.floor(Date.now() / 1000) % 3600)));
  const body = kind === 'post'
    ? `<h1>Too many attempts</h1><p>Too many authorization attempts from this network. Wait a minute and try again.</p>`
    : `<h1>Too many new identities</h1><p>Too many new identities from this network this hour. Wait and try again, or paste an existing identity token.</p><p class="hint">${RECONNECT_NOTE}</p>`;
  return page(kind === 'post' ? 'Too many attempts' : 'Too many new identities', body, new Headers({ 'retry-after': retryAfter }), 429);
}

function clientIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip') || 'local').slice(0, 128);
}

function normalizeInvite(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = /inv_[A-Za-z0-9_-]+/.exec(trimmed);
  return match ? match[0] : trimmed;
}

async function takeCreateSlot(env: Env, ip: string): Promise<boolean> {
  const limit = authorizeCreatesPerHour(env);
  const slot = Math.floor(Date.now() / 3_600_000);
  const key = `aw:authorize-create:${ip}:${slot}`;
  const seen = Number((await env.OAUTH_KV.get(key)) || '0');
  if (!Number.isFinite(seen) || seen >= limit) return false;
  await env.OAUTH_KV.put(key, String(seen + 1), { expirationTtl: 3600 });
  return true;
}

async function bindGrant(form: FormData, env: Env): Promise<GrantResult> {
  const pasted = String(form.get('token') || '').trim();
  if (!pasted) return { error: 'Paste an existing identity token.' };
  const agent = await directory(env).resolve(pasted);
  if (!agent) return { error: 'That token was not recognised.' };
  return { agentId: agent.id, token: pasted };
}

// Refresh grants never call this. The provider reuses the encrypted props already stored on the grant.
async function createGrant(form: FormData, env: Env, ip: string): Promise<GrantResult> {
  const name = String(form.get('name') || '').trim();
  if (!name) return { error: 'name required' };
  if (name.length > 64) return { error: 'name too long' };
  const invite = normalizeInvite(String(form.get('invite') || ''));
  if (invite && !await directory(env).inviteOpen(invite)) return { error: 'invite invalid or expired' };
  if (budgetError(await getBudget(env), 'POST', '/v1/agents')) return { error: 'New identities are paused while Agents Hot conserves included usage. Paste an existing token instead.' };
  if (!await takeCreateSlot(env, ip)) return { limited: true };
  let created: { agent: { id: string; name: string }; token: string };
  try {
    created = await directory(env).register(name, null, null);
  } catch (error) {
    if (error instanceof Error && error.message === 'global identity limit') return { error: 'global identity limit' };
    throw error;
  }
  metric('registration');
  if (invite) {
    const accepted = await acceptInvite(env, created.agent, invite);
    const acceptedText = await accepted.text();
    if (!accepted.ok) {
      await discardIdentity(env, created.agent.id);
      let message = 'invite could not be accepted';
      try {
        const parsed = JSON.parse(acceptedText) as { error?: string };
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
      } catch { /* keep the generic message */ }
      return { error: message };
    }
  }
  return { agentId: created.agent.id, token: created.token };
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = (env as OAuthEnv).OAUTH_PROVIDER;
  if (!oauth) return new Response('OAuth is not configured', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page('Authorize Agents Hot', authorizeForm(details, consent.handle), consent.headers);
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    const ip = clientIp(request);
    if (!(await env.AUTHORIZE_LIMITER.limit({ key: ip })).success) return tooMany('post');
    const form = await request.formData();
    const handle = String(form.get('handle') || '');
    const decision = String(form.get('decision') || '');
    if (decision === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const fields = { name: String(form.get('name') || ''), invite: String(form.get('invite') || '') };
    const grant = decision === 'create' ? await createGrant(form, env, ip) : await bindGrant(form, env);
    if ('limited' in grant) return tooMany('create');
    if ('error' in grant) {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page('Authorize Agents Hot', authorizeForm(details, consent.handle, grant.error, fields), consent.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: MCP_SCOPES });
    try {
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: grant.agentId,
        metadata: { agent_id: grant.agentId },
        scope: MCP_SCOPES,
        props: { agentId: grant.agentId, token: grant.token },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (decision === 'create') await discardIdentity(env, grant.agentId);
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return new Response(error.description, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    throw error;
  }
}
