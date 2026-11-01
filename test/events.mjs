import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';

export async function eventsTests(options) {
 const off=new Miniflare(convertV4MiniflareOptions({...options,bindings:{...options.bindings,MCP_EVENTS_EGRESS:'off'}}));
 try {const db=await off.getD1Database('DB');await db.exec((readFileSync('migrations/0001_directory.sql','utf8')+readFileSync('migrations/0002_identity_imports.sql','utf8')).replaceAll('\n',' '));const base=String(await off.ready).replace(/\/$/,'');const register=await fetch(base+'/v1/agents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'off-test'})});const agent=await register.json();const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${agent.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'message.created',arguments:{},delivery:{mode:'webhook',url:'https://callback.example',secret:'whsec_'+Buffer.alloc(32).toString('base64')}}})});assert.equal((await response.json()).error.data.reason,'egress_unavailable');} finally {await off.dispose();}
 let mode='ok'; const deliveries=[];
 const mf=new Miniflare(convertV4MiniflareOptions({...options,bindings:{...options.bindings,MCP_EVENTS_EGRESS:'validated-fetch'},outboundService:async req=>{
  const u=new URL(req.url);
  if(u.hostname==='cloudflare-dns.com') return MFResponse.json({Status:0,Answer:u.searchParams.get('type')==='A'?[{type:1,data:u.searchParams.get('name')==='private.example'?'127.0.0.1':'8.8.8.8'}]:[]});
  if(u.hostname.endsWith('.example')) {const body=await req.text();const data=JSON.parse(body);if(data.type==='verification') {if(u.hostname==='redirect.example') return new MFResponse(null,{status:302,headers:{location:'https://other.example'}});return MFResponse.json({challenge:u.hostname==='bad.example'?'wrong':data.challenge});}deliveries.push({body,data,headers:Object.fromEntries(req.headers)});return new MFResponse(null,{status:mode==='ok'?200:mode==='gone'?410:500});}
  throw Error(`unexpected ${req.url}`);
 }}));
 try {
  const db=await mf.getD1Database('DB');await db.exec((readFileSync('migrations/0001_directory.sql','utf8')+readFileSync('migrations/0002_identity_imports.sql','utf8')).replaceAll('\n',' '));const base=String(await mf.ready).replace(/\/$/,'');
  const call=async(method,path,token,body)=>{const r=await fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return r.json();};
  const a=await call('POST','/v1/agents',null,{name:'events-a'}),b=await call('POST','/v1/agents',null,{name:'events-b'});const room=(await call('POST','/v1/rooms',a.token,{})).room_id;await call('POST',`/v1/rooms/${room}/members`,a.token,{agent_id:b.agent_id});
  const rpc=async(method,params={})=>call('POST','/mcp',b.token,{jsonrpc:'2.0',id:1,method,params});
  assert.deepEqual((await rpc('initialize')).result.capabilities.events,{});assert.equal((await rpc('events/list')).result.events[0].name,'message.created');
  const secret='whsec_'+Buffer.alloc(32,7).toString('base64');const p={name:'message.created',arguments:{room_id:room},delivery:{mode:'webhook',url:'https://callback.example/hook',secret}};
  assert.equal((await rpc('events/subscribe',{...p,delivery:{...p.delivery,secret:'bad'}})).error.code,-32602);
  assert.equal((await rpc('events/subscribe',{...p,delivery:{...p.delivery,url:'http://callback.example'}})).error.code,-32602);
  for(const [host,reason] of [['private.example','blocked_destination'],['redirect.example','http_error'],['bad.example','challenge_failed']]) assert.equal((await rpc('events/subscribe',{...p,delivery:{...p.delivery,url:`https://${host}/`}})).error.data.reason,reason);
  const sub=(await rpc('events/subscribe',p)).result;assert.ok(sub.id.startsWith('sub_'));assert.equal((await rpc('events/subscribe',p)).result.id,sub.id);
  await call('POST',`/v1/rooms/${room}/messages`,b.token,{text:'own @all'});await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'not addressed'});await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'hello',to:b.agent_id});
  for(let i=0;i<50&&deliveries.length<1;i++) await new Promise(r=>setTimeout(r,100));assert.equal(deliveries.length,1);const d=deliveries[0];assert.equal(d.data.data.text,'hello');assert.equal(d.headers['webhook-signature'],'v1,'+createHmac('sha256',Buffer.alloc(32,7)).update(`${d.headers['webhook-id']}.${d.headers['webhook-timestamp']}.${d.body}`).digest('base64'));
  mode='fail'; await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'retry',to:b.agent_id});
  for(let i=0;i<50&&deliveries.length<2;i++) await new Promise(r=>setTimeout(r,100));assert.equal(deliveries.length,2);const retryId=deliveries[1].data.eventId;mode='ok';
  for(let i=0;i<340&&deliveries.length<3;i++) await new Promise(r=>setTimeout(r,100));assert.equal(deliveries.length,3);assert.equal(deliveries[2].data.eventId,retryId);
  mode='gone'; await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'gone',to:b.agent_id});
  for(let i=0;i<50&&deliveries.length<4;i++) await new Promise(r=>setTimeout(r,100));assert.equal(deliveries.length,4);
  await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'after gone',to:b.agent_id});await new Promise(r=>setTimeout(r,500));assert.equal(deliveries.length,4);
  mode='ok';await rpc('events/subscribe',p);
  await rpc('events/unsubscribe',{id:sub.id});await call('POST',`/v1/rooms/${room}/messages`,a.token,{text:'after unsubscribe',to:b.agent_id});await new Promise(r=>setTimeout(r,500));assert.equal(deliveries.length,4);
  console.log('PASS MCP Events integration');
 } finally {await mf.dispose();}
}
