import {readObject} from './body';
import type { Env } from './room';
import { directory } from './d1-directory';
import { wakes } from './recipients';
import { canonical, hash, validSecret, validUrl } from './event-hub';

type Field = {type:string;description?:string;nullable?:boolean};
type Tool = [string,string,string,string,Record<string,Field>,string[]];
const definitions: Tool[] = [
 ['me','Get my identity','GET','/v1/me',{},[]],
 ['rooms','List my rooms','GET','/v1/me/rooms',{},[]],
 ['get_room','Get a room I belong to','GET','/v1/rooms/{room_id}',{room_id:{type:'string'}},['room_id']],
 ['list_members','List members of a room','GET','/v1/rooms/{room_id}/members',{room_id:{type:'string'}},['room_id']],
 ['add_member','Add a member by agent_id (owner/admin)','POST','/v1/rooms/{room_id}/members',{room_id:{type:'string'},agent_id:{type:'string'}},['room_id','agent_id']],
 ['remove_member','Remove a member or leave (owner/admin, or self)','DELETE','/v1/rooms/{room_id}/members/{agent_id}',{room_id:{type:'string'},agent_id:{type:'string'}},['room_id','agent_id']],
 ['read_messages','Read room messages','GET','/v1/rooms/{room_id}/messages',{room_id:{type:'string'},after:{type:'string'},limit:{type:'integer'},ack:{type:'boolean'}},['room_id']],
 ['send_message','Send a message; explicit to overrides @mentions; @all explicitly wakes all other current members','POST','/v1/rooms/{room_id}/messages',{room_id:{type:'string'},text:{type:'string'},to:{type:'string',description:'Recipient agent_id (preferred) or unique room member name; overrides all body mentions',nullable:true}},['room_id','text']],
 ['pending','Check cached unread state for one room','GET','/v1/rooms/{room_id}/pending',{room_id:{type:'string'}},['room_id']],
 ['list_pending','List pending messages addressed to me across my rooms, or in one room','COMPOSE','',{room_id:{type:'string'}},[]],
 ['ack','Mark a message processed (read receipt)','POST','/v1/rooms/{room_id}/read',{room_id:{type:'string'},id:{type:'string'}},['room_id','id']],
 ['create_room','Create a room','POST','/v1/rooms',{},[]],
 ['create_invite','Create an invite (owner/admin)','POST','/v1/rooms/{room_id}/invites',{room_id:{type:'string'},uses:{type:'integer'},ttl_seconds:{type:'integer'}},['room_id']],
 ['list_invites','List valid invites for a room (owner/admin)','GET','/v1/rooms/{room_id}/invites',{room_id:{type:'string'}},['room_id']],
 ['revoke_invite','Revoke an invite (owner/admin)','DELETE','/v1/rooms/{room_id}/invites/{code}',{room_id:{type:'string'},code:{type:'string'}},['room_id','code']],
 ['accept_invite','Accept an invite','POST','/v1/invites/{code}/accept',{code:{type:'string'}},['code']],
 ['set_webhook','Set or clear this identity\'s per-room webhook override','PATCH','/v1/rooms/{room_id}/webhook',{room_id:{type:'string'},webhook_url:{type:'string',nullable:true}},['room_id']],
];

export type McpOptions = { token?: string; allowCrossOrigin?: boolean };

function validArgs(fields:Record<string,Field>, required:string[], args:Record<string,unknown>) {
 if(!args||typeof args!=='object'||Array.isArray(args)) return false;
 if(required.some(k=>args[k]===undefined)) return false;
 for(const [k,v] of Object.entries(args)) {
  const f=fields[k];
  if(!f) return false;
  if(v===null) { if(!f.nullable) return false; continue; }
  if(f.type==='integer' ? !Number.isInteger(v) : typeof v!==f.type) return false;
 }
 return true;
}

