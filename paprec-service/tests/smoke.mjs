import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';

const port = 18182;
const base = 'http://127.0.0.1:'+port;
const db = process.env.TEST_DATABASE_URL;
if(!db) throw new Error('TEST_DATABASE_URL missing');
const adminPass='S-'+randomBytes(24).toString('hex');
const clientPass='S-'+randomBytes(24).toString('hex');
const vapid=webpush.generateVAPIDKeys();
const child=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url).pathname,
 env:{...process.env,PORT:String(port),DATABASE_URL:db,INIT_ADMIN_PASSWORD:adminPass,INIT_CLIENT_PASSWORD:clientPass,NODE_ENV:'test',VAPID_SUBJECT:'mailto:test@example.com',VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey}, stdio:'inherit'});
const tryHttp=async(path,opts={})=>fetch(base+path,opts);
async function ready(){
 for(let i=0;i<40;i++){
  if(child.exitCode!==null)throw new Error('Server exited before startup '+child.exitCode);
  try{const r=await tryHttp('/api/health');if(r.ok)return;}catch{}
  await sleep(350);
 }
 throw new Error('Health check did not become ready');
}
async function api(path,body,method='GET',cookie=''){
 const headers={'Content-Type':'application/json'};
 if(cookie)headers.Cookie=cookie;
 const r=await tryHttp(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 let json;try{json=await r.json();}catch{json=null}
 return {r,json};
}
async function login(username,password){
 const {r,json}=await api('/api/login',{username,password},'POST');
 assert.equal(r.status,200,JSON.stringify(json));
 assert.ok(r.headers.get('set-cookie')?.includes('HttpOnly'));
 const cookie=r.headers.get('set-cookie').split(';')[0];
 return cookie;
}
try{
 await ready();
 const unauth=await api('/api/tickets');
 assert.equal(unauth.r.status,401);
 const bad=await api('/api/login',{username:'paprec',password:'incorrect'},'POST');
 assert.equal(bad.r.status,401);
 const client=await login('paprec',clientPass);
 const external=await tryHttp('/api/login',{method:'POST',headers:{Origin:'https://marknet.com.pl','Content-Type':'application/json'},body:JSON.stringify({username:'paprec',password:clientPass})});
 assert.equal(external.status,200);
 const extJson=await external.json();assert.match(extJson.accessToken,/^[a-f0-9]{64}$/);
 const remote=await tryHttp('/api/me',{headers:{Origin:'https://marknet.com.pl',Authorization:'Bearer '+extJson.accessToken}});
 assert.equal(remote.status,200);assert.equal((await remote.json()).role,'client');
 assert.equal(remote.headers.get('access-control-allow-origin'),'https://marknet.com.pl');
 const preflight=await tryHttp('/api/tickets',{method:'OPTIONS',headers:{Origin:'https://marknet.com.pl','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}});
 assert.equal(preflight.status,204);
 const me=await api('/api/me',undefined,'GET',client);
 assert.equal(me.json.role,'client');
 const {r:created,json:creation}=await api('/api/tickets',{
  kind:'Awaria', priority:'Krytyczny',category:'Połączenia GPEC',
  title:'Test awarii GPEC — łącze nie odpowiada',area:'Obiekt testowy',device:'Switch testowy',requester_name:'Tester PAPREC',requester_email:'test@example.com',
  description:'Test automatyczny: połączenie nie odpowiada od 07:15, wymaga diagnostyki.'
 },'POST',client);
 assert.equal(created.status,201,JSON.stringify(creation));
 const id=creation.ticket.id;
 assert.ok(creation.ticket.number.startsWith('MN-'));
 assert.equal((await api('/api/tickets/'+id,undefined,'GET',client)).r.status,200);
 assert.equal((await api('/api/tickets/'+id,{status:'W realizacji'},'PATCH',client)).r.status,403);
 assert.equal((await api('/api/reports/tickets/'+id+'.pdf',undefined,'GET',client)).r.status,403);
 const admin=await login('marknet',adminPass);
 const note=await api('/api/tickets/'+id,{event:'acknowledge',details:'Połączono z urządzeniem, weryfikacja rozpoczęta'},'PATCH',admin);
 assert.equal(note.r.status,200,JSON.stringify(note.json));
 const queued=await api('/api/admin/notifications',undefined,'GET',admin);
 assert.equal(queued.r.status,200);
 assert.equal(queued.json.jobs.filter(x=>String(x.ticket_id)===String(id)).length,3);
 const seen=await api('/api/tickets/'+id,undefined,'GET',admin);
 assert.equal(seen.json.ticket.status,'Weryfikacja');
 assert.ok(seen.json.ticket.acknowledged_at);
 const comment=await api('/api/tickets/'+id+'/events',{body:'Potwierdzono brak komunikacji z łączem testowym.'},'POST',client);
 assert.equal(comment.r.status,201);
 const pdf=await tryHttp('/api/reports/tickets/'+id+'.pdf',{headers:{Cookie:admin}});
 assert.equal(pdf.status,200);
 assert.match(pdf.headers.get('content-type'),/application\/pdf/);
 const buf=Buffer.from(await pdf.arrayBuffer());assert.equal(buf.subarray(0,5).toString(),'%PDF-');
 const month=new Date().toISOString().slice(0,7);
 const csv=await tryHttp('/api/reports/month.csv?month='+month,{headers:{Cookie:admin}});
 assert.equal(csv.status,200);
 assert.match(await csv.text(),/MN-/);
 const key=await api('/api/push/public-key',undefined,'GET',admin);
 assert.equal(key.r.status,200);assert.equal(key.json.publicKey,vapid.publicKey);
 const clientPush=await api('/api/push/public-key',undefined,'GET',client);
 assert.equal(clientPush.r.status,403);
 const subscribe=await api('/api/push/subscribe',{subscription:{
  endpoint:'https://fcm.googleapis.com/fcm/send/ci-test-endpoint',
  keys:{p256dh:randomBytes(65).toString('base64url'),auth:randomBytes(16).toString('base64url')}
 }},'POST',admin);
 assert.equal(subscribe.r.status,201);
 const users=await api('/api/admin/users',undefined,'GET',admin);
 assert.equal(users.r.status,200);
 const clientUser=users.json.users.find(u=>u.username==='paprec');
 assert.ok(clientUser);
 const newPassword='New-'+randomBytes(24).toString('hex');
 const reset=await api('/api/admin/users/'+clientUser.id+'/reset-password',{newPassword},'POST',admin);
 assert.equal(reset.r.status,200);
 const newClient=await login('paprec',newPassword);
 assert.ok(newClient);
 const origins=await tryHttp('/api/login',{method:'POST',headers:{Origin:'https://unauthorized.example','Content-Type':'application/json'},body:JSON.stringify({username:'paprec',password:clientPass})});
 assert.equal(origins.status,403);
 console.log('SMOKE TEST PASSED: auth, RBAC, ticket, events, PDF, CSV, CSRF guard');
}finally{
 child.kill('SIGTERM');
 await sleep(300);
}