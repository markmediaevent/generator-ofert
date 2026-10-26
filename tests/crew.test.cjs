const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
test('crew authorization, validation, persistence and legacy packlist compatibility',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mm-crew-'));
 let child;
 const base='http://127.0.0.1:31987';
 async function start(){
  child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'31987',STORAGE_DIR:dir,ADMIN_USER:'testadmin',ADMIN_PASS:'test-password',GITHUB_TOKEN:'',GITHUB_OWNER:'',GITHUB_REPO:''},stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('start timeout');
 }
 async function stop(){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
 async function api(url,token,method='GET',body){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};}
 async function login(username){return (await api('/api/login',null,'POST',{username,password:'test-password'})).token;}
 try{
  await start();const admin=await login('testadmin');
  const worker=(await api('/api/admin/users',admin,'POST',{username:'worker',password:'test-password',role:'pracownik'})).user;
  await api('/api/admin/users',admin,'POST',{username:'manager',password:'test-password',role:'realizator'});
  const workerToken=await login('worker'),manager=await login('manager');
  const endpoint='/api/packlists/test-event';
  assert.equal((await api(endpoint,null)).status,401);
  assert.equal((await api(endpoint+'/crew-users',workerToken)).status,403);
  const users=await api(endpoint+'/crew-users',manager);
  assert.ok(users.users.some(u=>u.id===worker.id));assert.ok(users.users.every(u=>!('password' in u)&&!('createdAt' in u)));
  const payload={action:'setCrewAssignment',userId:worker.id,selected:true,departure:'2026-10-26T20:00',returnAt:'2026-10-27T03:00',expectedUpdatedAt:''};
  assert.equal((await api(endpoint,workerToken,'PATCH',payload)).status,403);
  assert.equal((await api(endpoint,manager,'PATCH',{...payload,userId:'missing'})).status,400);
  assert.equal((await api(endpoint,manager,'PATCH',{...payload,departure:'2026-02-30T12:00'})).status,400);
  assert.equal((await api(endpoint,manager,'PATCH',{...payload,returnAt:'2026-10-25T12:00'})).status,400);
  let result=await api(endpoint,manager,'PATCH',payload);assert.equal(result.status,200);assert.equal(result.data.crewAssignments[0].departure,payload.departure);
  assert.equal((await api(endpoint,manager,'PATCH',payload)).status,409);
  await api(endpoint,admin,'PATCH',{...payload,userId:users.users.find(u=>u.username==='testadmin').id});
  assert.equal((await api(endpoint,workerToken)).data.crewAssignments.length,1);
  result=await api(endpoint,workerToken,'PATCH',{action:'setChecked',id:'item1',value:true});assert.equal(result.data.crewAssignments.length,1);
  await api(endpoint,workerToken,'PUT',{checked:{item1:true},notes:{item1:'test'}});
  assert.equal((await api(endpoint,admin)).data.crewAssignments.length,2);
  const archive=path.join(dir,'drafts','sentinel.json');fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'{"unchanged":true}');
  const equipment=fs.readFileSync(path.join(dir,'equipment-db.json'));
  await stop();await start();const fresh=await login('testadmin');
  result=await api(endpoint,fresh);assert.equal(result.data.crewAssignments.length,2);assert.equal(result.data.notes.item1,'test');
  assert.deepEqual(fs.readFileSync(path.join(dir,'equipment-db.json')),equipment);assert.equal(fs.readFileSync(archive,'utf8'),'{"unchanged":true}');
  const own=result.data.crewAssignments.find(a=>a.userId===worker.id);
  assert.equal((await api(endpoint,fresh,'PATCH',{...payload,selected:false,expectedUpdatedAt:own.updatedAt})).data.crewAssignments.length,1);
  const html=fs.readFileSync('public/app.html','utf8');assert.match(html,/<a href="\$\{escapeHtml\(new URL\('\/wrzutka', window.location.origin\).href\)\}"/);
 }finally{if(child&&child.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true});}
});
