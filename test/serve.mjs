// Local browser acceptance fixture: real application + local D1/KV/R2, fake Turnstile verification only.
import {Miniflare,convertV4MiniflareOptions,Response,Log,LogLevel} from 'miniflare';
import {build} from 'esbuild';
import {readFileSync,mkdirSync} from 'node:fs';
const out=process.env.AW_TEST_OUTPUT||'/tmp/aw-deploy';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/index.ts'],outfile:out+'/site-worker.mjs',bundle:true,format:'esm',conditions:['workerd','worker','browser'],mainFields:['browser','module','main'],external:['cloudflare:workers']});
const config=JSON.parse(readFileSync('test/wrangler.local.jsonc','utf8'));
const mf=new Miniflare(convertV4MiniflareOptions({name:'site-test',modules:true,modulesRoot:out,scriptPath:out+'/site-worker.mjs',compatibilityDate:'2026-05-03',compatibilityFlags:['nodejs_compat'],cf:false,host:'127.0.0.1',port:8797,log:new Log(LogLevel.ERROR),durableObjects:Object.fromEntries(config.durable_objects.bindings.map(b=>[b.name,{className:b.class_name,useSQLite:true}])),d1Databases:['DB'],kvNamespaces:['PENDING'],r2Buckets:['UNREAD'],ratelimits:Object.fromEntries(config.ratelimits.map(r=>[r.name,{namespace_id:r.namespace_id,simple:r.simple}])),bindings:{...config.vars,TURNSTILE_SECRET:'local-fake-secret'},outboundService:async request=>{
 if(new URL(request.url).hostname==='challenges.cloudflare.com') {const body=await request.json();return Response.json({success:body.response==='local-browser-proof',hostname:'127.0.0.1'});}
 throw Error('No external network in local fixture');
}}));
await (await mf.getD1Database('DB')).exec((readFileSync('migrations/0001_directory.sql','utf8')+readFileSync('migrations/0002_identity_imports.sql','utf8')).replaceAll('\n',' '));
console.log('LOCAL FIXTURE READY '+await mf.ready);
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=>{await mf.dispose();process.exit(0);});
await new Promise(()=>{});
