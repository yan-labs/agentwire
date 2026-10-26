import type {Env} from './room';
import {numberSetting} from './settings';
export const INCLUDED: Record<string,number> = {
 workers_requests:10_000_000,workers_cpu_ms:30_000_000,do_requests:1_000_000,do_gb_seconds:400_000,
 do_rows_read:25_000_000_000,do_rows_written:50_000_000,do_storage_bytes:5_000_000_000,
 d1_rows_read:25_000_000_000,d1_rows_written:50_000_000,d1_storage_bytes:5_000_000_000,
 kv_reads:10_000_000,kv_writes:1_000_000,kv_deletes:1_000_000,kv_lists:1_000_000,kv_storage_bytes:1_000_000_000,
 r2_class_a:1_000_000,r2_class_b:10_000_000,r2_storage_bytes:10_000_000_000,
};
export type BudgetState={level:number;month:string;reason:string;failures?:number;latched?:boolean};
let cached:{state:BudgetState;until:number}|undefined;
function validState(state:BudgetState|null):state is BudgetState {
 return !!state&&Number.isInteger(state.level)&&state.level>=0&&state.level<=4&&typeof state.month==='string'&&/^\d{4}-\d{2}$/.test(state.month)&&typeof state.reason==='string'&&(state.failures===undefined||Number.isInteger(state.failures)&&state.failures>=0)&&(state.latched===undefined||typeof state.latched==='boolean');
}
export function billingWindow(env:Partial<Env>,now:Date) {
 const day=Math.min(31,numberSetting(env.BILLING_CYCLE_DAY,1));
 const boundary=(offset:number)=>{
  const year=now.getUTCFullYear(),month=now.getUTCMonth()+offset;
  const last=new Date(Date.UTC(year,month+1,0)).getUTCDate();
  return Date.UTC(year,month,Math.min(day,last));
 };
 const offset=now.getTime()<boundary(0)?-1:0;
 return {start:boundary(offset),end:boundary(offset+1)};
}
export function budgetLevel(usage:Record<string,number>,env:Partial<Env>,now=new Date()):BudgetState {
 const {start,end}=billingWindow(env,now),month=new Date(start).toISOString().slice(0,7);
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
 const state=validState(stored)?stored:{level:0,month:new Date().toISOString().slice(0,7),reason:'awaiting_first_sample'};
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
// Account-wide queries: aliases normalize the documented units, not per-script quotas.
export const USAGE_QUERY = `query AgentsHotUsage($accountTag: string!, $start: Time!, $end: Time!, $startDate: Date!, $endDate: Date!, $storageStart: Time!) {
 viewer { accounts(filter: {accountTag: $accountTag}) {
  workers: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests cpuTimeUs } }
  invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } }
  periodic: durableObjectsPeriodicGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { duration rowsRead rowsWritten } }
  doStorage: durableObjectsSqlStorageGroups(limit: 10000, filter: {date_geq: $endDate, date_leq: $endDate}) { max { storedBytes } dimensions { namespaceId } }
  d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $startDate, date_leq: $endDate}) { sum { rowsRead rowsWritten } }
  d1Storage: d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $endDate, date_leq: $endDate}) { max { databaseSizeBytes } dimensions { databaseId } }
  kv: kvOperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } dimensions { actionType } }
  kvStorage: kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $endDate, date_leq: $endDate}) { max { byteCount } dimensions { namespaceId } }
  r2: r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } dimensions { actionType } }
  r2Storage: r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $storageStart, datetime_leq: $end}) { max { payloadSize metadataSize } dimensions { bucketName } }
 } }
}`;
type Rows = {sum?:Record<string,number>;max?:Record<string,number>;dimensions?:{actionType?:string}}[];
export function parseUsage(account:Record<string,Rows>):Record<string,number> {
 const total=(name:string,field:string,kind:'sum'|'max'='sum')=>{
  const rows=account[name];
  if(!Array.isArray(rows)||rows.length>=10000||(kind==='max'&&rows.length===0)) throw Error('missing or truncated usage');
  return rows.reduce((n,row)=>{const v=row[kind]?.[field];if(typeof v!=='number'||!Number.isFinite(v)||v<0) throw Error('invalid usage');return n+v;},0);
 };
 const usage:Record<string,number>={workers_requests:total('workers','requests'),workers_cpu_ms:total('workers','cpuTimeUs')/1000,
 do_requests:total('invocations','requests'),do_gb_seconds:total('periodic','duration'),do_rows_read:total('periodic','rowsRead'),do_rows_written:total('periodic','rowsWritten'),do_storage_bytes:total('doStorage','storedBytes','max'),
 d1_rows_read:total('d1','rowsRead'),d1_rows_written:total('d1','rowsWritten'),d1_storage_bytes:total('d1Storage','databaseSizeBytes','max'),
 kv_storage_bytes:total('kvStorage','byteCount','max'),r2_storage_bytes:total('r2Storage','payloadSize','max')+total('r2Storage','metadataSize','max')};
 for(const action of ['read','write','delete','list']) usage['kv_'+({read:'reads',write:'writes',delete:'deletes',list:'lists'} as Record<string,string>)[action]]=0;
 total('kv','requests');
 for(const row of account.kv) {
  const key=({read:'kv_reads',write:'kv_writes',delete:'kv_deletes',list:'kv_lists'} as Record<string,string>)[row.dimensions?.actionType||''];
  if(!key) throw Error('unknown KV action');usage[key]+=row.sum!.requests;
 }
 usage.r2_class_a=0;usage.r2_class_b=0;total('r2','requests');
 for(const row of account.r2) {
  const action=row.dimensions?.actionType||'';
  if(['GetObject','HeadObject','HeadBucket'].includes(action)) usage.r2_class_b+=row.sum!.requests;
  else if(['ListBuckets','ListObjects','PutObject','CopyObject','CreateMultipartUpload','ListMultipartUploads','UploadPart','UploadPartCopy','CompleteMultipartUpload','ListParts','PutBucket'].includes(action)) usage.r2_class_a+=row.sum!.requests;
  else if(!['DeleteObject','DeleteObjects','AbortMultipartUpload','DeleteBucket'].includes(action)) throw Error('unknown R2 action');
 }
 return usage;
}
async function storeBudget(env:Env,state:BudgetState) {
 const previous=await env.PENDING.get<BudgetState>('budget','json');
 if(JSON.stringify(previous)!==JSON.stringify(state)) await env.PENDING.put('budget',JSON.stringify(state));
 cached=undefined;
}
export async function setExternalGate(env:Env,blocked:boolean,fetcher:typeof fetch=fetch) {
 if(!env.CF_GUARD_TOKEN||!env.CF_ZONE_ID||!env.WAF_RULESET_ID||!env.WAF_RULE_ID) throw Error('external gate unconfigured');
 const path=`zones/${env.CF_ZONE_ID}/rulesets/${env.WAF_RULESET_ID}/rules/${env.WAF_RULE_ID}`;
 const api=async(method:string,body?:unknown)=>{
  const res=await fetcher(`https://api.cloudflare.com/client/v4/${path}`,{method,headers:{authorization:`Bearer ${env.CF_GUARD_TOKEN}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  if(!res.ok) throw Error('external gate HTTP failure');
  const data=await res.json() as {success:boolean;result?:{enabled:boolean}};
  if(!data.success||typeof data.result?.enabled!=='boolean') throw Error('external gate invalid response');return data.result;
 };
 if((await api('GET')).enabled!==blocked) {
  await api('PATCH',{action:'block',expression:env.WAF_API_EXPRESSION,enabled:blocked,description:'Agents Hot emergency gate'});
  if((await api('GET')).enabled!==blocked) throw Error('external gate readback mismatch');
 }
}
// This latch is independent of Cron/Analytics and requires an explicit operator recovery.
export async function billingControl(env:Env,restore=false,fetcher:typeof fetch=fetch) {
 const state:BudgetState={level:restore?0:4,month:new Date().toISOString().slice(0,7),reason:restore?'operator_recovery':'billing_alert',latched:!restore};
 if(!restore) {await env.PENDING.put('billing-latch','true');await storeBudget(env,state);}
 await setExternalGate(env,!restore,fetcher);
 if(restore) {await env.PENDING.delete('billing-latch');await storeBudget(env,state);}
 return state;
}
export async function runBudgetGuard(env:Env,fetcher:typeof fetch=fetch,now=new Date()) {
 if(env.BUDGET_ENABLED!=='true') return;
 let previous:BudgetState|null=null;
 try {previous=await env.PENDING.get<BudgetState>('budget','json');}catch{}
 const old=validState(previous)?previous:{level:0,month:now.toISOString().slice(0,7),reason:'awaiting_first_sample'};
 let state:BudgetState;
 try {
  if(!env.CF_ANALYTICS_TOKEN||!env.CF_ACCOUNT_ID) throw Error('missing analytics configuration');
  const first=new Date(billingWindow(env,now).start).toISOString();
  const res=await fetcher('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:`Bearer ${env.CF_ANALYTICS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query:env.USAGE_QUERY||USAGE_QUERY,variables:{accountTag:env.CF_ACCOUNT_ID,start:first,end:now.toISOString(),startDate:first.slice(0,10),endDate:now.toISOString().slice(0,10),storageStart:now.toISOString().slice(0,10)+'T00:00:00.000Z'}}),signal:AbortSignal.timeout(5000)});
  if(!res.ok) throw Error('analytics HTTP failure');
  const data=await res.json() as {errors?:unknown;data?:{viewer?:{accounts?:Record<string,Rows>[]}}};
  if(data.errors||!data.data?.viewer?.accounts?.[0]) throw Error('analytics invalid response');
  state=budgetLevel(parseUsage(data.data.viewer.accounts[0]),env,now);
  if(state.reason.startsWith('usage_unavailable')) throw Error('incomplete usage');
  state.failures=0;
 } catch {
  const failures=(old.failures||0)+1;
  state={...old,failures,reason:'analytics_failure',level:failures>=numberSetting(env.USAGE_FAILURE_THRESHOLD,3)?Math.max(3,old.level):old.level};
  console.warn(JSON.stringify({service:'agents-hot',event:'analytics_failure',failures,level:state.level}));
 }
 if(old.latched||await env.PENDING.get('billing-latch')==='true') state={...state,level:4,latched:true,reason:'billing_alert'};
 if(state.level>old.level||state.latched) await storeBudget(env,state);
 try {
  await setExternalGate(env,state.level>=4,fetcher);
  await storeBudget(env,state);return {state,external_gate:true};
 } catch {
  console.warn(JSON.stringify({service:'agents-hot',event:'external_gate_failed'}));
  state={...state,level:Math.max(old.level,state.level),reason:'external_gate_failed'};
  await storeBudget(env,state);return {state,external_gate:false};
 }
}
