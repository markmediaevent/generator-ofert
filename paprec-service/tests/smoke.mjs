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
 env:{...process.env,PORT:String(port),DATABASE_URL:db,INIT_ADMIN_PASSWORD:adminPass,INIT_CLIENT_PASSWORD:clientPass,NODE_ENV:'test',MARKNET_TEST_SMTP:'1',SMTP_FROM:'MarkNet Test <test-marknet@example.com>',ADMIN_NOTIFY_EMAIL:'admin@example.com',VAPID_SUBJECT:'mailto:test@example.com',VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey}, stdio:'inherit'});
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
 const admin=await login('marknet',adminPass);
 const seedUsers=await api('/api/admin/users',undefined,'GET',admin);
 const seedPaprec=seedUsers.json.users.find(u=>u.username==='paprec');
 assert.ok(seedPaprec);
 assert.equal(seedPaprec.email,null);
 const seedUpdate=await api('/api/admin/users/'+seedPaprec.id,
  {organization_id:seedPaprec.organization_id,email:'paprec.test@example.org',first_name:'Tester',last_name:'PAPREC',is_active:true},'PATCH',admin);
 assert.equal(seedUpdate.r.status,200,JSON.stringify(seedUpdate.json));
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
 assert.equal(me.json.email,'paprec.test@example.org');
 assert.equal(me.json.first_name,'Tester');
 assert.equal(me.json.last_name,'PAPREC');
 const {r:created,json:creation}=await api('/api/tickets',{
  kind:'Awaria', priority:'Krytyczny',category:'Połączenia GPEC',
  area:'Obiekt testowy',device:'Switch testowy',requester_name:'Tester PAPREC',requester_email:'spoofed@somewhere.example',
  description:'Test automatyczny: połączenie nie odpowiada od 07:15, wymaga diagnostyki.'
 },'POST',client);
 assert.equal(created.status,201,JSON.stringify(creation));
 const id=creation.ticket.id;
 assert.ok(creation.ticket.number.startsWith('MN-'));
 assert.equal(creation.ticket.requester_email,'paprec.test@example.org');
 assert.equal(creation.ticket.requester_name,'Tester PAPREC');
 assert.equal(creation.ticket.title,'Awaria – Połączenia GPEC – Obiekt testowy');
 assert.equal((await api('/api/tickets/'+id,undefined,'GET',client)).r.status,200);
 assert.equal((await api('/api/tickets/'+id,{status:'W realizacji'},'PATCH',client)).r.status,403);
 assert.equal((await api('/api/reports/tickets/'+id+'.pdf',undefined,'GET',client)).r.status,403);
 const clientPdf=await tryHttp('/api/tickets/'+id+'/confirmation.pdf',{headers:{Cookie:client}});
 assert.equal(clientPdf.status,200);
 assert.equal(Buffer.from(await clientPdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
 const note=await api('/api/tickets/'+id,{event:'acknowledge',details:'Połączono z urządzeniem, weryfikacja rozpoczęta'},'PATCH',admin);
 assert.equal(note.r.status,200,JSON.stringify(note.json));
 const queued=await api('/api/admin/notifications',undefined,'GET',admin);
 assert.equal(queued.r.status,200);
 assert.equal(queued.json.jobs.filter(x=>String(x.ticket_id)===String(id)).length,3);
 let doneMail=false;
 for(let tries=0;tries<40;tries++){
  const r=await api('/api/admin/notifications',undefined,'GET',admin);
  const jobs=r.json.jobs.filter(x=>String(x.ticket_id)===String(id));
  const confirmed=jobs.find(x=>x.kind==='confirmation');
  const adminCopy=jobs.find(x=>x.kind==='admin_email');
  if(confirmed?.status==='delivered'&&adminCopy?.status==='delivered'){doneMail=true;break;}
  await sleep(250);
 }
 assert.equal(doneMail,true,'Both client PDF confirmation and admin notification must be sent automatically');
 const delivered=await api('/api/admin/notifications',undefined,'GET',admin);
 const jobsForFirst=delivered.json.jobs.filter(x=>String(x.ticket_id)===String(id));
 assert.equal(jobsForFirst.find(x=>x.kind==='confirmation').attempt_count,0);
 assert.equal(jobsForFirst.find(x=>x.kind==='admin_email').attempt_count,0);
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
 const orgResult=await api('/api/admin/organizations',{name:'Drugi klient testowy',systems:['CCTV','Telefonia']},'POST',admin);
 assert.equal(orgResult.r.status,201,JSON.stringify(orgResult.json));
 const newOrgId=orgResult.json.organization.id;
 const orgList=await api('/api/admin/organizations',undefined,'GET',admin);
 assert.equal(orgList.r.status,200);
 assert.ok(orgList.json.organizations.find(o=>String(o.id)===String(newOrgId)));
 assert.equal((await api('/api/admin/organizations',{name:'Nieuprawniona',systems:['CCTV']},'POST',newClient)).r.status,403);
 const loginName='demo'+randomBytes(4).toString('hex');
 const newUser=await api('/api/admin/users',{username:loginName,email:'demo.client@example.org',first_name:'Adam',last_name:'Próbny',password:'Haslo123',organization_id:newOrgId},'POST',admin);
 assert.equal(newUser.r.status,201,JSON.stringify(newUser.json));
 assert.equal(newUser.json.user.email,'demo.client@example.org');
 assert.equal(newUser.json.user.first_name,'Adam');
 assert.equal(newUser.json.user.last_name,'Próbny');
 const newClientCookie=await login(loginName,'Haslo123');
 const clientMeta=await api('/api/meta',undefined,'GET',newClientCookie);
 assert.deepEqual(clientMeta.json.categories,['CCTV','Telefonia']);
 assert.equal(clientMeta.json.clientName,'Drugi klient testowy');
 assert.equal((await api('/api/me',undefined,'GET',newClientCookie)).json.email,'demo.client@example.org');
 const denied=await api('/api/tickets',{kind:'Awaria',priority:'Standardowy',category:'Połączenia GPEC',
  title:'Zablokowana kategoria GPEC',requester_name:'Test Klient',requester_email:'client@example.org',
  description:'Ten system nie należy do podpisanej umowy z klientem.'},'POST',newClientCookie);
 assert.equal(denied.r.status,400);
 const createdOther=await api('/api/tickets',{
  kind:'Usterka',priority:'Standardowy',category:'CCTV',organization_id:me.json.organization_id,
  requester_name:'Podmieniona nazwa',requester_email:'client@example.org',
  description:'Zgłoszenie z niezależnego klienta testowego.'
 },'POST',newClientCookie);
 assert.equal(createdOther.r.status,201,JSON.stringify(createdOther.json));
 const secondTicket=createdOther.json.ticket.id;
 assert.equal(String(createdOther.json.ticket.organization_id),String(newOrgId));
 assert.equal(createdOther.json.ticket.requester_email,'demo.client@example.org');
 assert.equal(createdOther.json.ticket.requester_name,'Adam Próbny');
 assert.equal(createdOther.json.ticket.title,'Usterka – CCTV');
 assert.equal((await api('/api/tickets/'+id,undefined,'GET',newClientCookie)).r.status,404);
 assert.equal((await api('/api/tickets/'+id+'/events',{body:'Nie wolno'},'POST',newClientCookie)).r.status,404);
 assert.equal((await api('/api/tickets/'+id+'/confirmation.pdf',undefined,'GET',newClientCookie)).r.status,404);
 assert.equal((await api('/api/tickets/'+secondTicket,undefined,'GET',newClient)).r.status,404);
 assert.equal((await api('/api/tickets',undefined,'GET',newClientCookie)).json.tickets.some(t=>String(t.id)===String(id)),false);
 assert.equal((await api('/api/tickets',undefined,'GET',newClient)).json.tickets.some(t=>String(t.id)===String(secondTicket)),false);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAJzVRuoAAAAASUVORK5CYII=','base64');
 const imageForm=new FormData();imageForm.append('file',new Blob([png],{type:'image/png'}),'kamera.png');
 const imageRes=await tryHttp('/api/tickets/'+secondTicket+'/attachments',{method:'POST',headers:{Cookie:newClientCookie},body:imageForm});
 assert.equal(imageRes.status,201,await imageRes.text());
 const secondDetails=await api('/api/tickets/'+secondTicket,undefined,'GET',newClientCookie);
 assert.equal(secondDetails.json.files.length,1);
 const fileId=secondDetails.json.files[0].id;
 assert.equal((await api('/api/attachments/'+fileId,undefined,'GET',newClient)).r.status,404);
 assert.equal((await tryHttp('/api/attachments/'+fileId,{headers:{Cookie:newClientCookie}})).status,200);
 const corsDelete=await tryHttp('/api/tickets/'+secondTicket,{method:'OPTIONS',headers:{Origin:'https://marknet.com.pl','Access-Control-Request-Method':'DELETE','Access-Control-Request-Headers':'Authorization'}});
 assert.equal(corsDelete.status,204);
 assert.match(corsDelete.headers.get('access-control-allow-methods'),/DELETE/);
 assert.equal((await api('/api/tickets/'+secondTicket,undefined,'DELETE',newClientCookie)).r.status,403);
 const removedTicket=await api('/api/tickets/'+secondTicket,undefined,'DELETE',admin);
 assert.equal(removedTicket.r.status,200,JSON.stringify(removedTicket.json));
 assert.equal((await api('/api/tickets/'+secondTicket,undefined,'GET',newClientCookie)).r.status,404);
 assert.equal((await api('/api/tickets/'+secondTicket+'/confirmation.pdf',undefined,'GET',admin)).r.status,404);
 assert.equal((await api('/api/attachments/'+fileId,undefined,'GET',admin)).r.status,404);
 assert.equal((await api('/api/tickets',undefined,'GET',admin)).json.tickets.some(t=>String(t.id)===String(secondTicket)),false);
 const removedList=await api('/api/admin/archived-tickets',undefined,'GET',admin);
 assert.ok(removedList.json.tickets.find(t=>String(t.id)===String(secondTicket)));
 assert.equal((await api('/api/admin/archived-tickets',undefined,'GET',newClientCookie)).r.status,403);
 const monthSecond=new Date().toISOString().slice(0,7);
 const csvAfter=await tryHttp('/api/reports/month.csv?month='+monthSecond,{headers:{Cookie:admin}});
 assert.equal(csvAfter.status,200);
 assert.equal((await csvAfter.text()).includes(createdOther.json.ticket.number),false);
 const restoreTicket=await api('/api/admin/tickets/'+secondTicket+'/restore',{},'POST',admin);
 assert.equal(restoreTicket.r.status,200,JSON.stringify(restoreTicket.json));
 assert.equal((await api('/api/tickets/'+secondTicket,undefined,'GET',newClientCookie)).r.status,200);
 assert.equal((await api('/api/attachments/'+fileId,undefined,'GET',newClientCookie)).r.status,200);
 const editedOrg=await api('/api/admin/organizations/'+newOrgId,{name:'Drugi klient testowy',systems:['CCTV'],is_active:true},'PATCH',admin);
 assert.equal(editedOrg.r.status,200);
 assert.deepEqual((await api('/api/meta',undefined,'GET',newClientCookie)).json.categories,['CCTV']);
 const suspended=await api('/api/admin/organizations/'+newOrgId,{name:'Drugi klient testowy',systems:['CCTV'],is_active:false},'PATCH',admin);
 assert.equal(suspended.r.status,200);
 assert.equal((await api('/api/me',undefined,'GET',newClientCookie)).r.status,401);
 assert.equal((await api('/api/login',{username:loginName,password:'Haslo123'},'POST')).r.status,401);
 const resumed=await api('/api/admin/organizations/'+newOrgId,{name:'Drugi klient testowy',systems:['CCTV'],is_active:true},'PATCH',admin);
 assert.equal(resumed.r.status,200);
 const resumedClient=await login(loginName,'Haslo123');
 assert.ok(resumedClient);
 const disabled=await api('/api/admin/users/'+newUser.json.user.id,{organization_id:newOrgId,email:'demo.updated@example.org',first_name:'Adam',last_name:'Próbny',is_active:false},'PATCH',admin);
 assert.equal(disabled.r.status,200);
 assert.equal(disabled.json.user.email,'demo.updated@example.org');
 assert.equal((await api('/api/me',undefined,'GET',newClientCookie)).r.status,401);
 assert.equal((await api('/api/login',{username:loginName,password:'Haslo123'},'POST')).r.status,401);
 const removedUser=await api('/api/admin/users/'+newUser.json.user.id,undefined,'DELETE',admin);
 assert.equal(removedUser.r.status,200);
 assert.equal((await api('/api/admin/users',undefined,'GET',admin)).json.users.some(u=>String(u.id)===String(newUser.json.user.id)),false);
 assert.equal((await api('/api/login',{username:loginName,password:'Haslo123'},'POST')).r.status,401);
 assert.equal((await api('/api/admin/users/'+newUser.json.user.id,undefined,'DELETE',newClient)).r.status,403);
  const origins=await tryHttp('/api/login',{method:'POST',headers:{Origin:'https://unauthorized.example','Content-Type':'application/json'},body:JSON.stringify({username:'paprec',password:clientPass})});
 assert.equal(origins.status,403);
 console.log('SMOKE TEST PASSED: auth, tenant isolation, user accounts, images, PDF, CSV, real email queue handling, admin copy, ticket archive/restore, account removal and company suspension');
}finally{
 child.kill('SIGTERM');
 await sleep(300);
}