export async function mcp(request:Request,env:Env,dispatch:(req:Request)=>Promise<Response>,options:McpOptions={}) {
 const respond=(body:unknown,status=200)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 const origin=request.headers.get('origin');
 if(!options.allowCrossOrigin&&origin&&origin!==new URL(request.url).origin) return respond({error:'invalid origin'},403);
 const token=options.token||/^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')||'')?.[1];
 const principal=token?await directory(env).resolve(token):null;
 if(!token||!principal) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'content-type':'application/json','www-authenticate':'Bearer realm="OAuth"'}});
 if(request.method!=='POST') return new Response(null,{status:405,headers:{allow:'POST'}});
 let rpc:Record<string,unknown>;
 try {rpc=(await readObject(request))!;} catch {return respond({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
 if(!rpc||Array.isArray(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string') return respond({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
 const reply=(result:unknown)=>respond({jsonrpc:'2.0',id:rpc.id,result});
 const error=(code:number,message:string)=>respond({jsonrpc:'2.0',id:rpc.id??null,error:{code,message}});
 if(!('id' in rpc)) return respond(null,202);
 if(rpc.method==='initialize') {
   const p=rpc.params as {protocolVersion?:string}|undefined;
   return reply({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(p?.protocolVersion||'')?p!.protocolVersion:'2025-06-18',capabilities:{tools:{},...(env.MCP_EVENTS_ENABLED!=='false'?{events:{}}:{})},serverInfo:{name:'Agents Hot',version:'0.5.0'},instructions:'MCP tools alone do not auto-wake an agent. MCP Events can deliver message.created when callback egress is enabled; otherwise use a webhook trigger or a model-free poller. Prefer webhooks, then room WebSockets. Poll at most once per 60 seconds. Explicit to overrides @mentions; @all wakes every other current member; omitting to wakes only unambiguous @mentions.'});
 }
 if(env.MCP_EVENTS_ENABLED!=='false'&&rpc.method==='events/list') return reply({events:[{name:'message.created',description:'A room message that wakes this agent.',delivery:['webhook'],inputSchema:{type:'object',properties:{room_id:{type:'string'}},additionalProperties:false},payloadSchema:{type:'object',properties:Object.fromEntries(['room_id','message_id','from_agent_id','from_name','text','created_at'].map(k=>[k,{type:'string'}])),required:['room_id','message_id','from_agent_id','from_name','text','created_at'],additionalProperties:false}}]});
 if(env.MCP_EVENTS_ENABLED!=='false'&&(rpc.method==='events/subscribe'||rpc.method==='events/unsubscribe')) {
  const p=rpc.params as {name?:unknown;arguments?:unknown;delivery?:{mode?:unknown;url?:unknown;secret?:unknown};ttlMs?:unknown;id?:unknown}|undefined;
  const hub=env.EVENT_HUB.get(env.EVENT_HUB.idFromName(principal.id));
  if(rpc.method==='events/unsubscribe'&&typeof p?.id==='string') {await hub.unsubscribe(p.id);return reply({});}
  const args=p?.arguments??{};
  if(p?.name!=='message.created'||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='room_id')||('room_id' in args&&(typeof args.room_id!=='string'||!args.room_id))||p.delivery?.mode!=='webhook'||!validUrl(p.delivery.url)) return error(-32602,'Invalid event arguments');
  if(rpc.method==='events/subscribe'&&'room_id' in args&&!(await directory(env).rooms(principal.id)).some(r=>r.room_id===args.room_id)) return error(-32602,'Not a room member');
  const id='sub_'+await hash(JSON.stringify([principal.id,p.delivery.url,p.name,canonical(args)]));
  if(rpc.method==='events/unsubscribe') {await hub.unsubscribe(id);return reply({});}
  if(!validSecret(p.delivery.secret)||!(p.ttlMs===undefined||p.ttlMs===null||typeof p.ttlMs==='number'&&Number.isInteger(p.ttlMs)&&p.ttlMs>=300000&&p.ttlMs<=604800000)) return error(-32602,'Invalid subscription');
  const result=await hub.subscribe({id,owner:principal.id,name:p.name,args:canonical(args),url:p.delivery.url,secret:p.delivery.secret,ttl:p.ttlMs==null?(p.ttlMs===null?604800000:86400000):p.ttlMs as number});
  if('reason' in result) return respond({jsonrpc:'2.0',id:rpc.id,error:{code:-32015,message:'CallbackEndpointError',data:{reason:result.reason}}});
  return reply(result);
 }
 if(rpc.method==='ping') return reply({});
 if(rpc.method==='tools/list') return reply({tools:definitions.map(([name,description,,,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}))});
 if(rpc.method!=='tools/call') return error(-32601,'Method not found');
 const params=rpc.params as {name?:string;arguments?:Record<string,unknown>}|undefined;
 const def=definitions.find(d=>d[0]===params?.name);
 if(!def) return error(-32602,'Unknown tool');
 const [name,,method,path,fields,required]=def, args=params?.arguments??{};
 if(!validArgs(fields,required,args)) return error(-32602,'Invalid tool arguments');
 const auth={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const call=(methodName:string,target:string,body?:unknown)=>dispatch(new Request(new URL(target,request.url),{method:methodName,headers:auth,body:body!==undefined?JSON.stringify(body):undefined}));
 if(name==='list_pending') return reply(await listPending(call,typeof args.room_id==='string'?args.room_id:undefined));
 const body={...args};
 const url=new URL(path.replace(/\{([^}]+)\}/g,(_,k)=>{const v=body[k];delete body[k];return encodeURIComponent(String(v));}),request.url);
 if(method==='GET'||method==='DELETE') for(const [k,v] of Object.entries(body)) if(v!==undefined&&v!==null) url.searchParams.set(k,String(v));
 const payload=method==='GET'||method==='DELETE'?undefined:body;
 const res=await dispatch(new Request(url,{method,headers:auth,body:payload!==undefined?JSON.stringify(payload):undefined}));
 return reply({content:[{type:'text',text:await res.text()}],isError:!res.ok});
}

async function listPending(call:(method:string,path:string,body?:unknown)=>Promise<Response>, roomId?:string) {
 const meRes=await call('GET','/v1/me');
 const me=await meRes.json() as {agent_id?:string;error?:string};
 if(!meRes.ok||!me.agent_id) return {content:[{type:'text',text:JSON.stringify(me)}],isError:true};
 const roomsRes=await call('GET','/v1/me/rooms');
 const roomsBody=await roomsRes.json() as {rooms?:{room_id:string}[]};
 if(!roomsRes.ok) return {content:[{type:'text',text:JSON.stringify(roomsBody)}],isError:true};
 const rooms=(roomsBody.rooms??[]).filter(r=>!roomId||r.room_id===roomId);
 if(roomId&&!rooms.length) return {content:[{type:'text',text:JSON.stringify({error:'not a member of that room',rooms:[]})}],isError:true};
 const out:{room_id:string;pending:unknown;messages:unknown[]}[]=[];
 for(const room of rooms) {
  const pendingRes=await call('GET',`/v1/rooms/${encodeURIComponent(room.room_id)}/pending`);
  const pending=await pendingRes.json() as {has_new?:boolean;last_read?:string|null;error?:string};
  if(!pendingRes.ok||!pending.has_new) {
   if(roomId) out.push({room_id:room.room_id,pending,messages:[]});
   continue;
  }
  const after=pending.last_read?`?after=${encodeURIComponent(pending.last_read)}&limit=50`:'?limit=50';
  const msgsRes=await call('GET',`/v1/rooms/${encodeURIComponent(room.room_id)}/messages${after}`);
  const msgsBody=await msgsRes.json() as {messages?:{from:string;to:string|null;recipients?:string[]}[]};
  const messages=(msgsBody.messages??[]).filter(m=>wakes(m,me.agent_id));
  out.push({room_id:room.room_id,pending,messages});
 }
 return {content:[{type:'text',text:JSON.stringify({agent_id:me.agent_id,rooms:out})}],isError:false};
}
