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
  assert.equal((await api('/api/admin/login-history',null)).status,401);
  assert.equal((await api('/api/admin/login-history',workerToken)).status,403);
  assert.equal((await api('/api/admin/login-history',manager)).status,403);
  let history=await api('/api/admin/login-history?role=pracownik',admin);
  assert.equal(history.status,200);assert.equal(history.entries.length,1);assert.equal(history.entries[0].username,'worker');
  assert.ok(history.entries.every(row=>!('password' in row)&&!('token' in row)));
  const before=history.total;
  assert.equal((await api('/api/login',null,'POST',{username:'worker',password:'invalid'})).status,401);
  assert.equal((await api('/api/admin/login-history?role=pracownik',admin)).total,before);
  assert.equal((await api('/api/admin/login-history?offset=-1',admin)).status,400);
  const endpoint='/api/packlists/test-event';
  fs.mkdirSync(path.join(dir,'drafts'),{recursive:true});
  fs.writeFileSync(path.join(dir,'drafts','test-event.json'),JSON.stringify({offerNumber:'test-event',eventName:'Test'}));
  const assignedTo=async token=>(await api('/api/packlist-offers',token)).offers.find(o=>o.offerNumber==='test-event')?.assignedToMe||false;
  assert.equal(await assignedTo(workerToken),false);
  async function assertBlocked(token){
    assert.equal((await api('/api/packlist-offers',token)).offers.length,0);
    for(const suffix of ['', '/brief','/crew-users'])assert.equal((await api(endpoint+suffix,token)).status,403);
    assert.equal((await api(endpoint,token,'PATCH',{action:'setChecked',id:'blocked',value:true})).status,403);
    assert.equal((await api(endpoint,token,'PUT',{checked:{blocked:true}})).status,403);
    const page=await fetch(base+'/packlist?offer=test-event',{headers:{Authorization:'Bearer '+token}});assert.equal(page.status,403);
  }
  await assertBlocked(workerToken);

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
  assert.equal(await assignedTo(workerToken),true);assert.equal(await assignedTo(manager),false);
  await api(endpoint,admin,'PATCH',{...payload,userId:users.users.find(u=>u.username==='testadmin').id});
  assert.equal((await api(endpoint,workerToken)).data.crewAssignments.length,1);
  result=await api(endpoint,workerToken,'PATCH',{action:'setChecked',id:'item1',value:true});assert.equal(result.data.crewAssignments.length,1);
  await api(endpoint,workerToken,'PUT',{checked:{item1:true},notes:{item1:'test'}});
  assert.equal((await api(endpoint,admin)).data.crewAssignments.length,2);
  const ledPayload={action:'setLedSetup',id:'screen1',config:{model:'yes-tech-p39',width:6,height:3,orientation:'vertical'},logistics:{caseSize:8,dataChainSize:10,powerChainSize:8,spares:0,pixelWidth:128,pixelHeight:128,portCapacity:650000,portCount:4,backup:true,portCabinets:'36,36'}};
  assert.equal((await api(endpoint,admin,'PATCH',{...ledPayload,logistics:{...ledPayload.logistics,portCabinets:'35,36'}})).status,400);
  assert.equal((await api(endpoint,admin,'PATCH',ledPayload)).status,200);
  const archive=path.join(dir,'drafts','sentinel.json');fs.mkdirSync(path.dirname(archive),{recursive:true});fs.writeFileSync(archive,'{"unchanged":true}');
  const equipment=fs.readFileSync(path.join(dir,'equipment-db.json'));
  await stop();await start();const fresh=await login('testadmin');
  assert.equal((await api('/api/admin/login-history?role=pracownik',fresh)).entries[0].username,'worker');
  result=await api(endpoint,fresh);assert.equal(result.data.crewAssignments.length,2);assert.equal(result.data.notes.item1,'test');assert.deepEqual(result.data.ledLogistics.screen1,ledPayload.logistics);
  assert.deepEqual(fs.readFileSync(path.join(dir,'equipment-db.json')),equipment);assert.equal(fs.readFileSync(archive,'utf8'),'{"unchanged":true}');
  const own=result.data.crewAssignments.find(a=>a.userId===worker.id);
  assert.equal((await api(endpoint,fresh,'PATCH',{...payload,selected:false,expectedUpdatedAt:own.updatedAt})).data.crewAssignments.length,1);
  const revoked=await login('worker');assert.equal(await assignedTo(revoked),false);await assertBlocked(revoked);
  assert.equal((await api(endpoint,fresh)).status,200);assert.equal((await api('/api/packlist-offers',fresh)).offers.length,2);
  const html=fs.readFileSync('public/app.html','utf8');assert.match(html,/<a href="\$\{escapeHtml\(new URL\('\/wrzutka', window.location.origin\).href\)\}"/);
 }finally{if(child&&child.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true});}
});
