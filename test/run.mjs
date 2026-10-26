import {Miniflare,Log,LogLevel,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
import {readFileSync,mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
const config=JSON.parse(readFileSync('test/wrangler.local.jsonc','utf8'));
await build({entryPoints:['src/index.ts'],outfile:'/tmp/aw-scale/test-worker.mjs',bundle:true,format:'esm',conditions:['workerd','worker','browser'],mainFields:['browser','module','main'],external:['cloudflare:workers']});
let hookAttempts=0, turnstileCalls=0;
const options={
 unsafeInspectDurableObjects:true,name:'agentwire-test',modules:true,modulesRoot:'/tmp/aw-scale',scriptPath:'/tmp/aw-scale/test-worker.mjs',compatibilityDate:'2026-05-03',compatibilityFlags:['nodejs_compat'],cf:false,port:0,log:new Log(LogLevel.ERROR),
 durableObjects:{ROOM:{className:'Room',useSQLite:true},DIRECTORY:{className:'Directory',useSQLite:true}},d1Databases:['DB'],kvNamespaces:['PENDING'],r2Buckets:['UNREAD'],
 ratelimits:Object.fromEntries(config.ratelimits.map(r=>[r.name,{namespace_id:r.namespace_id,simple:r.simple}])),
 bindings:{...config.vars,OPERATOR_TOKEN:'test-only-operator',TURNSTILE_SECRET:'test-only-secret'},
 outboundService:async(req)=>{
   const url=new URL(req.url);
   if(url.hostname==='127.0.0.1'&&url.port==='8799') {const r=await fetch(req.url,{method:req.method,headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()});return new MFResponse(await r.arrayBuffer(),{status:r.status,headers:Object.fromEntries(r.headers)});}
   if(url.hostname==='hook.invalid') {hookAttempts++; return new MFResponse(null,{status:503});}
   if(url.hostname==='challenges.cloudflare.com') {turnstileCalls++;const body=await req.json();return MFResponse.json({success:body.response==='test-valid-proof',hostname:'agents.hot'});}
   throw Error('unexpected external request in local test');
 }
};
const mf=new Miniflare(convertV4MiniflareOptions(options));
try {
 const db=await mf.getD1Database('DB'); await db.exec(readFileSync('migrations/0001_directory.sql','utf8').replaceAll('\n',' '));
 const base=String(await mf.ready).replace(/\/$/,'');
 const run=await new Promise(resolve=>{const child=spawn(process.execPath,['test/e2e.mjs'],{stdio:'inherit',env:{...process.env,BASE:base}});child.on('exit',resolve);});
 assert.equal(run,0,'legacy regression suite');
 const {scaleTests}=await import('./scale.mjs');
 await scaleTests({mf,db,base,getHookAttempts:()=>hookAttempts,getTurnstileCalls:()=>turnstileCalls});
 const {limitTests}=await import('./limits.mjs');
 await limitTests(options);
 console.log('ALL TEST SUITES PASS');
} finally {await mf.dispose();}
