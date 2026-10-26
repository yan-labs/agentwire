// OpenCLI drives the user's Chrome; credentials remain in captured process pipes and memory.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.SITE_BASE||'http://127.0.0.1:4397',local=/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base);
assert(local||base==='https://agents.hot','Only local fixture or the explicitly authorized production site');
const out=process.env.AW_TEST_OUTPUT||'/tmp/aw-deploy',session=local?'aw-deploy-local-e2e':'aw-deploy-mobile-e2e';mkdirSync(out,{recursive:true});
const oc=(...args)=>execFileSync('opencli',['browser',session,...args],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
const read=js=>JSON.parse(oc('eval',`(()=>({value:(()=>{${js}})()}))()`)).value;
const checks=[],identities=[];let room,owner;
const check=(name,condition)=>{assert(condition,name);checks.push(name);console.log('PASS '+name);};
const api=async(method,path,token,body)=>{const r=await fetch(base+'/v1'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:r.status===204?null:await r.json()};};
try {
 oc('open',base+'/console');oc('viewport','set','390','844');oc('state');
 if(local&&read('return !!localStorage.getItem("agentshot.token");')){const old=read('return localStorage.getItem("agentshot.token");');const me=await api('GET','/me',old);assert(me.status===401||me.data.name?.startsWith('aw-'),'Do not replace unrelated local identity');if(me.status===200)await api('DELETE','/me',old);oc('open',base+'/console');oc('state');}
 oc('wait','selector','#tab-create');oc('click','#tab-create');oc('wait','selector','#name');
 check('registration page renders',read('return document.title.includes("Agents Hot")&&!!document.querySelector("#name");'));
 if(local)oc('eval',`(()=>{const real=window.fetch;window.fetch=(input,init)=>{if(input==='/v1/agents'&&init?.method==='POST'){const body=JSON.parse(init.body);body.turnstile_token='local-browser-proof';init={...init,body:JSON.stringify(body)};}return real(input,init);};return true;})()`);
 oc('type','#name','aw-release-'+Date.now());
 if(!local)oc('wait','selector','[name="cf-turnstile-response"][value]:not([value=""])','--timeout','60000');
 oc('click','button[type=submit]');oc('wait','selector','dialog #ack-saved');
 owner=read('return document.querySelector("dialog input.secret").value;');identities.push(owner);
 check(local?'UI registration with local provider fixture':'real Turnstile UI registration',/^[a-f0-9]{64}$/.test(owner));
 oc('check','#ack-saved');oc('click','dialog button.btn-primary');oc('wait','selector','#new-room');
 check('token saved without URL exposure',read('return !!localStorage.getItem("agentshot.token")&&!location.href.includes(localStorage.getItem("agentshot.token"));'));
 oc('click','#new-room');oc('wait','selector','#composer');room=read('return location.hash.split("/room/")[1].split("/")[0];');check('UI room creation',room.startsWith('room_'));
 oc('type','#composer','Release browser message. OVER');oc('click','#send');oc('wait','text','Release browser message.');check('mobile UI message sent',(await api('GET','/rooms/'+room+'/messages',owner)).data.messages.some(m=>m.text==='Release browser message. OVER'));
 check('mobile console fits viewport',read('return document.documentElement.scrollWidth<=innerWidth+1;'));
 oc('screenshot',out+(local?'/local-console.png':'/production-mobile-console.png'));
 oc('click','#tab-invite');oc('wait','selector','#create-invite');oc('click','#create-invite');oc('wait','selector','#new-invite');
 const invites=await api('GET','/rooms/'+room+'/invites',owner);check('UI invitation created and listed',invites.status===200&&invites.data.invites.length===1);
 oc('state');oc('click','button.btn-danger-outline');oc('wait','selector','dialog');oc('click','dialog button.btn-danger');
 check('UI invitation revoked',(await api('GET','/rooms/'+room+'/invites',owner)).data.invites.length===0);
 const peer=await api('POST','/agents',null,{name:'aw-release-peer'});assert.equal(peer.status,201);identities.push(peer.data.token);
 const invite=await api('POST','/rooms/'+room+'/invites',owner,{});assert.equal(invite.status,201);
 const accepted=await api('POST','/invites/'+invite.data.code+'/accept',peer.data.token,{});check('real invitation accepted',accepted.status===201||accepted.status===200);
 const errors=JSON.parse(oc('console'));check('real browser console capture',errors.captureSupported===true);
 const entries=errors.entries||errors.messages||[];check('no browser JavaScript errors',!entries.some(e=>(e.level||e.type)==='pageerror'));
} finally {
 if(room&&owner)check('test room deleted',(await api('DELETE','/rooms/'+room,owner)).status===200);
 for(const token of identities)check('test identity deleted',(await api('DELETE','/me',token)).status===200);
 oc('close');writeFileSync(out+(local?'/local-site-e2e.json':'/production-site-e2e.json'),JSON.stringify({checks},null,2));
}
console.log('SITE E2E PASS ('+checks.length+' checks)');
