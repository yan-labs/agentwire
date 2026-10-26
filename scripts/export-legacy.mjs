// Operator credentials and Cloudflare credentials are read only from process env; never printed.
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];
try {
 if(!args.includes('--url')||!args.includes('--out')||!process.env.OPERATOR_TOKEN) throw Error('missing inputs');
 const base=get('--url');
 const rooms=args.includes('--rooms')?JSON.parse(readFileSync(get('--rooms'),'utf8')):[];
 if(!Array.isArray(rooms)) throw Error('rooms must be an array');
 if(args.includes('--discover')) {
   if(!process.env.CF_ACCOUNT_ID||!process.env.CF_ROOM_NAMESPACE_ID||!process.env.CLOUDFLARE_API_TOKEN) throw Error('missing discovery inputs');
   let cursor='';
   do {
     const url=new URL(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/durable_objects/namespaces/${process.env.CF_ROOM_NAMESPACE_ID}/objects`);
     if(cursor) url.searchParams.set('cursor',cursor);
     const res=await fetch(url,{headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`}});
     if(!res.ok) throw Error('inventory failed');
     const page=await res.json(); if(!page.success) throw Error('inventory rejected');
     rooms.push(...page.result.map(o=>o.id)); cursor=page.result_info?.cursor||'';
   } while(cursor);
 }
 // Include the protected room even if no global memberships were ever recorded.
 rooms.push('room_cdc26cdd5dab08d7f63427a8');
 const res=await fetch(new URL('/v1/admin/migration/export',base),{method:'POST',headers:{authorization:`Bearer ${process.env.OPERATOR_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({rooms:[...new Set(rooms)]})});
 if(!res.ok) throw Error('export failed');
 const data=await res.json();
 // Inventory can contain opaque DO ids and names for the same room.
 data.rooms=[...new Map(data.rooms.filter(r=>r.meta).map(r=>[r.meta.room_id,r])).values()];
 writeFileSync(get('--out'),JSON.stringify(data),{mode:0o600});chmodSync(get('--out'),0o600);
 console.log(JSON.stringify({ok:true,rooms:data.rooms.length}));
} catch {console.error('Export failed (credentials/permissions, inventory or migration gate); no sensitive response logged.');process.exitCode=1;}
