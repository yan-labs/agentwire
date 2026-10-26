import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export async function limitTests(options) {
 const next={...options,name:'limit-test',bindings:{...options.bindings,MAX_ROOMS:'1',MAX_MEMBERS:'2',MAX_IDENTITIES:'4',MAX_GLOBAL_ROOMS:'2'},ratelimits:{REGISTER_LIMITER:{namespace_id:'2001',simple:{limit:10,period:60}},MESSAGE_LIMITER:{namespace_id:'2002',simple:{limit:1,period:60}},ROOM_LIMITER:{namespace_id:'2003',simple:{limit:2,period:60}},POLL_LIMITER:{namespace_id:'2004',simple:{limit:1,period:60}}}};
 const mf=new Miniflare(convertV4MiniflareOptions(next));let count=0;
 const ok=(v,label)=>{assert.ok(v,label);count++;console.log(`PASS ${label}`);};
 try {
 const db=await mf.getD1Database('DB');await db.exec(readFileSync('migrations/0001_directory.sql','utf8').replaceAll('\n',' '));
 async function call(method,path,token,body){const r=await mf.dispatchFetch('http://local'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};}
 const a=(await call('POST','/v1/agents',null,{name:'a'})).data,b=(await call('POST','/v1/agents',null,{name:'b'})).data,c=(await call('POST','/v1/agents',null,{name:'c'})).data;
 const r=(await call('POST','/v1/rooms',a.token)).data.room_id,path=`/v1/rooms/${r}`;
 await call('POST',path+'/members',a.token,{agent_id:b.agent_id});
 ok((await call('POST',path+'/members',a.token,{agent_id:c.agent_id})).status===409,'configurable room member cap');
 const r2=(await call('POST','/v1/rooms',c.token)).data.room_id;
 ok((await call('POST',`/v1/rooms/${r2}/members`,c.token,{agent_id:b.agent_id})).status===409,'atomic identity membership cap');
 ok((await call('POST','/v1/rooms',null,{})).status===409,'global room cap');
 await call('POST',path+'/messages',a.token,{text:'one'});
 const limited=await call('POST',path+'/messages',a.token,{text:'two'});
 ok(limited.status===429&&limited.headers.get('retry-after')==='60','identity message rate limit');
 await call('POST',path+'/messages',b.token,{text:'three'});
 ok((await call('GET',path+'/pending/'+a.agent_id)).status===200,'first poll accepted');
 ok((await call('GET',path+'/pending/'+a.agent_id)).status===429,'minimum poll interval enforced');
 // The fourth identity is allowed, the fifth is refused without growing the directory.
 const d=await call('POST','/v1/agents',null,{name:'d'});
 ok(d.status===201,'global identity cap permits final slot');
 await call('DELETE',path+'/members/'+b.agent_id,b.token);
 await call('POST',path+'/members',a.token,{agent_id:d.data.agent_id});
 ok((await call('POST',path+'/messages',d.data.token,{text:'room limited'})).status===429,'room message rate limit');
 ok((await call('POST','/v1/agents',null,{name:'e'})).status===409,'global identity cap');
 const statuses=[];for(let i=0;i<5;i++)statuses.push((await call('POST','/v1/agents',null,{name:'limited'})).status);
 ok(statuses.includes(429),'IP registration limiter');
 const old=await db.prepare('SELECT n FROM capacity WHERE kind=?').bind('agents').first();
 ok(old.n===4,'denied registration does not create orphan identity');
 console.log(`LIMIT TESTS PASS (${count} checks)`);
 } finally {await mf.dispose();}
}
