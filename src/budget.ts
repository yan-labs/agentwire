import type {Env} from './room';
import {numberSetting} from './settings';
export const INCLUDED: Record<string,number> = {
 workers_requests:10_000_000,workers_cpu_ms:30_000_000,do_requests:1_000_000,do_gb_seconds:400_000,
 do_rows_read:25_000_000_000,do_rows_written:50_000_000,do_storage_bytes:5_000_000_000,
 d1_rows_read:25_000_000_000,d1_rows_written:50_000_000,d1_storage_bytes:5_000_000_000,
 kv_reads:10_000_000,kv_writes:1_000_000,kv_deletes:1_000_000,kv_lists:1_000_000,kv_storage_bytes:1_000_000_000,
 r2_class_a:1_000_000,r2_class_b:10_000_000,r2_storage_bytes:10_000_000_000,
};
export type BudgetState={level:number;month:string;reason:string};
let cached:{state:BudgetState;until:number}|undefined;
function validState(state:BudgetState|null):state is BudgetState {
 return !!state&&Number.isInteger(state.level)&&state.level>=0&&state.level<=4&&typeof state.month==='string'&&/^\d{4}-\d{2}$/.test(state.month);
}
export function budgetLevel(usage:Record<string,number>,env:Partial<Env>,now=new Date()):BudgetState {
 const month=now.toISOString().slice(0,7), start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1), end=Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1);
 const progress=Math.max(1/31,(now.getTime()-start)/(end-start));
 const caps={...INCLUDED,...JSON.parse(env.BUDGET_LIMITS||'{}') as Record<string,number>};
 const thresholds=(env.BUDGET_THRESHOLDS||'0.45,0.65,0.75,0.85').split(',').map(Number);
 if(thresholds.length!==4||thresholds.some((n,i)=>!Number.isFinite(n)||n<=0||n>1||(i>0&&n<=thresholds[i-1]))) return {level:4,month,reason:'invalid_budget_configuration'};
 let level=0;
 for(const [key,cap] of Object.entries(caps)) {
   const value=usage[key];
   if(!Number.isFinite(cap)||cap<=0||!Number.isFinite(value)||value<0) return {level:4,month,reason:`usage_unavailable:${key}`};
   const fraction=key.endsWith('_bytes')?1:progress;
   const ratio=value/(cap*fraction);
   thresholds.forEach((threshold,i)=>{if(ratio>=threshold) level=Math.max(level,i+1);});
 }
 return {level,month,reason:level?'included_usage_threshold':'normal'};
}
export async function getBudget(env:Env):Promise<BudgetState> {
 if(env.BUDGET_ENABLED!=='true') return {level:0,month:new Date().toISOString().slice(0,7),reason:'local_test'};
 if(cached&&cached.until>Date.now()) return cached.state;
 let stored:BudgetState|null=null;
 try {stored=await env.PENDING.get<BudgetState>('budget','json');}catch{}
 const state=validState(stored)?stored:{level:4,month:new Date().toISOString().slice(0,7),reason:'usage_unavailable'};
 cached={state,until:Date.now()+60000}; return state;
}
export function budgetError(state:BudgetState,method:string,path:string):Response|null {
 let code='';
 if(state.level>=4) code='BUDGET_API_PAUSED';
 else if(state.level>=3&&!['GET','HEAD','OPTIONS'].includes(method)&&path!=='/mcp') code='BUDGET_READ_ONLY';
 else if(state.level>=2&&/\/(stream|pending)(\/|$)/.test(path)) code='BUDGET_PUSH_ONLY';
 else if(state.level>=1&&method==='POST'&&['/v1/agents','/v1/agents/web','/v1/rooms'].includes(path)) code='BUDGET_CAPACITY_PAUSED';
 return code?Response.json({error:'Agents Hot is conserving its included monthly usage; try next month or use the public CDN unread feed.',code,level:state.level},{status:503,headers:{'retry-after':'600','cache-control':'no-store'}}):null;
}
type GraphData={errors?:unknown;data?:{viewer?:{accounts?:Record<string,{sum?:{value:number};max?:{value:number}}[]>[]}}};
export async function runBudgetGuard(env:Env,fetcher:typeof fetch=fetch,now=new Date()) {
 if(env.BUDGET_ENABLED!=='true') return;
 let state:BudgetState;
 try {
   if(!env.CF_ANALYTICS_TOKEN||!env.CF_ACCOUNT_ID||!env.USAGE_QUERY) throw Error('missing analytics configuration');
   const first=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
   const res=await fetcher('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:`Bearer ${env.CF_ANALYTICS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query:env.USAGE_QUERY,variables:{accountTag:env.CF_ACCOUNT_ID,start:first,end:now.toISOString(),startDate:first.slice(0,10),endDate:now.toISOString().slice(0,10)}}),signal:AbortSignal.timeout(15000)});
   if(!res.ok) throw Error('analytics http failure');
   const data=await res.json() as GraphData, account=data.data?.viewer?.accounts?.[0];
   if(data.errors||!account) throw Error('analytics invalid response');
   const usage:Record<string,number>={};
   for(const key of Object.keys(INCLUDED)) {
     const rows=account[key];
     if(!Array.isArray(rows)) continue;
     // A valid empty monthly aggregate is zero; missing aliases/errors still fail closed.
     if(rows.length===0) {usage[key]=0;continue;}
     // Grouped or truncated datasets cannot be used as a complete account aggregate.
     if(rows.length!==1) continue;
     const value=rows[0]?.sum?.value??rows[0]?.max?.value;
     if(typeof value==='number') usage[key]=value;
   }
   state=budgetLevel(usage,env,now);
 } catch {state={level:4,month:now.toISOString().slice(0,7),reason:'usage_unavailable'};}
 let previous:BudgetState|null=null;try {previous=await env.PENDING.get<BudgetState>('budget','json');}catch{}
 const old=validState(previous)?previous:null;
 let published=old;
 const publish=async(next:BudgetState)=>{
   if(!published||published.level!==next.level||published.month!==next.month) {
     await env.PENDING.put('budget',JSON.stringify(next));published=next;cached=undefined;
   }
 };
 const gateConfigured=env.CF_GUARD_TOKEN&&env.CF_ZONE_ID&&env.WAF_RULESET_ID&&env.WAF_RULE_ID&&env.CF_ACCOUNT_ID;
 if(!gateConfigured) {state={...state,level:4,reason:'external_gate_unconfigured'};await publish(state);return {state,external_gate:false};}
 // Publish an escalation before touching external controls; publish recovery only after verified readback.
 if(!old||state.level>old.level) await publish({...state,level:Math.max(state.level,old?old.level:4)});
 const api=async(path:string,method='GET',body?:unknown)=>{
   const res=await fetcher(`https://api.cloudflare.com/client/v4/${path}`,{method,headers:{authorization:`Bearer ${env.CF_GUARD_TOKEN}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   if(!res.ok) throw Error('external budget gate http failure');
   const result=await res.json() as {success?:boolean;result?:{enabled?:boolean;previews_enabled?:boolean}};
   if(!result.success||typeof result.result?.enabled!=='boolean') throw Error('external budget gate rejected');
   return result.result;
 };
 const blocked=state.level>=4;
 try {
   const subdomain=`accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(env.CF_SCRIPT_NAME||'agentwire')}/subdomain`;
   const desiredWorker=!blocked&&env.ALLOW_WORKERS_DEV==='true';
   const current=await api(subdomain);
   if(current.enabled!==desiredWorker||current.previews_enabled!==false) {
     await api(subdomain,'POST',{enabled:desiredWorker,previews_enabled:false});
     const readback=await api(subdomain);
     if(readback.enabled!==desiredWorker||readback.previews_enabled!==false) throw Error('subdomain readback mismatch');
   }
   const rule=`zones/${env.CF_ZONE_ID}/rulesets/${env.WAF_RULESET_ID}/rules/${env.WAF_RULE_ID}`;
   const currentRule=await api(rule);
   if(currentRule.enabled!==blocked) {
     await api(rule,'PATCH',{action:'block',expression:env.WAF_API_EXPRESSION||'(http.host eq "api.agents.hot" or http.host eq "pending.agents.hot" or starts_with(http.request.uri.path, "/v1") or starts_with(http.request.uri.path, "/pending") or http.request.uri.path eq "/mcp" or http.request.uri.path eq "/openapi.json" or http.request.uri.path eq "/health")',enabled:blocked,description:'Agents Hot monthly included-usage emergency gate'});
     if((await api(rule)).enabled!==blocked) throw Error('WAF readback mismatch');
   }
   await publish(state);return {state,external_gate:true};
 } catch {
   state={...state,level:4,reason:'external_gate_failed'};await publish(state);
   return {state,external_gate:false};
 }
}
