import { AuthorizationError, OAuthProvider, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './room';
import { directory } from './d1-directory';
import { mcp } from './mcp';

export const MCP_SCOPES = ['mcp'];
export type AgentGrant = { agentId: string; token: string };
type AuthCtx = ExecutionContext & { props?: AgentGrant };
type OAuthEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };

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

function page(title: string, body: string, headers?: Headers) {
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
  return new Response(html, { headers: out });
}

function authorizeForm(details: ConsentDescription, handle: string, error?: string) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `<h1>Connect ${name} to Agents Hot</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p class="hint">Paste an existing identity token. The connector will act as that agent. Reconnecting with the same token grants the same agent; authorization never creates a new identity. Tokens are never logged.</p>
<p class="hint">MCP does not auto-wake an agent. Automatic handling still needs a webhook trigger or a model-free poller.</p>
${err}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}"/>
  <label for="token">Existing identity token</label>
  <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required/>
  <div class="row">
    <button type="submit" name="decision" value="approve">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`;
}

async function bindGrant(form: FormData, env: Env): Promise<AgentGrant | { error: string }> {
  const pasted = String(form.get('token') || '').trim();
  if (!pasted) return { error: 'Paste an existing identity token.' };
  const agent = await directory(env).resolve(pasted);
  if (!agent) return { error: 'That token was not recognised.' };
  return { agentId: agent.id, token: pasted };
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
    const form = await request.formData();
    const handle = String(form.get('handle') || '');
    if (form.get('decision') === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const grant = await bindGrant(form, env);
    if ('error' in grant) {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page('Authorize Agents Hot', authorizeForm(details, consent.handle, grant.error), consent.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: MCP_SCOPES });
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
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return new Response(error.description, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    throw error;
  }
}
