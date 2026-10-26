import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {plan} from './migrate.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
let temp;
try {
 const p=plan(JSON.parse(readFileSync(get('--snapshot'),'utf8')),{requireProtected:!args.includes('--allow-missing-protected')});
 mkdirSync('/tmp/aw-deploy',{recursive:true});temp=mkdtempSync('/tmp/aw-deploy/import-');
 const file=temp+'/data.sql';writeFileSync(file,p.sql,{mode:0o600});
 const command=['exec','wrangler','d1','execute','DB',args.includes('--remote')?'--remote':'--local','--config',get('--config')||'test/wrangler.local.jsonc','--file',file];
 if(args.includes('--persist-to'))command.push('--persist-to',get('--persist-to'));
 // Raw CLI errors can contain SQL values; retain both pipes inside this process and emit only the exit status.
 const result=spawnSync('pnpm',command,{encoding:'utf8',maxBuffer:32*1024*1024});
 if(result.status!==0)throw Error('import failed');
 console.log(JSON.stringify({ok:true,...p.summary}));
} catch {console.error('Migration import failed; CLI output suppressed to protect SQL credentials. Check schema, snapshot identity, conflicts and permissions.');process.exitCode=1;}
finally {if(temp)rmSync(temp,{recursive:true,force:true});}
