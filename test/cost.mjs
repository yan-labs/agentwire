// Local synthetic workload. Instruments a temporary bundle only; never a production request.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Response,Log,LogLevel} from 'miniflare';
mkdirSync('/tmp/aw-integrate',{recursive:true});
await build({entryPoints:['src/index.ts'],outfile:'/tmp/aw-integrate/cost-worker.mjs',bundle:true,format:'esm',conditions:['workerd','worker','browser'],mainFields:['browser','module','main'],external:['cloudflare:workers'],plugins:[{name:'temporary-counters',setup(b){b.onLoad({filter:/\/room\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8').replaceAll('this.ctx.storage.sql.exec','this.profileExec').replace('export class Room extends DurableObject<Env> {',`export class Room extends DurableObject<Env> {
 private profileCalls=0;
 private profileCursors:any[]=[];
 private profileExec(...args:any[]) {const cursor=this.ctx.storage.sql.exec(...args);this.profileCursors.push(cursor);return cursor;}
 async profile(){return {calls:this.profileCalls,read:this.profileCursors.reduce((n,c)=>n+c.rowsRead,0),written:this.profileCursors.reduce((n,c)=>n+c.rowsWritten,0)};}
`).replace('  async fetch(request: Request): Promise<Response> {','  async fetch(request: Request): Promise<Response> {\n    this.profileCalls++;')}));}}]});
const config=JSON.parse(readFileSync('test/wrangler.local.jsonc','utf8'));
const mf=new Miniflare(convertV4MiniflareOptions({name:'cost-test',modules:true,modulesRoot:'/tmp/aw-integrate',scriptPath:'/tmp/aw-integrate/cost-worker.mjs',compatibilityDate:'2026-05-03',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),durableObjects:Object.fromEntries(config.durable_objects.bindings.map(b=>[b.name,{className:b.class_name,useSQLite:true}])),d1Databases:['DB'],kvNamespaces:['PENDING'],r2Buckets:['UNREAD'],ratelimits:Object.fromEntries(config.ratelimits.map(r=>[r.name,{namespace_id:r.namespace_id,simple:{limit:10000,period:60}}])),bindings:{...config.vars},outboundService:async()=>new Response(null,{status:200})}));
try {
 const db=await mf.getD1Database('DB');await db.exec((readFileSync('migrations/0001_directory.sql','utf8')+readFileSync('migrations/0002_identity_imports.sql','utf8')).replaceAll('\n',' '));
 const ns=await mf.getDurableObjectNamespace('ROOM');
 const call=async(method,path,token,body)=>{const r=await mf.dispatchFetch('http://local'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
 const cases=[];
 for(const batched of [false,true]) {
  const agents=[];for(let i=0;i<3;i++)agents.push(await call('POST','/v1/agents',null,{name:'cost-'+i,webhook_url:i>=1?'https://hook.invalid/ok':null}));
  const room=(await call('POST','/v1/rooms',agents[0].token)).room_id,path='/v1/rooms/'+room;
  for(const a of agents.slice(1))await call('POST',path+'/members',agents[0].token,{agent_id:a.agent_id});
  const stub=ns.get(ns.idFromName(room));const before=await stub.profile();
  for(let i=0;i<50;i+=batched?10:1) {
   if(batched)await call('POST',path+'/messages/batch',agents[0].token,{messages:Array.from({length:10},(_,n)=>({text:'message '+(i+n)}))});
   else await call('POST',path+'/messages',agents[0].token,{text:'message '+i});
   for(const a of agents) {
    const result=await call('GET',path+'/messages'+(batched?'?ack=true':''),a.token);
    if(!batched&&result.messages.length)await call('POST',path+'/read',a.token,{id:result.messages.at(-1).id});
   }
  }
  await new Promise(r=>setTimeout(r,250));const after=await stub.profile();
  cases.push({name:batched?'batch10_read_ack':'legacy_send_read_ack',messages:50,room_http_calls:after.calls-before.calls,do_rows_read:after.read-before.read,do_rows_written:after.written-before.written});
 }
 assert.ok(cases.every(c=>Number.isFinite(c.do_rows_read)&&c.do_rows_written>0),'SQL profiling must return actual counts');
 assert.ok(cases[1].room_http_calls*5<cases[0].room_http_calls,'batch workload should reduce room calls at least fivefold');
 writeFileSync('/tmp/aw-integrate/cost.json',JSON.stringify(cases,null,2));console.log('COST BENCHMARK '+JSON.stringify(cases));
}finally{await mf.dispose();}
