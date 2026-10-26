import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {plan} from './migrate.mjs';
const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];
try {
 const p=plan(JSON.parse(readFileSync(get('--snapshot'),'utf8')),{requireProtected:!args.includes('--allow-missing-protected')});
 // Readback stays in a pipe; hash/header values never reach stdout/stderr.
 const command=['exec','wrangler','d1','execute','DB',args.includes('--remote')?'--remote':'--local','--config',get('--config')||'test/wrangler.local.jsonc','--json','--command','SELECT * FROM agents; SELECT * FROM tokens; SELECT * FROM memberships; SELECT * FROM invites; SELECT * FROM rooms;'];
 if(args.includes('--persist-to')) command.push('--persist-to',get('--persist-to'));
 const r=spawnSync('pnpm',command,{encoding:'utf8',maxBuffer:32*1024*1024});
 if(r.status!==0) throw Error('D1 readback failed');
 const parsed=JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
 let matched=0;
 for(let i=0;i<p.checks.length;i++) {
   const {table,rows}=p.checks[i], actual=parsed[i].results;
   for(const row of rows) {
     const keys=table==='memberships'?['agent_id','room_id']:[table==='agents'?'id':table==='rooms'?'room_id':'hash'];
     const match=actual.find(a=>keys.every(k=>a[k]===row[k]));
     if(!match||Object.keys(row).some(k=>!['created_at','joined_at','role','last_read','token_hash'].includes(k)&&k in match&&match[k]!==row[k])) throw Error('readback mismatch');
     matched++;
   }
 }
 console.log(JSON.stringify({ok:true,matched,...p.summary,actual_counts:Object.fromEntries(p.checks.map(({table},i)=>[table,parsed[i].results.length]))}));
} catch {console.error('Reconciliation failed; no hashes, headers or credentials logged.');process.exitCode=1;}
