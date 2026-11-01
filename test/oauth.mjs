import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function pkce() {
  const verifier=b64url(randomBytes(32));
  const challenge=b64url(createHash('sha256').update(verifier).digest());
  return {verifier,challenge};
}
function cookiesFrom(res) {
  const raw=typeof res.headers.getSetCookie==='function'?res.headers.getSetCookie():(res.headers.get('set-cookie')?[res.headers.get('set-cookie')]:[]);
  return raw.map(v=>v.split(';')[0]).filter(Boolean).join('; ');
}

export async function oauthTests({base}) {
 let passed=0;
 const ok=(value,label)=>{assert.ok(value,label);passed++;console.log('PASS '+label);};
 const json=async(method,path,body,headers={})=>{
  const res=await fetch(base+path,{method,headers:{...(body&&typeof body!=='string'?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  let data=null; try{data=await res.json();}catch{}
  return {status:res.status,data,headers:res.headers,res};
 };
 const issuer=new URL(base).origin;
 const mcpResource=issuer+'/mcp';
 const asMeta=await json('GET','/.well-known/oauth-authorization-server');
 ok(asMeta.status===200
  &&asMeta.data.issuer===issuer
  &&asMeta.data.authorization_endpoint===issuer+'/authorize'
  &&asMeta.data.token_endpoint===issuer+'/token'
  &&asMeta.data.registration_endpoint===issuer+'/register'
  &&asMeta.data.code_challenge_methods_supported.includes('S256')
  &&asMeta.data.grant_types_supported.includes('authorization_code')
  &&asMeta.data.grant_types_supported.includes('refresh_token')
  &&asMeta.data.token_endpoint_auth_methods_supported.includes('none')
 ,'OAuth authorization server metadata');
 const pr=await json('GET','/.well-known/oauth-protected-resource');
 const prMcp=await json('GET','/.well-known/oauth-protected-resource/mcp');
 ok(pr.status===200&&pr.data.resource===mcpResource&&Array.isArray(pr.data.authorization_servers)&&pr.data.authorization_servers.includes(issuer),'protected resource metadata at well-known root');
 ok(prMcp.status===200&&prMcp.data.resource===mcpResource&&Array.isArray(prMcp.data.authorization_servers)&&prMcp.data.authorization_servers.includes(issuer),'protected resource metadata /mcp suffix');
 const unauth=await json('POST','/mcp',{jsonrpc:'2.0',id:1,method:'initialize'});
 const challenge=unauth.headers.get('www-authenticate')||'';
 ok(unauth.status===401&&challenge.toLowerCase().includes('resource_metadata='),'MCP 401 advertises resource_metadata');
 const agent=await json('POST','/v1/agents',{name:'oauth-agent'});
 ok(agent.status===201&&agent.data.token,'oauth fixture identity');
 const init=await json('POST','/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{authorization:'Bearer '+agent.data.token});
 ok(init.status===200&&init.data.result.serverInfo.name==='Agents Hot','MCP initialize with agent bearer');
 const tools=await json('POST','/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},{authorization:'Bearer '+agent.data.token});
 ok(tools.status===200&&tools.data.result.tools.some(t=>t.name==='list_pending'),'MCP tools/list with agent bearer');
 const me=await json('POST','/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'me',arguments:{}}},{authorization:'Bearer '+agent.data.token});
 ok(me.status===200&&!me.data.result.isError&&me.data.result.content[0].text.includes(agent.data.agent_id),'MCP tools/call me');
 const registered=await json('POST','/register',{client_name:'Agents Hot Test',redirect_uris:['http://127.0.0.1/cb'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
 ok(registered.status===201&&registered.data.client_id&&!registered.data.client_secret,'dynamic client registration of a public client');
 const {verifier,challenge:codeChallenge}=pkce();
 const state='st_'+b64url(randomBytes(8));
 const authorizeUrl=new URL('/authorize',base);
 authorizeUrl.searchParams.set('response_type','code');
 authorizeUrl.searchParams.set('client_id',registered.data.client_id);
 authorizeUrl.searchParams.set('redirect_uri','http://127.0.0.1/cb');
 authorizeUrl.searchParams.set('code_challenge',codeChallenge);
 authorizeUrl.searchParams.set('code_challenge_method','S256');
 authorizeUrl.searchParams.set('state',state);
 authorizeUrl.searchParams.set('resource',mcpResource);
 authorizeUrl.searchParams.set('scope','mcp');
 const formPage=await fetch(authorizeUrl);
 const formHtml=await formPage.text();
 const handle=/name="handle" value="([^"]+)"/.exec(formHtml)?.[1];
 const nameInput=/<input[^>]*name="name"[^>]*>/.exec(formHtml)?.[0]||'';
 ok(formPage.status===200&&handle&&formHtml.includes('Existing identity token')&&formHtml.includes('Create identity')&&formHtml.includes('name="invite"')&&nameInput.includes('value=""')&&nameInput.includes('required')&&formHtml.includes('Already connected before? Use the existing token option or just reconnect—ChatGPT refreshes automatically.')&&!/[a-f0-9]{64}/.test(formHtml),'authorization page offers paste and create-identity');
 const cookie=cookiesFrom(formPage);
 const rejected=await fetch(authorizeUrl,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(cookie?{cookie}:{})},body:new URLSearchParams({handle,name:'should-not-register',decision:'approve'}).toString()});
 const rejectedHtml=await rejected.text();
 ok(rejected.status===200&&!rejected.headers.get('location')&&rejectedHtml.includes('Paste an existing identity token')&&!/[a-f0-9]{64}/.test(rejectedHtml),'paste approval without a token does not create an identity');
 const retryHandle=/name="handle" value="([^"]+)"/.exec(rejectedHtml)?.[1];
 const retryCookie=cookiesFrom(rejected)||cookie;
 const submitted=await fetch(authorizeUrl,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(retryCookie?{cookie:retryCookie}:{})},body:new URLSearchParams({handle:retryHandle,token:agent.data.token,decision:'approve'}).toString()});
 const location=submitted.headers.get('location')||'';
 const code=new URL(location).searchParams.get('code');
 ok(submitted.status===302&&code&&new URL(location).searchParams.get('state')===state,'authorization code redirect');
 const token=await json('POST','/token',new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:'http://127.0.0.1/cb',client_id:registered.data.client_id,code_verifier:verifier,resource:mcpResource}).toString(),{'content-type':'application/x-www-form-urlencoded'});
 ok(token.status===200&&token.data.access_token&&token.data.refresh_token&&token.data.token_type.toLowerCase()==='bearer','PKCE S256 token exchange issues refresh_token');
 const viaOauth=await json('POST','/mcp',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'me',arguments:{}}},{authorization:'Bearer '+token.data.access_token});
 ok(viaOauth.status===200&&!viaOauth.data.result.isError&&viaOauth.data.result.content[0].text.includes(agent.data.agent_id),'MCP tools/call with OAuth access token acts as the granted agent');
 const refreshed=await json('POST','/token',new URLSearchParams({grant_type:'refresh_token',refresh_token:token.data.refresh_token,client_id:registered.data.client_id,resource:mcpResource}).toString(),{'content-type':'application/x-www-form-urlencoded'});
 ok(refreshed.status===200&&refreshed.data.access_token&&refreshed.data.access_token!==token.data.access_token&&refreshed.data.refresh_token,'refresh_token grant rotates access token');
 const viaRefresh=await json('POST','/mcp',{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'me',arguments:{}}},{authorization:'Bearer '+refreshed.data.access_token});
 ok(viaRefresh.status===200&&!viaRefresh.data.result.isError&&viaRefresh.data.result.content[0].text.includes(agent.data.agent_id),'MCP tools/call with refreshed token acts as the same agent');
 const {verifier:verifier2,challenge:challenge2}=pkce();
 const state2='st_'+b64url(randomBytes(8));
 const reconnectUrl=new URL('/authorize',base);
 reconnectUrl.searchParams.set('response_type','code');
 reconnectUrl.searchParams.set('client_id',registered.data.client_id);
 reconnectUrl.searchParams.set('redirect_uri','http://127.0.0.1/cb');
 reconnectUrl.searchParams.set('code_challenge',challenge2);
 reconnectUrl.searchParams.set('code_challenge_method','S256');
 reconnectUrl.searchParams.set('state',state2);
 reconnectUrl.searchParams.set('resource',mcpResource);
 reconnectUrl.searchParams.set('scope','mcp');
 const reconnectPage=await fetch(reconnectUrl);
 const reconnectHtml=await reconnectPage.text();
 const reconnectHandle=/name="handle" value="([^"]+)"/.exec(reconnectHtml)?.[1];
 const reconnectCookie=cookiesFrom(reconnectPage);
 const reconnected=await fetch(reconnectUrl,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(reconnectCookie?{cookie:reconnectCookie}:{})},body:new URLSearchParams({handle:reconnectHandle,token:agent.data.token,decision:'approve'}).toString()});
 const reconnectCode=new URL(reconnected.headers.get('location')||'',base).searchParams.get('code');
 const token2=await json('POST','/token',new URLSearchParams({grant_type:'authorization_code',code:reconnectCode,redirect_uri:'http://127.0.0.1/cb',client_id:registered.data.client_id,code_verifier:verifier2,resource:mcpResource}).toString(),{'content-type':'application/x-www-form-urlencoded'});
 const viaReconnect=await json('POST','/mcp',{jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'me',arguments:{}}},{authorization:'Bearer '+token2.data.access_token});
 ok(token2.status===200&&viaReconnect.status===200&&!viaReconnect.data.result.isError&&viaReconnect.data.result.content[0].text.includes(agent.data.agent_id),'re-authorize with the same token grants the same agent');

 async function agentCount() {
  const listed=await json('GET','/v1/admin/agents',undefined,{authorization:'Bearer test-only-operator'});
  assert.equal(listed.status,200);
  return listed.data.agents.length;
 }
 async function registerClient(name) {
  const created=await json('POST','/register',{client_name:name,redirect_uris:['http://127.0.0.1/cb'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  ok(created.status===201&&created.data.client_id,'dynamic client registration for '+name);
  return created.data.client_id;
 }
 function noIdentityToken(text,label) { ok(!/[a-f0-9]{64}/.test(text),label); }
 async function begin(clientId,ip) {
  const {verifier,challenge}=pkce();
  const state='st_'+b64url(randomBytes(8));
  const url=new URL('/authorize',base);
  for (const [key,value] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:'http://127.0.0.1/cb',code_challenge:challenge,code_challenge_method:'S256',state,resource:mcpResource,scope:'mcp'})) url.searchParams.set(key,value);
  const headers=ip?{'cf-connecting-ip':ip}:{};
  const pageRes=await fetch(url,{headers});
  const html=await pageRes.text();
  noIdentityToken(html,'authorize HTML does not contain an identity token');
  const pageHandle=/name="handle" value="([^"]+)"/.exec(html)?.[1];
  ok(pageRes.status===200&&pageHandle,'authorize page rendered');
  return {url,verifier,state,html,handle:pageHandle,cookie:cookiesFrom(pageRes),headers};
 }
 async function submit(started,fields) {
  const res=await fetch(started.url,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(started.cookie?{cookie:started.cookie}:{}),...started.headers},body:new URLSearchParams({handle:started.handle,...fields}).toString()});
  const text=await res.text();
  noIdentityToken(text,'authorize response HTML does not contain an identity token');
  const location=res.headers.get('location')||'';
  noIdentityToken(location,'authorize redirect does not contain an identity token');
  return {status:res.status,text,location,retry:res.headers.get('retry-after')};
 }
 async function exchange(clientId,code,verifier) {
  return json('POST','/token',new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:'http://127.0.0.1/cb',client_id:clientId,code_verifier:verifier,resource:mcpResource}).toString(),{'content-type':'application/x-www-form-urlencoded'});
 }
 async function whoami(access) {
  const via=await json('POST','/mcp',{jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'me',arguments:{}}},{authorization:'Bearer '+access});
  let body=null; try { body=JSON.parse(via.data.result.content[0].text); } catch {}
  return {via,body};
 }

 const createClient=await registerClient('Create Identity Test');
 const beforeCreate=await agentCount();
 const creating=await begin(createClient,'198.51.100.21');
 ok(creating.html.includes('Create identity')&&creating.html.includes('Existing identity token')&&/<input[^>]*name="name"[^>]*value=""/.test(creating.html),'create-identity form starts with an empty name');
 const createdPost=await submit(creating,{decision:'create',name:'oauth-created'});
 const createdCode=new URL(createdPost.location,base).searchParams.get('code');
 ok(createdPost.status===302&&createdCode&&new URL(createdPost.location,base).searchParams.get('state')===creating.state,'create-identity authorization code redirect');
 const createdToken=await exchange(createClient,createdCode,creating.verifier);
 ok(createdToken.status===200&&createdToken.data.access_token&&createdToken.data.refresh_token&&!/[a-f0-9]{64}/.test(JSON.stringify(createdToken.data)),'PKCE exchange after create-identity does not return the identity token');
 const createdMe=await whoami(createdToken.data.access_token);
 ok(createdMe.via.status===200&&!createdMe.via.data.result.isError&&createdMe.body.name==='oauth-created'&&createdMe.body.agent_id,'MCP tools/call me returns the new agent name');
 ok((await agentCount())===beforeCreate+1,'create-identity registers one agent');
 const createdRefresh=await json('POST','/token',new URLSearchParams({grant_type:'refresh_token',refresh_token:createdToken.data.refresh_token,client_id:createClient,resource:mcpResource}).toString(),{'content-type':'application/x-www-form-urlencoded'});
 const refreshedMe=await whoami(createdRefresh.data.access_token);
 ok(createdRefresh.status===200&&createdRefresh.data.access_token!==createdToken.data.access_token&&refreshedMe.body.agent_id===createdMe.body.agent_id&&(await agentCount())===beforeCreate+1,'refresh keeps the same agent_id and does not create an identity');

 const room=await json('POST','/v1/rooms',undefined,{authorization:'Bearer '+agent.data.token});
 const invite=await json('POST','/v1/rooms/'+room.data.room_id+'/invites',{uses:1,ttl_seconds:3600},{authorization:'Bearer '+agent.data.token});
 ok(room.status===200&&room.data.room_id&&invite.status===201&&invite.data.code,'invite for oauth create-identity');
 const inviteClient=await registerClient('Invite Identity Test');
 const beforeInvite=await agentCount();
 const blank=await submit(await begin(inviteClient,'198.51.100.22'),{decision:'create',name:'   '});
 ok(blank.status===200&&blank.text.includes('name required'),'create-identity requires a name');
 const longName=await submit(await begin(inviteClient,'198.51.100.22'),{decision:'create',name:'x'.repeat(65)});
 ok(longName.status===200&&longName.text.includes('name too long'),'create-identity rejects a name over 64 characters');
 const badInvite=await submit(await begin(inviteClient,'198.51.100.22'),{decision:'create',name:'should-not-exist',invite:'inv_not_real'});
 ok(badInvite.status===200&&badInvite.text.includes('invite invalid or expired')&&(await agentCount())===beforeInvite,'invalid invite fails without creating an identity');
 const joining=await begin(inviteClient,'198.51.100.22');
 const joinedPost=await submit(joining,{decision:'create',name:'oauth-invited',invite:invite.data.code});
 const joinedCode=new URL(joinedPost.location,base).searchParams.get('code');
 const joinedToken=await exchange(inviteClient,joinedCode,joining.verifier);
 const joinedMe=await whoami(joinedToken.data.access_token);
 ok(joinedPost.status===302&&joinedMe.body.name==='oauth-invited'&&joinedMe.body.rooms.some(r=>r.room_id===room.data.room_id),'invite code joins the new identity to the room');

 const rateClient=await registerClient('Rate Limit Test');
 const beforeRate=await agentCount();
 let made=0, blocked=null;
 for (let i=0;i<5;i++) {
  const started=await begin(rateClient,'198.51.100.24');
  const posted=await submit(started,{decision:'create',name:'rate-'+i});
  if (posted.status===429) { blocked=posted; break; }
  assert.equal(posted.status,302);
  made++;
 }
 ok(made===3&&blocked&&blocked.text.includes('Too many')&&Number(blocked.retry)>=1&&Number(blocked.retry)<=3600&&(await agentCount())===beforeRate+made,'create-identity rate limit returns 429');
 let postLimited=null, leaked=false;
 for (let i=0;i<40;i++) {
  const res=await fetch(new URL('/authorize',base),{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'198.51.100.25'},body:'decision=deny'});
  const text=await res.text();
  if (/[a-f0-9]{64}/.test(text)) leaked=true;
  if (res.status===429) { postLimited={i,text,retry:res.headers.get('retry-after'),type:res.headers.get('content-type')||''}; break; }
 }
 ok(postLimited&&postLimited.i===30&&!leaked&&postLimited.text.includes('Too many')&&postLimited.type.includes('text/html')&&postLimited.retry==='60','authorize POST rate limit returns 429');
 console.log(`OAUTH TESTS PASS (${passed} checks)`);
}
