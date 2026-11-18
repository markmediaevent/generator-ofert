'use strict';

function serviceOptions(target, available, selected) {
  target.replaceChildren();
  for(const sys of available) {
    const label=node('label','service-choice');
    const cb=document.createElement('input');cb.type='checkbox';cb.name='system';cb.value=sys;cb.checked=selected.includes(sys);
    label.append(cb,node('span','',sys));target.append(label);
  }
}
function servicesFrom(form){
 return [...form.querySelectorAll('input[name="system"]:checked')].map(x=>x.value);
}
function orgSelect(el,includeAll=false,selected=''){
 el.replaceChildren();
 if(includeAll)option(el,'Wszyscy klienci','');
 for(const o of state.organizations)option(el,o.name+(o.is_active?'':' (wstrzymany)'),String(o.id));
 if(selected && [...el.options].some(x=>x.value===selected))el.value=selected;
}
function tenantOrg(id){return state.organizations.find(o=>String(o.id)===String(id));}
function ticketCategoriesForOrg(id){
 if(state.me?.role!=='admin')return state.meta?.categories||[];
 return tenantOrg(id)?.systems||[];
}
function setTicketCategoryOptions(){
 const sel=$('new-category'),chosen=sel.value;
 const systems=ticketCategoriesForOrg($('new-organization').value);
 sel.replaceChildren();for(const x of systems)option(sel,x);
 if(systems.includes(chosen))sel.value=chosen;
}
function inputField(type,name,value='',required=false){
 const e=document.createElement('input');e.type=type;e.name=name;e.value=value;e.required=required;
 return e;
}
function makeLabel(title,child){const l=document.createElement('label');l.append(node('span','field-title',title),child);return l;}
function orgRow(org){
 const details=document.createElement('details');details.className='management-item';
 details.append(node('summary','manager-heading',org.name+' • '+org.users_count+' kont • '+org.systems.length+' systemów'));
 const form=node('form','form manager-form');
 const nameInput=inputField('text','name',org.name,true);nameInput.maxLength=140;
 const active=inputField('checkbox','is_active');active.checked=org.is_active;
 const activeLabel=makeLabel('Klient aktywny',active);activeLabel.classList.add('inline-check');
 const services=node('div','service-checklist');serviceOptions(services,state.meta.allCategories||state.meta.categories,org.systems);
 const button=node('button','btn main','Zapisz klienta i systemy');button.type='submit';
 form.append(makeLabel('Nazwa',nameInput),activeLabel,node('span','field-title','Systemy objęte serwisem'),services,button);
 form.addEventListener('submit',async ev=>{
  ev.preventDefault();button.disabled=true;
  try{
   await api('/api/admin/organizations/'+org.id,{method:'PATCH',body:JSON.stringify({name:nameInput.value,is_active:active.checked,systems:servicesFrom(form)})});
   await loadManagement();pop('Zaktualizowano klienta i przypisane systemy.');
  }catch(e){pop(e.message,true);}finally{button.disabled=false;}
 });
 details.append(form);return details;
}
function userRow(user){
 const details=document.createElement('details');details.className='management-item';
 details.append(node('summary','manager-heading',user.username+' • '+(user.organization_name||'Bez klienta')+' • '+(user.is_active?'Aktywne':'Zablokowane')));
 const form=node('form','form manager-form');
 const org=document.createElement('select');orgSelect(org,false,String(user.organization_id));
 const active=inputField('checkbox','is_active');active.checked=user.is_active;
 const activeLabel=makeLabel('Konto aktywne',active);activeLabel.classList.add('inline-check');
 const save=node('button','btn outline','Zapisz uprawnienia');save.type='submit';
 form.append(makeLabel('Przypisany klient',org),activeLabel,save);
 form.addEventListener('submit',async e=>{
  e.preventDefault();save.disabled=true;
  try{
   await api('/api/admin/users/'+user.id,{method:'PATCH',body:JSON.stringify({organization_id:org.value,is_active:active.checked})});
   await loadManagement();pop('Zapisano uprawnienia użytkownika.');
  }catch(err){pop(err.message,true);}finally{save.disabled=false;}
 });
 const reset=node('form','form manager-form');
 const pw=inputField('password','newPassword','',true);pw.minLength=8;pw.maxLength=128;pw.autocomplete='new-password';
 const submit=node('button','btn outline','Ustaw nowe hasło');submit.type='submit';
 reset.append(makeLabel('Nowe hasło (min. 8 znaków)',pw),submit);
 reset.addEventListener('submit',async e=>{
  e.preventDefault();submit.disabled=true;
  try{
   await api('/api/admin/users/'+user.id+'/reset-password',{method:'POST',body:JSON.stringify({newPassword:pw.value})});
   reset.reset();pop('Hasło użytkownika zostało zmienione.');
  }catch(err){pop(err.message,true);}finally{submit.disabled=false;}
 });
 details.append(form,reset);
 return details;
}
async function loadManagement(){
 const [o,u]=await Promise.all([api('/api/admin/organizations'),api('/api/admin/users')]);
 state.organizations=o.organizations;state.users=u.users;
 const originalFilter=$('filter-org').value,originalReport=$('report-org').value,originalTicket=$('new-organization').value;
 const orgs=state.organizations;
 orgSelect($('filter-org'),true,originalFilter);
 orgSelect($('report-org'),true,originalReport);
 orgSelect($('new-organization'),false,originalTicket);
 orgSelect($('new-user-organization'));
 const orgList=$('organization-list');orgList.replaceChildren();
 for(const org of orgs)orgList.append(orgRow(org));
 const userList=$('user-list');userList.replaceChildren();
 for(const user of state.users.filter(x=>x.role==='client'))userList.append(userRow(user));
 serviceOptions($('new-org-services'),state.meta.allCategories||state.meta.categories,[]);
 show('new-org-wrap',true);
 show('filter-org',true);
 show('admin-organizations',true);
 show('admin-users',true);
 setTicketCategoryOptions();
}
function initManagement(){
 $('new-organization').addEventListener('change',setTicketCategoryOptions);
 $('filter-org').addEventListener('change',renderTickets);
 $('organization-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,btn=form.querySelector('button[type=submit]');btn.disabled=true;
  try{
   const data={name:form.elements.name.value,systems:servicesFrom(form)};
   await api('/api/admin/organizations',{method:'POST',body:JSON.stringify(data)});
   form.reset();await loadManagement();pop('Dodano klienta.');
  }catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('user-create-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,button=form.querySelector('button[type=submit]');button.disabled=true;
  try{
   const payload=Object.fromEntries(new FormData(form));
   await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});
   form.reset();await loadManagement();pop('Dodano użytkownika. Hasło należy przekazać mu bezpiecznym kanałem.');
  }catch(err){pop(err.message,true);}finally{button.disabled=false;}
 });
}
document.addEventListener('DOMContentLoaded',initManagement);
