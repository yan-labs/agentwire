import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
const PROTECTED='room_cdc26cdd5dab08d7f63427a8';
export async function integrateTests(options) {
 let gate=false,gateWrites=0,protectedHooks=0;
 const mf=new Miniflare(convertV4MiniflareOptions({...options,name:'integrate-test',bindings:{...options.bindings,BUDGET_ENABLED:'true',BILLING_ALERT_SECRET:'fake-billing',CF_GUARD_TOKEN:'fake-guard',CF_ZONE_ID:'fake-zone',WAF_RULESET_ID:'fake-ruleset',WAF_RULE_ID:'fake-rule',WAF_API_EXPRESSION:'fake-expression'},outboundService:async req=>{
  if(new URL(req.url).hostname==='api.cloudflare.com') {if(req.method==='PATCH') {gate=(await req.json()).enabled;gateWrites++;}return MFResponse.json({success:true,result:{enabled:gate}});}
  if(new URL(req.url).hostname==='hook.invalid'){protectedHooks++;return new MFResponse(null,{status:200});}
  return options.outboundService(req);
 }}));
 let count=0;const ok=(v,label)=>{assert.ok(v,label);count++;console.log('PASS '+label);};
 const host='https://agentwire.kanchaishaoxia.workers.dev';
 async function call(method,path,token,body,origin=host,headers={}) {
  const r=await mf.dispatchFetch(origin+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:[101,204].includes(r.status)?null:await r.json(),headers:r.headers,webSocket:r.webSocket};
 }
 try {
  const db=await mf.getD1Database('DB');await db.exec(readFileSync('migrations/0001_directory.sql','utf8').replaceAll('\n',' '));
  ok(JSON.parse(readFileSync('wrangler.jsonc','utf8')).workers_dev===true,'production workers.dev remains enabled');
  ok(JSON.parse(readFileSync('ops/edge-rules.json','utf8')).emergency_rule.expression===JSON.parse(readFileSync('wrangler.jsonc','utf8')).vars.WAF_API_EXPRESSION,'WAF template matches runtime and exempts billing control paths');
  const ns=await mf.getDurableObjectNamespace('ROOM'),kv=await mf.getKVNamespace('PENDING');
  const a=(await call('POST','/v1/agents',null,{name:'来财'})).data,b=(await call('POST','/v1/agents',null,{name:'Muse'})).data,c=(await call('POST','/v1/agents',null,{name:'dot'})).data,outsider=(await call('POST','/v1/agents',null,{name:'outsider'})).data;
  const stub=ns.get(ns.idFromName(PROTECTED));
  await stub.fetch('http://local/internal/create',{method:'POST',body:JSON.stringify({room_id:PROTECTED,owner_id:a.agent_id,owner_name:'来财'})});
  await call('POST',`/v1/rooms/${PROTECTED}/members`,a.token,{agent_id:b.agent_id});
  await call('POST',`/v1/rooms/${PROTECTED}/members`,a.token,{agent_id:c.agent_id});
  await stub.fetch('http://local/internal/prime',{method:'POST'});
  const path=`/v1/rooms/${PROTECTED}`;
  const config=await call('GET','/v1/public-config');ok(config.data.limits.max_messages===50&&config.data.max_messages===50,'public-config supports nested limits and legacy flat fields');
  const preflight=await call('OPTIONS',path+'/messages',null,undefined,'https://api.agents.hot',{origin:'https://agents.hot','access-control-request-method':'POST'});
  ok(preflight.status===204&&preflight.headers.get('access-control-allow-headers').includes('authorization'),'zone API preflight allows identity bearer and JSON');
  const sent=await call('POST',path+'/messages',a.token,{text:'same-origin send'},'https://agents.hot',{origin:'https://agents.hot'});
  ok(sent.status===201&&sent.headers.get('access-control-allow-origin')==='*','console same-origin send works with identity token');
  const batch=await call('POST',path+'/messages/batch',a.token,{messages:[{text:'batch one'},{text:'batch two'}]});
  ok(batch.data.processed===2&&batch.data.results.every(r=>r.status===201),'one DO batch accepts two independently validated messages');
  const partial=await call('POST',path+'/messages/batch',a.token,{messages:[{text:'accepted'},{text:''},{text:'not processed'}]});
  ok(partial.data.processed===2&&partial.data.results[1].status===400,'batch failure gives explicit partial receipt and stops');
  ok((await call('POST',path+'/messages/batch',outsider.token,{messages:[{text:'no'}]})).data.results[0].status===401,'batch does not bypass membership');
  await call('GET',path+'/messages?ack=true',b.token);await call('GET',path+'/messages?ack=true',c.token);
  const keep=await call('GET',path+'/messages',a.token);ok(keep.data.messages.length>0,'plain console reads do not acknowledge');
  await call('GET',path+'/messages?ack=true',a.token);
  ok((await call('GET',path+'/messages',a.token)).data.messages.length===0,'atomic read+ack prunes only after all readers');
  const wsres=await call('GET',path+'/ws',a.token,undefined,host,{upgrade:'websocket'}),ws=wsres.webSocket;
  ws.accept();
  let seq=0;const inbox=[];ws.addEventListener('message',e=>inbox.push(JSON.parse(e.data)));
  const command=async frame=>{
   const id=String(++seq);ws.send(JSON.stringify({...frame,id}));
   for(let i=0;i<100;i++){const result=inbox.find(x=>x.type==='result'&&x.id===id);if(result)return result;await new Promise(r=>setTimeout(r,20));}assert.fail('WS command timeout');
  };
  ok((await command({type:'send',text:'hibernating send'})).status===201,'hibernating WS send reuses message validation');
  ok((await call('GET',path+'/messages?after='+partial.data.results[0].data.message.id,a.token)).data.messages.length===1,'read cursor still resumes after acknowledged message was pruned');
  const read=await command({type:'read',ack:true});ok(read.status===200&&read.data.messages.length===1,'hibernating WS read and ack share one frame');
  ok((await command({type:'send',text:''})).status===400,'WS invalid content rejected');ws.close();
  ok((await call('POST','/internal/billing-alert',null,{},host,{'cf-webhook-auth':'wrong'})).status===403,'forged billing webhook rejected');
  const stopped=await call('POST','/internal/billing-alert',null,{},host,{'cf-webhook-auth':'fake-billing'});
  ok(stopped.status===200&&gate&&gateWrites===1,'authenticated billing alert activates WAF with verified readback');
  // Each isolated request gets the new budget state; avoid the previous warm 60s cache in this fixture.
  await mf.setOptions(convertV4MiniflareOptions({...options,name:'integrate-test',bindings:{...options.bindings,BUDGET_ENABLED:'true',BILLING_ALERT_SECRET:'fake-billing',CF_GUARD_TOKEN:'fake-guard',CF_ZONE_ID:'fake-zone',WAF_RULESET_ID:'fake-ruleset',WAF_RULE_ID:'fake-rule',WAF_API_EXPRESSION:'fake-expression'},outboundService:async req=>{if(new URL(req.url).hostname==='api.cloudflare.com'){if(req.method==='PATCH')gate=(await req.json()).enabled;return MFResponse.json({success:true,result:{enabled:gate}});}if(new URL(req.url).hostname==='hook.invalid'){protectedHooks++;return new MFResponse(null,{status:200});}return options.outboundService(req);}}));
  for(const member of [a,b,c]) ok((await call('GET','/v1/me',member.token)).status===200,'protected member identity survives stop');
  ok((await call('GET','/v1/me',outsider.token)).status===503,'unprotected identity blocked on workers.dev');
  ok((await call('PATCH','/v1/me',b.token,{webhook_url:'https://hook.invalid/continue'})).status===200,'protected webhook configuration survives stop');
  ok((await call('POST',path+'/messages',a.token,{text:'protected continuity'})).status===201,'protected room sends during stop');
  for(let i=0;i<100&&!protectedHooks;i++) await new Promise(r=>setTimeout(r,20));
  ok(protectedHooks>0,'protected webhook actually delivers during budget stop');
  ok((await call('GET',path+'/messages',b.token)).status===200,'protected room reads during stop');
  ok((await call('GET',path+'/pending/'+b.agent_id)).status===200,'protected public pending survives stop');
  ok((await call('POST','/v1/rooms',a.token)).status===503,'protected identity cannot allocate during stop');
  ok((await call('POST',path+'/messages',outsider.token,{text:'attack'})).status===503,'outsider cannot use protected room exception');
  ok((await call('GET','/health')).status===503,'unprotected workers.dev endpoints return 503');
  const rotated=await call('POST','/v1/me/token',c.token);
  ok(rotated.status===200&&(await call('GET','/v1/me',rotated.data.token)).status===200,'protected token rotation survives stop');
  const restore=await call('POST','/internal/billing-restore','test-only-operator');
  ok(restore.status===200&&!gate,'operator restore bypasses closed API gate');
 } finally {await mf.dispose();}
 const readonly=new Miniflare(convertV4MiniflareOptions({...options,name:'read-only-test',bindings:{...options.bindings,BUDGET_ENABLED:'true'}}));
 try {
  await (await readonly.getD1Database('DB')).exec(readFileSync('migrations/0001_directory.sql','utf8').replaceAll('\n',' '));
  await (await readonly.getKVNamespace('PENDING')).put('budget',JSON.stringify({level:3,month:'2026-10',reason:'fixture'}));
  const ack=await readonly.dispatchFetch('http://local/v1/rooms/missing/messages?ack=true');
  const plain=await readonly.dispatchFetch('http://local/v1/rooms/missing/messages');
  ok(ack.status===503&&plain.status===404,'read-only budget blocks GET acknowledgement writes while allowing plain reads');
 } finally {await readonly.dispose();}
 console.log(`INTEGRATE TESTS PASS (${count} checks)`);
}
