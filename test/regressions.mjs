// Local-only regression harness; counters are injected into a temporary bundle.
import {Miniflare,convertV4MiniflareOptions,Response,Log,LogLevel} from 'miniflare';
import {build} from 'esbuild';
import {readFileSync,mkdirSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function regressionTests() {
 mkdirSync('/tmp/aw-deploy',{recursive:true});
 await build({entryPoints:['src/index.ts'],outfile:'/tmp/aw-deploy/regression-worker.mjs',bundle:true,format:'esm',external:['cloudflare:workers'],plugins:[{name:'alarm-counters',setup(b){b.onLoad({filter:/\/room\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8').replace('  async alarm() {','  private alarmCount=0;\n  regressionCounts(){return {alarms:this.alarmCount};}\n  regressionImport(a:any,room:string){return this.dir().importAgent(a,room);}\n  async alarm() {\n    this.alarmCount++;')}));}}]});
 const config=JSON.parse(readFileSync('test/wrangler.local.jsonc','utf8'));
 const failures=[];
 for(const enabled of [true,false]) {
  let started=false,finished=false,deliveries=0;
  const mf=new Miniflare(convertV4MiniflareOptions({name:'regression-test',modules:true,modulesRoot:'/tmp/aw-deploy',scriptPath:'/tmp/aw-deploy/regression-worker.mjs',compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,log:new Log(LogLevel.ERROR),unsafeInspectDurableObjects:true,durableObjects:Object.fromEntries(config.durable_objects.bindings.map(b=>[b.name,{className:b.class_name,useSQLite:true}])),d1Databases:['DB'],kvNamespaces:['PENDING'],r2Buckets:['UNREAD'],ratelimits:Object.fromEntries(config.ratelimits.map(r=>[r.name,{namespace_id:r.namespace_id,simple:r.simple}])),bindings:{...config.vars,MIGRATION_ENABLED:String(enabled),OPERATOR_TOKEN:'fixture-operator'},outboundService:async()=>{started=true;deliveries++;await sleep(2500);finished=true;return new Response(null,{status:200});}}));
  try {
   const db=await mf.getD1Database('DB');
   for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) await db.exec(readFileSync('migrations/'+file,'utf8').replaceAll('\n',' '));
   const call=async(method,path,token,body)=>{const res=await mf.dispatchFetch('http://local'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
   const check=async(label,fn)=>{try{await fn();console.log('PASS regression: '+label);}catch(e){failures.push(label);console.log('FAIL regression: '+label+' ('+e.message+')');}};
   const room=(await call('POST','/v1/rooms')).data,path='/v1/rooms/'+room.room_id;
   if(!enabled) {
    await check('disabled migration rejects operator and room admin',async()=>{for(const token of ['fixture-operator',room.admin_token]) assert.equal((await call('POST',path+'/migrate',token)).status,403);});
    continue;
   }
   await check('migration requires operator',async()=>assert.equal((await call('POST',path+'/migrate',room.admin_token)).status,403));
   await check('migration never restores revoked hashes or deleted identities',async()=>{
    const old=(await call('POST',path+'/agents',room.admin_token,{name:'legacy'})).data;
    const fresh=(await call('POST','/v1/me/token',old.token)).data;
    assert.equal((await call('GET','/v1/me',old.token)).status,401);
    // Simulate a legacy identity present in a second old room after global deletion.
    const ns=await mf.getDurableObjectNamespace('ROOM');
    const storage=await mf.unsafeGetDurableObjectStorage('regression-test','Room',{name:room.room_id});
    const stale=await storage.exec('SELECT * FROM agents WHERE id=?',old.agent_id);
    await ns.getByName(room.room_id).regressionImport(stale[0],room.room_id);
    assert.equal((await call('GET','/v1/me',old.token)).status,401);
    const migrated=await call('POST',path+'/migrate','fixture-operator');
    assert.equal(migrated.status,200);
    assert.equal((await call('GET','/v1/me',old.token)).status,401);
    assert.equal((await call('GET','/v1/me',fresh.token)).status,200);
    await call('DELETE','/v1/me',fresh.token);
    const a=stale[0];
    await storage.exec('INSERT OR REPLACE INTO agents(id,name,token_hash,webhook_url,webhook_headers,created_at) VALUES(?,?,?,?,?,?)',a.id,a.name,a.token_hash,null,null,a.created_at);
    await call('POST',path+'/migrate','fixture-operator');
    assert.equal((await call('GET','/v1/me',old.token)).status,401);
    assert.equal(await db.prepare('SELECT 1 FROM agents WHERE id=?').bind(old.agent_id).first(),null);
   });
   await check('first legacy import is atomic and repeated imports preserve token removal',async()=>{
    const stub=(await mf.getDurableObjectNamespace('ROOM')).getByName(room.room_id);
    const legacy={id:'agent_import_fixture',name:'old',token_hash:createHash('sha256').update('fixture-legacy-import').digest('hex'),webhook_url:null,webhook_headers:null,created_at:new Date().toISOString()};
    const results=await Promise.all([stub.regressionImport(legacy,room.room_id),stub.regressionImport(legacy,room.room_id)]);
    assert.equal(results.filter(r=>r.created).length,1);
    assert.equal((await call('GET','/v1/me','fixture-legacy-import')).status,200);
    await db.prepare('DELETE FROM tokens WHERE agent_id=?').bind(legacy.id).run();
    await stub.regressionImport(legacy,room.room_id);
    assert.equal(await db.prepare('SELECT 1 FROM tokens WHERE agent_id=?').bind(legacy.id).first(),null);
   });
   await check('trimmed after ID returns retained window and unread snapshot',async()=>{
    const a=(await call('POST',path+'/agents',room.admin_token,{name:'reader'})).data;
    const b=(await call('POST',path+'/agents',room.admin_token,{name:'sender'})).data;
    const first=(await call('POST',path+'/messages',b.token,{text:'anchor'})).data.message;
    const storage=await mf.unsafeGetDurableObjectStorage('regression-test','Room',{name:room.room_id});
    await storage.exec('UPDATE agents SET last_read=? WHERE id=?',first.id,a.agent_id);
    for(let i=0;i<51;i++) await call('POST',path+'/messages',b.token,{text:'retained-'+i});
    const result=await call('GET',path+'/messages?after='+first.id+'&limit=200',a.token);
    assert.equal(result.data.messages.length,50);
    assert.equal(result.data.messages[0].text,'retained-1');
    await (await mf.getDurableObjectNamespace('ROOM')).getByName(room.room_id).fetch('http://local/internal/prime',{method:'POST'});
    const snapshot=await (await mf.getKVNamespace('PENDING')).get('room:'+room.room_id,'json');
    assert.equal(snapshot.members[a.agent_id].count,50);
    const timed=await call('GET',path+'/messages?after='+encodeURIComponent(result.data.messages[0].created_at),a.token);
    assert.equal(timed.data.messages.length,49);
   });
   await check('slow webhook has bounded alarms under concurrent sends',async()=>{
    const a=(await call('POST','/v1/agents',null,{name:'sender'})).data;
    const b=(await call('POST','/v1/agents',null,{name:'hook',webhook_url:'https://hook.invalid/slow'})).data;
    const r=(await call('POST','/v1/rooms',a.token)).data.room_id,p='/v1/rooms/'+r;
    await call('POST',p+'/members',a.token,{agent_id:b.agent_id});
    const stub=(await mf.getDurableObjectNamespace('ROOM')).getByName(r);
    const before=(await stub.regressionCounts()).alarms;
    await call('POST',p+'/messages',a.token,{text:'slow'});
    for(let i=0;i<50&&!started;i++) await sleep(100);
    assert.ok(started,'delivery started');
    await call('POST',p+'/messages',a.token,{text:'concurrent',to:a.agent_id});
    for(let i=0;i<50&&!finished;i++) await sleep(100);
    assert.ok(finished,'delivery finished');await sleep(300);
    const alarms=(await stub.regressionCounts()).alarms-before;
    console.log('slow webhook alarms='+alarms+', deliveries='+deliveries);
    assert.equal(deliveries,1);assert.ok(alarms<=2,'alarm count must be <=2, got '+alarms);
   });
  } finally {await mf.dispose();}
 }
 assert.equal(failures.length,0,'regression failures: '+failures.join('; '));
}
if(process.argv[1]?.endsWith('/regressions.mjs')) await regressionTests();
