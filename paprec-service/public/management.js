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
const profileDefinitions=[
 ['address','Adres siedziby','text'],
 ['nip','NIP','text'],
 ['regon','REGON','text'],
 ['krs','KRS','text'],
 ['contact_name','Osoba kontaktowa','text'],
 ['contact_role','Stanowisko','text'],
 ['contact_email','E-mail kontaktowy','email'],
 ['contact_phone','Telefon stacjonarny','tel'],
 ['contact_mobile','Telefon komórkowy','tel']
];
function readProfile(form){
 const profile={};
 for(const [key] of profileDefinitions)profile[key]=String(form.elements['profile_'+key]?.value||'').trim();
 return profile;
}
function orgRow(org){
 const details=document.createElement('details');details.className='management-item';
 details.append(node('summary','manager-heading',org.name+' • '+(org.is_active?'Dostęp aktywny':'DOSTĘP WSTRZYMANY')+' • '+org.users_count+' kont • '+org.systems.length+' systemów'));
 const form=node('form','form manager-form');
 const nameInput=inputField('text','name',org.name,true);nameInput.maxLength=140;
 const profile=org.profile||{};
 const metaForm=node('div','two');
 for(const [key,label,type] of profileDefinitions){const input=inputField(type,'profile_'+key,profile[key]||'');input.maxLength=key==='address'?250:120;metaForm.append(makeLabel(label,input));}
 const active=inputField('checkbox','is_active');active.checked=org.is_active;
 const activeLabel=makeLabel('Klient aktywny',active);activeLabel.classList.add('inline-check');
 const services=node('div','service-checklist');serviceOptions(services,state.meta.allCategories||state.meta.categories,org.systems);
 const button=node('button','btn main','Zapisz klienta i systemy');button.type='submit';
 form.append(makeLabel('Nazwa',nameInput),metaForm,activeLabel,node('span','field-title','Systemy objęte serwisem'),services,button);
 const suspend=node('button',org.is_active?'btn danger-outline':'btn main',org.is_active?'Wstrzymaj dostęp całej firmie':'Przywróć dostęp całej firmie');
 suspend.type='button';
 suspend.addEventListener('click',async()=>{
   const nextActive=!org.is_active;
   if(!nextActive&&!window.confirm('Zablokować dostęp wszystkim użytkownikom firmy '+org.name+'? Zgłoszenia i historia pozostaną zachowane.'))return;
   suspend.disabled=true;
   try{
     await api('/api/admin/organizations/'+org.id,{method:'PATCH',body:JSON.stringify({name:org.name,systems:org.systems,is_active:nextActive})});
     await loadManagement();pop(nextActive?'Przywrócono dostęp firmie.':'Zablokowano dostęp całej firmie.');
   }catch(e){pop(e.message,true);}finally{suspend.disabled=false;}
 });
 form.append(suspend);
  form.addEventListener('submit',async ev=>{
  ev.preventDefault();button.disabled=true;
  try{
   await api('/api/admin/organizations/'+org.id,{method:'PATCH',body:JSON.stringify({name:nameInput.value,is_active:active.checked,systems:servicesFrom(form),profile:readProfile(form)})});
   await loadManagement();pop('Zaktualizowano klienta i przypisane systemy.');
  }catch(e){pop(e.message,true);}finally{button.disabled=false;}
 });
 details.append(form);return details;
}
function userRow(user){
 const details=document.createElement('details');details.className='management-item';
 details.append(node('summary','manager-heading',user.username+' • '+(user.email||'Brak adresu e-mail')+' • '+(user.organization_name||'Bez klienta')+' • '+(user.is_active?'Aktywne':'Zablokowane')));
 const form=node('form','form manager-form');
 const org=document.createElement('select');orgSelect(org,false,String(user.organization_id));
 const email=inputField('email','email',user.email||'',true);email.maxLength=254;email.autocomplete='off';
 const active=inputField('checkbox','is_active');active.checked=user.is_active;
 const activeLabel=makeLabel('Konto aktywne',active);activeLabel.classList.add('inline-check');
 const save=node('button','btn outline','Zapisz uprawnienia');save.type='submit';
 form.append(makeLabel('Adres e-mail odbiorcy potwierdzenia PDF',email),makeLabel('Przypisany klient',org),activeLabel,save);
 form.addEventListener('submit',async e=>{
  e.preventDefault();save.disabled=true;
  try{
   await api('/api/admin/users/'+user.id,{method:'PATCH',body:JSON.stringify({organization_id:org.value,email:email.value.trim(),is_active:active.checked})});
   await loadManagement();pop('Zapisano adres e-mail i uprawnienia użytkownika.');
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
 const deleteUser=node('button','btn danger-outline','Usuń użytkownika');
 deleteUser.type='button';
 deleteUser.addEventListener('click',async()=>{
   if(!window.confirm('Usunąć konto '+user.username+'? Użytkownik natychmiast utraci dostęp. Dotychczasowe zgłoszenia i historia pozostaną w rejestrze.'))return;
   deleteUser.disabled=true;
   try{
     await api('/api/admin/users/'+user.id,{method:'DELETE'});
     await loadManagement();pop('Usunięto dostęp użytkownika '+user.username+'.');
   }catch(e){pop(e.message,true);}finally{deleteUser.disabled=false;}
 });
 const actions=node('div','manager-danger-zone');actions.append(deleteUser);
 details.append(form,reset,actions);
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
   const data={name:form.elements.name.value,systems:servicesFrom(form),profile:readProfile(form)};
   await api('/api/admin/organizations',{method:'POST',body:JSON.stringify(data)});
   form.reset();await loadManagement();pop('Dodano klienta.');
  }catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('user-create-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,button=form.querySelector('button[type=submit]');button.disabled=true;
  try{
   const payload=Object.fromEntries(new FormData(form));
   await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});
   form.reset();await loadManagement();pop('Dodano użytkownika z adresem e-mail. Hasło należy przekazać mu bezpiecznym kanałem.');
  }catch(err){pop(err.message,true);}finally{button.disabled=false;}
 });
}
document.addEventListener('DOMContentLoaded',initManagement);
