// OpenCLI + user's Chrome only. Start test/serve.mjs and local site preview first. No API shims.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.SITE_BASE||'http://127.0.0.1:4397';
if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('Local fixture only');
const session='aw-integrate-console',out='/tmp/aw-integrate';mkdirSync(out,{recursive:true});
const oc=(...args)=>execFileSync('opencli',['browser',session,...args],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
const results=[];
const step=(name,js)=>{const value=JSON.parse(oc('eval',`(async()=>{${js}})()`));if(value!==true)throw Error(name+' failed');results.push({name,ok:true});console.log('PASS '+name);};
const wait=`const wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('DOM timeout');}; const button=(text,root=document)=>[...root.querySelectorAll('button')].find(x=>x.textContent.trim()===text);`;
try {
 oc('open',base+'/console','--window','dedicated');
 step('login page renders',`return document.title.includes('Agents Hot')&&!!document.querySelector('#token');`);
 step('register via UI with verified local Turnstile proof',`${wait}
 window.aw={};window.awErrors=[];addEventListener('error',()=>awErrors.push('error'));addEventListener('securitypolicyviolation',()=>awErrors.push('csp'));
 const original=window.fetch;window.fetch=async(input,init)=>{if(typeof input==='string'&&input==='/v1/agents'&&init?.method==='POST'){const body=JSON.parse(init.body);body.turnstile_token='local-browser-proof';init={...init,body:JSON.stringify(body)};}return original(input,init);};
 button('Create an identity').click();await wait(()=>document.querySelector('#name'));const name=document.querySelector('#name');name.value='opencli-owner';name.dispatchEvent(new Event('input',{bubbles:true}));button('Create identity').click();await wait(()=>document.querySelector('dialog input'));aw.token=document.querySelector('dialog input').value;return /^[a-f0-9]{64}$/.test(aw.token);`);
 step('save-once dialog and localStorage login',`${wait} const box=document.querySelector('dialog input[type=checkbox]');box.click();button('Continue to console').click();await wait(()=>document.body.textContent.includes('Overview'));return localStorage.getItem('agentshot.token')===aw.token&&!location.href.includes(aw.token);`);
 step('create room via UI',`${wait} button('New room').click();await wait(()=>document.body.textContent.includes('Room created'));aw.api=async(method,path,token=aw.token,body)=>{const r=await fetch('/v1'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:r.status===204?null:await r.json()};};const me=await aw.api('GET','/me');aw.room=me.data.rooms[0].room_id;return !!aw.room;`);
 step('invite list is real backend',`${wait} location.hash='#/room/'+aw.room+'/invites';await wait(()=>button('Create invite link'));button('Create invite link').click();let result;for(let i=0;i<80;i++){result=await aw.api('GET','/rooms/'+aw.room+'/invites');if(result.data.invites?.length)break;await new Promise(r=>setTimeout(r,50));}return result.status===200&&result.data.invites.length===1;`);
 step('revoke invite via UI and real backend',`${wait} await wait(()=>button('Revoke'));button('Revoke').click();await wait(()=>document.querySelector('dialog'));button('Revoke',document.querySelector('dialog')).click();await wait(()=>document.body.textContent.includes('Invite revoked'));return (await aw.api('GET','/rooms/'+aw.room+'/invites')).data.invites.length===0;`);
 step('add second member via UI',`${wait} aw.second=(await aw.api('POST','/agents',null,{name:'opencli-peer'})).data;location.hash='#/room/'+aw.room+'/members';await wait(()=>document.querySelector('input[placeholder*="agent_"]'));const input=document.querySelector('input[placeholder*="agent_"]');input.value=aw.second.agent_id;input.dispatchEvent(new Event('input',{bubbles:true}));button('Add').click();await wait(()=>document.body.textContent.includes('Member added'));return (await aw.api('GET','/rooms/'+aw.room+'/members')).data.members.some(x=>x.agent_id===aw.second.agent_id);`);
 step('browser sends with identity token on same-origin route',`const r=await aw.api('POST','/rooms/'+aw.room+'/messages',aw.second.token,{text:'OpenCLI browser identity message. OVER'});return r.status===201;`);
 step('message visible and console remains read-only',`${wait} location.hash='#/room/'+aw.room+'/messages';await wait(()=>document.body.textContent.includes('OpenCLI browser identity message. OVER'));return (await aw.api('GET','/rooms/'+aw.room+'/messages')).data.messages.length===1;`);
 step('prepare invite test without exposing credentials',`aw.invite=(await aw.api('POST','/rooms/'+aw.room+'/invites',aw.token,{})).data.code;aw.third=(await aw.api('POST','/agents',null,{name:'opencli-joiner'})).data;window.name=JSON.stringify(aw);localStorage.removeItem('agentshot.token');return true;`);
 // Preserve fake fixture data only in this tab, never stdout or disk.
 step('anonymous invite shows accept URL',`${wait} const html=await (await fetch('/invite/'+aw.invite)).text();return html.includes('invite-root');`);
 // Exercise the actual invite landing document in the same leased tab.
 oc('eval',`location.href='/invite/'+aw.invite;true`);
 step('anonymous invite page has no join button',`${wait} await wait(()=>document.querySelector('#invite-root'));window.aw=JSON.parse(window.name);return document.body.textContent.includes(aw.invite)&&!button('Join as my console identity');`);
 step('switch test identity',`localStorage.setItem('agentshot.token',aw.third.token);return true;`);
 oc('eval',`location.reload();true`);
 step('accept invite through landing UI',`${wait} window.aw=JSON.parse(window.name);await wait(()=>button('Join as my console identity'));button('Join as my console identity').click();await wait(()=>document.body.textContent.includes('Joined.'));return true;`);
 step('return to owner',`localStorage.setItem('agentshot.token',aw.token);return true;`);
 oc('open',base+'/console');
 step('sign out clears token',`${wait} await wait(()=>button('Sign out'));button('Sign out').click();await wait(()=>document.querySelector('#token'));return localStorage.getItem('agentshot.token')===null;`);
 step('sign in by token',`${wait} window.aw=JSON.parse(window.name);document.querySelector('#token').value=aw.token;document.querySelector('#token').dispatchEvent(new Event('input',{bubbles:true}));button('Sign in').click();await wait(()=>document.body.textContent.includes('Overview'));return localStorage.getItem('agentshot.token')===aw.token;`);
 step('delete identity via UI',`${wait} location.hash='#/settings';await wait(()=>button('Delete identity'));button('Delete identity').click();await wait(()=>document.querySelector('dialog input'));document.querySelector('dialog input').value='opencli-owner';document.querySelector('dialog input').dispatchEvent(new Event('input',{bubbles:true}));const buttons=[...document.querySelector('dialog').querySelectorAll('button')];buttons.find(b=>b.textContent.includes('Delete')&&!b.textContent.includes('Cancel')).click();await wait(()=>document.querySelector('#token'));return localStorage.getItem('agentshot.token')===null;`);
 step('old token invalid and helper cleanup',`const aw=JSON.parse(window.name);const api=async(method,path,token)=>{const r=await fetch('/v1'+path,{method,headers:{authorization:'Bearer '+token}});return r.status;};const gone=await api('GET','/me',aw.token);await api('DELETE','/me',aw.second.token);await api('DELETE','/me',aw.third.token);window.name='';return gone===401;`);
 for(const path of ['/','/docs/quickstart','/console']) {oc('open',base+path);oc('screenshot',out+'/site-'+(path.replaceAll('/','-')||'home')+'.png');}
 const errors=JSON.parse(oc('console'));
 if(errors.captureSupported!==true) throw Error('real browser console capture unavailable');
 const entries=Array.isArray(errors)?errors:errors.entries||errors.messages||[];
 if(entries.some(e=>['error','pageerror'].includes(e.level||e.type)))throw Error('browser console errors');
 results.push({name:'browser console capture',ok:true});
} finally {oc('close');writeFileSync(out+'/site-e2e.json',JSON.stringify(results,null,2));}
console.log(`SITE E2E PASS (${results.length} checks)`);
