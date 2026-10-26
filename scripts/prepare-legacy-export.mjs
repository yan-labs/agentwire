// Prepare a short-lived, read-only export version without changing any existing secret or DO namespace.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [ref,out]=process.argv.slice(2);
assert(ref&&out?.startsWith('/tmp/aw-deploy/'),'usage: prepare-legacy-export.mjs <deployed git ref> /tmp/aw-deploy/<directory>');
mkdirSync(out+'/src',{recursive:true,mode:0o700});
const source=p=>execFileSync('git',['show',`${ref}:${p}`],{encoding:'utf8'});
for(const file of ['index','room','directory']) {
 let code=source(`src/${file}.ts`);
 if(file==='index') {
  const marker='const method = request.method.toUpperCase();';assert(code.includes(marker));
  code=code.replace(marker,marker+`\n    if(Date.now()<Number(env.MIGRATION_FREEZE_UNTIL||0)&&!['GET','HEAD','OPTIONS'].includes(method)) return json({error:'brief migration maintenance'},503);`);
 } else {
  const at=code.lastIndexOf('}');assert(at>0&&!code.includes('exportData()'));
  const method=file==='room'?`exportData() { return {meta:this.getMeta(),agents:this.listAgents()}; }`:`exportData() { const out={}; for(const t of ['agents','tokens','memberships','invites']) out[t]=this.ctx.storage.sql.exec('SELECT * FROM '+t).toArray(); return out; }`;
  code=code.slice(0,at)+method+'\n'+code.slice(at);
 }
 writeFileSync(`${out}/src/${file}.ts`,code);
}
const config=JSON.parse(source('wrangler.jsonc'));config.observability={enabled:false};config.preview_urls=false;
config.vars={MIGRATION_FREEZE_UNTIL:String(Date.now()+270000)};
writeFileSync(out+'/wrangler.json',JSON.stringify(config,null,2));
console.log('Legacy export prepared; automatic write thaw within 270 seconds; GET/pending unchanged.');
