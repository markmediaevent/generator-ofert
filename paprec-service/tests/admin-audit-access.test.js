'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const app=read('public/app.js');
const management=read('public/management.js');
const history=read('login-history.js');
const server=read('server.js');
const html=read('public/index.html');

assert.match(history,/app\.get\('\/api\/admin\/login-history',auth,adminOnly,/);
assert.match(server,/function adminOnly\(req,res,next\)\{if\(req\.user\.role!=='admin'\)return problem\(res,403,/);
assert.match(app,/restrictAdminSections\(isAdmin\);/);
assert.match(app,/function logoutLocal\(\)\{\s*state\.sessionEpoch\+\+;\s*purgeAdminData\(\);/);
assert.match(app,/const epoch=\+\+state\.sessionEpoch;\s*\/\/.*\n purgeAdminData\(\);/);
assert.match(management,/if\(epoch!==state\.sessionEpoch\|\|state\.me\?\.role!=='admin'\)return;/);

const start=app.indexOf('const adminSectionIds=');
const end=app.indexOf('function logoutLocal(){',start);
assert.ok(start>=0&&end>start,'Private UI protection section must exist');
const nodes=new Map(),visible=new Map();
function element(id){
 if(!nodes.has(id))nodes.set(id,{
  inert:false,attributes:{},textContent:'',value:'',children:['previous'],
  setAttribute(key,value){this.attributes[key]=value;},
  replaceChildren(){this.children=[];this.textContent='';}
 });
 return nodes.get(id);
}
const state={users:[{username:'admin-secret'}],organizations:[{name:'private'}]};
const adminUI=new Function('state','$','show','clear',
 app.slice(start,end)+'\nreturn {adminSectionIds,restrictAdminSections,purgeAdminData};')(
 state,element,(id,show)=>visible.set(id,show),el=>el.replaceChildren()
);
adminUI.restrictAdminSections(true);
for(const id of adminUI.adminSectionIds){
 assert.equal(visible.get(id),true);
 assert.equal(element(id).inert,false);
}
element('login-history-list').textContent='192.0.2.40 / admin';
element('login-history-list').children=['private IP'];
element('login-history-org').children=['client org info'];
adminUI.purgeAdminData();
for(const id of adminUI.adminSectionIds){
 assert.equal(visible.get(id),false,id+' must be invisible for a client');
 assert.equal(element(id).inert,true,id+' must not be focusable for a client');
 assert.equal(element(id).attributes['aria-hidden'],'true');
}
assert.equal(element('login-history-list').textContent,'');
assert.equal(element('login-history-list').children.length,0);
assert.equal(element('login-history-org').children.length,0);
assert.equal(state.users.length,0);
assert.equal(state.organizations.length,0);
for(const id of adminUI.adminSectionIds){
 assert.match(html,new RegExp('id="'+id+'"[^>]*\\binert\\b[^>]*aria-hidden="true"'),'Admin panel initially hidden and inert');
}
console.log('Admin-only audit regression checks passed.');
