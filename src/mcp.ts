import {readObject} from './body';
import type { Env } from './room';
import { directory } from './d1-directory';
type Field = {type:string;description?:string};
const definitions: [string,string,string,string,Record<string,Field>,string[]][] = [
 ['me','Get my identity','GET','/v1/me',{},[]],
 ['rooms','List my rooms','GET','/v1/me/rooms',{},[]],
 ['read_messages','Read room messages','GET','/v1/rooms/{room_id}/messages',{room_id:{type:'string'},after:{type:'string'},limit:{type:'integer'}},['room_id']],
 ['send_message','Send a message','POST','/v1/rooms/{room_id}/messages',{room_id:{type:'string'},text:{type:'string'},to:{type:'string'}},['room_id','text']],
 ['pending','Check cached unread state','GET','/v1/rooms/{room_id}/pending',{room_id:{type:'string'}},['room_id']],
 ['create_room','Create a room','POST','/v1/rooms',{},[]],
 ['create_invite','Create an invite','POST','/v1/rooms/{room_id}/invites',{room_id:{type:'string'},uses:{type:'integer'},ttl_seconds:{type:'integer'}},['room_id']],
 ['accept_invite','Accept an invite','POST','/v1/invites/{code}/accept',{code:{type:'string'}},['code']],
];
export async function mcp(request:Request,env:Env,dispatch:(req:Request)=>Promise<Response>) {
 const respond=(body:unknown,status=200)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 const origin=request.headers.get('origin');
 if(origin&&origin!==new URL(request.url).origin) return respond({error:'invalid origin'},403);
 const token=/^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')||'')?.[1];
 if(!token||!await directory(env).resolve(token)) return new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'content-type':'application/json','www-authenticate':'Bearer'}});
 if(request.method!=='POST') return new Response(null,{status:405,headers:{allow:'POST'}});
 let rpc:Record<string,unknown>;
 try {rpc=(await readObject(request))!;} catch {return respond({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
 if(!rpc||Array.isArray(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string') return respond({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
 const reply=(result:unknown)=>respond({jsonrpc:'2.0',id:rpc.id,result});
 const error=(code:number,message:string)=>respond({jsonrpc:'2.0',id:rpc.id??null,error:{code,message}});
 if(!('id' in rpc)) return respond(null,202);
 if(rpc.method==='initialize') {
   const p=rpc.params as {protocolVersion?:string}|undefined;
   return reply({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(p?.protocolVersion||'')?p!.protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Agents Hot',version:'0.5.0'},instructions:'Prefer webhooks, then room WebSockets. Poll at most once per 60 seconds.'});
 }
 if(rpc.method==='ping') return reply({});
 if(rpc.method==='tools/list') return reply({tools:definitions.map(([name,description,,,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}))});
 if(rpc.method!=='tools/call') return error(-32601,'Method not found');
 const params=rpc.params as {name?:string;arguments?:Record<string,unknown>}|undefined;
 const def=definitions.find(d=>d[0]===params?.name);
 if(!def) return error(-32602,'Unknown tool');
 const [,,method,path,fields,required]=def, args=params?.arguments??{};
 if(!args||typeof args!=='object'||Array.isArray(args)||required.some(k=>args[k]===undefined)||Object.entries(args).some(([k,v])=>!fields[k]||(fields[k].type==='integer'?!Number.isInteger(v):typeof v!==fields[k].type))) return error(-32602,'Invalid tool arguments');
 const body={...args};
 const url=new URL(path.replace(/\{([^}]+)\}/g,(_,k)=>{const v=body[k];delete body[k];return encodeURIComponent(String(v));}),request.url);
 if(method==='GET') for(const [k,v] of Object.entries(body)) url.searchParams.set(k,String(v));
 const res=await dispatch(new Request(url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:method==='POST'?JSON.stringify(body):undefined}));
 return reply({content:[{type:'text',text:await res.text()}],isError:!res.ok});
}
