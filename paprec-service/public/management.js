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
 details.append(node('summary','manager-heading',(user.first_name&&user.last_name?user.first_name+' '+user.last_name+' • ':'')+user.username+' • '+(user.email||'Brak adresu e-mail')+' • '+(user.organization_name||'Bez klienta')+' • '+(user.is_active?(user.must_set_password?'Oczekuje na aktywację':'Aktywne'):'Zablokowane')));
 const form=node('form','form manager-form');
 const org=document.createElement('select');orgSelect(org,false,String(user.organization_id));
 const email=inputField('email','email',user.email||'',true);email.maxLength=254;email.autocomplete='off';
 const first=inputField('text','first_name',user.first_name||'',true);first.maxLength=80;first.minLength=2;
 const last=inputField('text','last_name',user.last_name||'',true);last.maxLength=80;last.minLength=2;
 const active=inputField('checkbox','is_active');active.checked=user.is_active;
 const activeLabel=makeLabel('Konto aktywne',active);activeLabel.classList.add('inline-check');
 const save=node('button','btn outline','Zapisz uprawnienia');save.type='submit';
 form.append(makeLabel('Imię',first),makeLabel('Nazwisko',last),makeLabel('Adres e-mail odbiorcy potwierdzenia PDF',email),makeLabel('Przypisany klient',org),activeLabel,save);
 form.addEventListener('submit',async e=>{
  e.preventDefault();save.disabled=true;
  try{
   await api('/api/admin/users/'+user.id,{method:'PATCH',body:JSON.stringify({organization_id:org.value,email:email.value.trim(),first_name:first.value.trim(),last_name:last.value.trim(),is_active:active.checked})});
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
 const actions=node('div','manager-danger-zone');
 if(user.must_set_password){
   const mailStatus=node('p','hint','Zaproszenie: '+(
     user.invitation_status==='sent'?'e-mail wysłany, oczekuje na ustawienie hasła':
     user.invitation_status==='pending'?'e-mail oczekuje na wysyłkę':
     user.invitation_status==='expired'?'link wygasł':
     user.invitation_status==='cancelled'?'poprzedni link unieważniono':
     'brak aktywnego zaproszenia'
   ));
   const resend=node('button','btn outline','Wyślij zaproszenie ponownie');
   resend.type='button';
   resend.addEventListener('click',async()=>{
     resend.disabled=true;
     try{
       await api('/api/admin/users/'+user.id+'/invite',{method:'POST',body:'{}'});
       await loadManagement();
       pop('Dodano nowe zaproszenie do kolejki e-mail dla '+user.username+'.');
     }catch(e){pop(e.message,true);}finally{resend.disabled=false;}
   });
   actions.append(mailStatus,resend);
 }
 actions.append(deleteUser);
 details.append(form,reset,actions);
 return details;
}
function loginDevice(userAgent){
 const ua=String(userAgent||'');
 const platform=/iPad/i.test(ua)?'iPad':/iPhone/i.test(ua)?'iPhone':/Android/i.test(ua)?'Android':/Windows/i.test(ua)?'Windows':/Macintosh|Mac OS X/i.test(ua)?'Mac':/Linux/i.test(ua)?'Linux':'Nieznane urządzenie';
 const browser=/Edg\//i.test(ua)?'Edge':/CriOS|Chrome/i.test(ua)?'Chrome':/FxiOS|Firefox/i.test(ua)?'Firefox':/Safari/i.test(ua)?'Safari':'Przeglądarka';
 return platform+' / '+browser;
}
function historyEntry(row){
 const wrap=node('article','login-history-item');
 const top=node('div','login-history-item-top');
 const person=node('strong','', [row.username,row.organization_name||'MarkNet'].filter(Boolean).join(' • '));
 const status=node('span','login-history-status '+(row.success?'success':'failed'),row.success?'Udane':'Nieudane');
 top.append(person,status);
 const details=node('div','login-history-details');
 for(const field of [
   ['Data',date(row.created_at)],
   ['Urządzenie',loginDevice(row.user_agent)],
   ['Adres IP',row.ip_address||'—']
 ]) {
   const entry=node('span','login-history-fact');
   entry.append(node('span','login-history-fact-label',field[0]),node('span','',field[1]));
   details.append(entry);
 }
 const fullAgent=node('div','login-history-agent',row.user_agent||'Brak informacji o przeglądarce');
 wrap.append(top,details,fullAgent);
 return wrap;
}
async function loadLoginHistory(){
 if(state.me?.role!=='admin')return;
 const params=new URLSearchParams({limit:'100'});
 const org=$('login-history-org').value,user=$('login-history-user').value,result=$('login-history-result').value;
 if(org)params.set('organization_id',org);
 if(user)params.set('user_id',user);
 if(result)params.set('result',result);
 $('login-history-caption').textContent='Pobieranie historii…';
 try{
   const data=await api('/api/admin/login-history?'+params.toString());
   const target=$('login-history-list');target.replaceChildren();
   for(const entry of data.entries)target.append(historyEntry(entry));
   if(!data.entries.length)target.append(node('p','hint','Brak logowań dla wybranych filtrów.'));
   $('login-history-caption').textContent='Wyświetlono '+data.entries.length+' ostatnich prób logowania. Historia obejmuje ostatnie '+data.retention_days+' dni.';
 }catch(e){
   $('login-history-caption').textContent='Nie można pobrać historii logowań.';
   throw e;
 }
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
 orgSelect($('login-history-org'),true,$('login-history-org').value);
 const loginUser=$('login-history-user');
 const selectedLoginUser=loginUser.value;
 loginUser.replaceChildren();
 option(loginUser,'Wszyscy użytkownicy','');
 for(const u of state.users){
   const displayName=[u.first_name,u.last_name].filter(Boolean).join(' ');
   option(loginUser,(displayName?displayName+' — ':'')+u.username+' ('+(u.organization_name||'MarkNet')+')',String(u.id));
 }
 if([...loginUser.options].some(o=>o.value===selectedLoginUser))loginUser.value=selectedLoginUser;
 const orgList=$('organization-list');orgList.replaceChildren();
 for(const org of orgs)orgList.append(orgRow(org));
 const userList=$('user-list');userList.replaceChildren();
 for(const user of state.users.filter(x=>x.role==='client'))userList.append(userRow(user));
 serviceOptions($('new-org-services'),state.meta.allCategories||state.meta.categories,[]);
 show('new-org-wrap',true);
 show('filter-org',true);
 show('admin-organizations',true);
 show('admin-users',true);
 show('admin-login-history',true);
 setTicketCategoryOptions();
 try{await loadLoginHistory();}catch(err){pop(err.message,true);}
}
function previewUsernamePart(v){
 return String(v||'').trim().toLowerCase().replace(/ł/g,'l').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9-]/g,'').replace(/^-+|-+$/g,'');
}
function updateUsernamePreview(){
 const form=$('user-create-form');
 const first=previewUsernamePart(form.elements.first_name.value);
 const last=previewUsernamePart(form.elements.last_name.value);
 $('new-user-login-preview').value=first&&last?first[0]+'.'+last.slice(0,48):'';
}
function initManagement(){
 $('new-organization').addEventListener('change',setTicketCategoryOptions);
 $('filter-org').addEventListener('change',renderTickets);
 for(const id of ['login-history-org','login-history-user','login-history-result']){
   $(id).addEventListener('change',()=>loadLoginHistory().catch(e=>pop(e.message,true)));
 }
 $('login-history-refresh').addEventListener('click',()=>loadLoginHistory().catch(e=>pop(e.message,true)));
 $('organization-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,btn=form.querySelector('button[type=submit]');btn.disabled=true;
  try{
   const data={name:form.elements.name.value,systems:servicesFrom(form),profile:readProfile(form)};
   await api('/api/admin/organizations',{method:'POST',body:JSON.stringify(data)});
   form.reset();await loadManagement();pop('Dodano klienta.');
  }catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 const createForm=$('user-create-form');
 for(const field of ['first_name','last_name'])createForm.elements[field].addEventListener('input',updateUsernamePreview);
 updateUsernamePreview();
 $('user-create-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,button=form.querySelector('button[type=submit]');button.disabled=true;
  try{
   const payload=Object.fromEntries(new FormData(form));
   const result=await api('/api/admin/users',{method:'POST',body:JSON.stringify(payload)});
   form.reset();updateUsernamePreview();await loadManagement();
   pop('Utworzono login '+result.user.username+'. Zaproszenie do ustawienia hasła dodano do kolejki e-mail.');
  }catch(err){pop(err.message,true);}finally{button.disabled=false;}
 });
}
document.addEventListener('DOMContentLoaded',initManagement);
