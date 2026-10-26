import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export const PROTECTED='room_cdc26cdd5dab08d7f63427a8';
const tables={agents:['id','name','webhook_url','webhook_headers','created_at'],tokens:['hash','agent_id','created_at'],memberships:['agent_id','room_id','joined_at'],invites:['hash','room_id','created_by','uses_left','expires_at','created_at'],rooms:['room_id','created_at']};
const q=v=>v===null||v===undefined?'NULL':typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
export function plan(snapshot,{requireProtected=true}={}) {
 if(!snapshot.directory||!Array.isArray(snapshot.rooms)) throw Error('invalid snapshot');
 const data=Object.fromEntries(Object.keys(tables).map(t=>[t,new Map()]));
 function add(table,row,key) {
   const old=data[table].get(key);
   if(old&&table==='tokens'&&old.agent_id!==row.agent_id) throw Error('token ownership conflict');
   if(!old) data[table].set(key,row);
 }
 for(const [table,cols] of Object.entries(tables)) for(const row of snapshot.directory[table]??[]) {
   if(cols.some(k=>row[k]===undefined)) throw Error(`missing ${table} field`);
   add(table,row,table==='memberships'?`${row.agent_id}:${row.room_id}`:row[cols[0]]);
 }
 const rooms=snapshot.rooms.filter(r=>r.meta);
 for(const room of rooms) add('rooms',{room_id:room.meta.room_id,created_at:room.meta.created_at},room.meta.room_id);
 for(const room of rooms) for(const a of room.agents) {
   if(!a.token_hash.startsWith('global:')) {
     add('agents',a,a.id);add('tokens',{hash:a.token_hash,agent_id:a.id,created_at:a.created_at},a.token_hash);
   }
   if(!data.agents.has(a.id)) throw Error('global member missing from Directory export');
   add('memberships',{agent_id:a.id,room_id:room.meta.room_id,joined_at:a.created_at},`${a.id}:${room.meta.room_id}`);
 }
 for(const row of data.tokens.values()) if(!/^[a-f0-9]{64}$/.test(row.hash)||!data.agents.has(row.agent_id)) throw Error('invalid token hash or orphan token');
 const protectedRoom=rooms.find(r=>r.meta.room_id===PROTECTED);
 const expected=['来财','Muse','dot'];
 const protectedOK=!!protectedRoom&&protectedRoom.agents.length===3&&expected.every(n=>protectedRoom.agents.some(a=>a.name===n))&&protectedRoom.agents.every(a=>data.agents.has(a.id)&&[...data.tokens.values()].some(t=>t.agent_id===a.id));
 if(requireProtected&&!protectedOK) throw Error('protected room/member/token reconciliation failed');
 // Conflicting target rows abort instead of overwriting live identities, hashes or webhook settings.
 const sql=['CREATE TABLE IF NOT EXISTS migration_assert (ok INTEGER CHECK(ok=1));','DELETE FROM migration_assert;'];
 for(const [table,cols] of Object.entries(tables)) for(const row of data[table].values()) {
   const key=table==='memberships'?['agent_id','room_id']:[cols[0]];
   const where=key.map(k=>`${k}=${q(row[k])}`).join(' AND ');
   const compare=cols.filter(k=>k!=='created_at'&&k!=='joined_at').map(k=>`${k} IS ${q(row[k])}`).join(' AND ');
   sql.push(`INSERT INTO migration_assert SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE ${where}) OR EXISTS(SELECT 1 FROM ${table} WHERE ${where} AND ${compare}) THEN 1 ELSE 0 END;`);
   sql.push(`INSERT OR IGNORE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(k=>q(row[k])).join(',')});`);
 }
 sql.push('DROP TABLE migration_assert;');
 const counts=Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.size]));
 const checks=Object.entries(data).map(([table,rows])=>({table,rows:[...rows.values()]}));
 return {sql:sql.join('\n'),checks,summary:{counts,rooms:rooms.length,protected_room:protectedOK,token_hashes_preserved:true},roomIds:rooms.map(r=>r.meta.room_id)};
}
async function main() {
 const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];
 if(!args.includes('--snapshot')) throw Error('usage: node scripts/migrate.mjs --snapshot protected.json [--sql protected.sql] [--allow-missing-protected]');
 const p=plan(JSON.parse(readFileSync(get('--snapshot'),'utf8')),{requireProtected:!args.includes('--allow-missing-protected')});
 if(args.includes('--sql')) {writeFileSync(get('--sql'),p.sql,{mode:0o600});chmodSync(get('--sql'),0o600);}
 console.log(JSON.stringify({...p.summary,mode:args.includes('--sql')?'sql-generated':'dry-run'}));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href) main().catch(()=>{console.error('Migration failed validation; no secrets logged. Check snapshot structure/protected members and target conflicts.');process.exitCode=1;});
