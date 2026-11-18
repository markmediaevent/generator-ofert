'use strict';
const $=id=>document.getElementById(id);
const state={me:null,meta:null,tickets:[],selectedId:null,detail:null};
function show(id,yes=true){$(id).classList.toggle('hide',!yes);}
function pop(text,error=false){const el=$('toast');el.textContent=text;el.classList.toggle('error',error);show('toast',true);clearTimeout(pop.timer);pop.timer=setTimeout(()=>show('toast',false),4200);}
const API_BASE = (location.hostname==='marknet.com.pl'||location.hostname==='www.marknet.com.pl') ? 'https://marknet-serwis-test.onrender.com' : '';
const AUTH_KEY = 'marknet_serwis_access';
function token(){return API_BASE?sessionStorage.getItem(AUTH_KEY):null;}
function reqHeaders(body,headers={}){
 const h={...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...headers};
 if(token())h.Authorization='Bearer '+token();
 return h;
}
async function api(url,options={}){
  const res=await fetch(API_BASE+url,{credentials:API_BASE?'omit':'same-origin',...options,headers:reqHeaders(options.body,options.headers)});
  let data={};try{data=await res.json();}catch{}
  if(!res.ok)throw Error(data.error||'Wystąpił błąd. Spróbuj ponownie.');
  return data;
}
async function downloadFile(url,filename){
 const response=await fetch(API_BASE+url,{credentials:API_BASE?'omit':'same-origin',headers:reqHeaders(undefined,{})});
 if(!response.ok)throw Error('Nie udało się pobrać pliku ('+response.status+').');
 const b=await response.blob();
 const href=URL.createObjectURL(b);
 const a=document.createElement('a');a.href=href;a.download=filename;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(href),15000);
}
const date=v=>v?new Intl.DateTimeFormat('pl-PL',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Warsaw'}).format(new Date(v)):'—';
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=String(text);return el;}
function clear(el){el.replaceChildren();}
function option(select,label,value=label){const el=node('option','',label);el.value=value;select.append(el);}
function modal(id){show(id,true);}
function closeModal(id){show(id,false);}
async function initialize(){
 try{state.me=await api('/api/me');await setupPortal();}
 catch(e){show('portal-view',false);show('login-view',true);}
}
async function setupPortal(){
 const [meta,tickets]=await Promise.all([api('/api/meta'),api('/api/tickets')]);
 state.meta=meta;state.tickets=tickets.tickets;show('login-view',false);show('portal-view',true);
 $('user-label').textContent=state.me.username+' • '+(state.me.role==='admin'?'Administrator':'Klient');
 const emailInput=$('requester-email');
 emailInput.readOnly=state.me.role==='client';
 emailInput.value=state.me.role==='client'?(state.me.email||''):'';
 emailInput.placeholder=state.me.role==='client'?'E-mail przypisany do konta':'Adres odbiorcy potwierdzenia';
 $('page-title').textContent=state.me.role==='admin'?'Panel administratora MarkNet':'Panel zgłoszeń — '+state.me.clientName;
 $('page-subtitle').textContent=state.me.role==='admin'?'Zarządzanie serwisem, dokumentacją i raportami':'Zgłoś usterkę lub awarię i śledź historię obsługi';
 show('admin-reports',state.me.role==='admin');show('admin-push',state.me.role==='admin');show('admin-status',state.me.role==='admin');show('admin-users',state.me.role==='admin');show('admin-organizations',state.me.role==='admin');
 if(state.me.role==='admin')refreshNotifications().catch(()=>{});
 const category=$('new-category'),filter=$('filter-category'),status=$('filter-status');
 clear(category);clear(filter);clear(status);
 option(filter,'Wszystkie systemy','');option(status,'Wszystkie statusy','');
 for(const c of meta.categories){option(category,c);option(filter,c);}
 for(const s of meta.statuses)option(status,s);
 const d=$('detail-status');clear(d);for(const s of meta.statuses)option(d,s);
 if(!$('report-month').value)$('report-month').value=new Date().toISOString().slice(0,7);
 if(state.me.role==='admin')await loadManagement();
 renderTickets();
}
async function refreshNotifications(){
 const data=await api('/api/admin/notifications');
 const all=data.jobs||[];
 const pending=all.filter(x=>x.status==='pending');
 const failed=pending.filter(x=>x.attempt_count>0);
 const emailConfig=data.configured?.email?'Skonfigurowana':'Wymaga hasła aplikacji Google';
 const phoneConfig=data.configured?.phone?'Skonfigurowane':'Nieaktywne';
 $('notification-summary').textContent='Poczta: '+emailConfig+' • Telefon: '+phoneConfig+' • Oczekujące wysyłki: '+pending.length+' • Ponowne próby: '+failed.length;
}
function renderTickets(){
 const all=state.tickets||[],status=$('filter-status').value,category=$('filter-category').value,org=state.me?.role==='admin'?$('filter-org').value:'',search=$('filter-search').value.toLocaleLowerCase('pl-PL').trim();
 const filtered=all.filter(t=>(!status||t.status===status)&&(!category||t.category===category)&&(!org||String(t.organization_id)===org)&&(!search||[t.number,t.title,t.area,t.device,t.description,t.category,t.organization_name].some(x=>String(x||'').toLocaleLowerCase('pl-PL').includes(search))));
 const summary=$('summary');clear(summary);
 const values=[['Wszystkie zgłoszenia',all.length],['Nowe',all.filter(t=>t.status==='Nowe').length],['Aktywne',all.filter(t=>!['Rozwiązane','Zamknięte'].includes(t.status)).length],['Krytyczne aktywne',all.filter(t=>t.priority==='Krytyczny'&&!['Rozwiązane','Zamknięte'].includes(t.status)).length]];
 values.forEach(([label,val])=>{const card=node('div','kpi');card.append(node('small','',label),node('strong','',val));summary.append(card);});
 const list=$('ticket-list');clear(list);
 if(!filtered.length){list.append(node('div','empty','Brak zgłoszeń spełniających wybrane kryteria.'));return;}
 for(const t of filtered){
  const btn=node('button','ticket-row');btn.type='button';
  if(String(t.id)===String(state.lastCreatedId||''))btn.classList.add('ticket-highlight');
  const a=node('div');a.append(node('div','ticket-number',t.number),node('div','ticket-meta',date(t.created_at)));
  const b=node('div');b.append(node('div','ticket-title',t.title),node('div','ticket-meta',t.kind+' • '+t.priority));
  const c=node('div');c.append(node('div','',t.category),node('div','ticket-meta',(state.me.role==='admin'?(t.organization_name||'Klient')+' • ':'')+(t.area||'Lokalizacja niepodana')));
  const d=node('span','status ticket-status'+(t.priority==='Krytyczny'?' critical':''),t.status);
  btn.append(a,b,c,d);btn.addEventListener('click',()=>openTicket(t.id));list.append(btn);
 }
}
async function refresh(){
 const r=await api('/api/tickets');state.tickets=r.tickets;renderTickets();
}
function info(target,label,text){
 const box=node('div');box.append(node('small','',label),node('strong','',text||'—'));target.append(box);
}
async function openTicket(id){
 try{
  state.selectedId=id;state.detail=await api('/api/tickets/'+id);
  const {ticket:t,events,files}=state.detail;
  $('detail-number').textContent=t.number+' • '+t.kind+' / '+t.priority;
  $('detail-title').textContent=t.title;
  const infoBox=$('detail-information');clear(infoBox);
  const grid=node('div','detail-grid');
  info(grid,'Status',t.status);info(grid,'Klient',t.organization_name||'—');info(grid,'System',t.category);info(grid,'Zgłoszono',date(t.created_at));info(grid,'Zgłaszający',t.requester_name||t.author);info(grid,'E-mail zgłaszającego',t.requester_email);
  info(grid,'Lokalizacja',t.area);info(grid,'Urządzenie',t.device);info(grid,'Weryfikacja',date(t.acknowledged_at));info(grid,'Na obiekcie',date(t.on_site_at));
  info(grid,'Rozwiązanie',date(t.resolved_at));
  infoBox.append(grid,node('div','description-box',t.description));
  const admin=state.me.role==='admin';show('admin-controls',admin);
  $('detail-status').value=t.status;$('admin-note').value='';
  const list=$('detail-events');clear(list);
  const timeline=node('div','timeline');
  for(const e of events){
    const line=node('div','event');
    line.append(node('div','event-meta',date(e.created_at)+' • '+(e.author||'system')),node('div','event-title',e.action));
    if(e.details)line.append(node('div','event-description',e.details));timeline.append(line);
  }
  list.append(timeline);
  const filesBox=$('attachment-list');clear(filesBox);
  if(!files.length)filesBox.append(node('p','subtle','Brak załączników.'));
  for(const file of files){
    const a=node('a','attachment-link',(String(file.mime).startsWith('image/')?'📷 ':'📄 ')+file.filename+' ('+Math.round(Number(file.size)/1024)+' KB)');
    a.href='#';a.addEventListener('click',async e=>{e.preventDefault();try{await downloadFile('/api/attachments/'+file.id,file.filename);}catch(err){pop(err.message,true);}});filesBox.append(a);
  }
  modal('detail-modal');
 }catch(e){pop(e.message,true);}
}
async function updateTicket(payload){
 if(!state.selectedId)return;
 try{
  await api('/api/tickets/'+state.selectedId,{method:'PATCH',body:JSON.stringify(payload)});
  await refresh();await openTicket(state.selectedId);pop('Zaktualizowano zgłoszenie.');
 }catch(e){pop(e.message,true);}
}
async function enablePhoneAlerts(){
 if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw Error('Przeglądarka nie obsługuje powiadomień PWA. Na iPhonie dodaj stronę do ekranu początkowego.');
 const permission=await Notification.requestPermission();
 if(permission!=='granted')throw Error('Nie przyznano zgody na powiadomienia. Sprawdź ustawienia Safari/iOS.');
 const registration=await navigator.serviceWorker.register('/serwis/sw.js',{scope:'/serwis/'});
 await navigator.serviceWorker.ready;
 const {publicKey}=await api('/api/push/public-key');
 const base64=publicKey.replace(/-/g,'+').replace(/_/g,'/');
 const bytes=Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'=')),c=>c.charCodeAt(0));
 let sub=await registration.pushManager.getSubscription();
 if(!sub)sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
 await api('/api/push/subscribe',{method:'POST',body:JSON.stringify({subscription:sub.toJSON()})});
 $('push-status').textContent='Powiadomienia aktywne na tym urządzeniu.';
}

function wireEvents(){
 $('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;
  try{const result=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});if(API_BASE){if(!result.accessToken)throw Error('Brak tokenu dostępu.');sessionStorage.setItem(AUTH_KEY,result.accessToken);}e.target.reset();state.me=await api('/api/me');await setupPortal();}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('logout-button').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}catch{}sessionStorage.removeItem(AUTH_KEY);state.me=null;state.tickets=[];show('portal-view',false);show('login-view',true);});
 $('submission-dismiss').addEventListener('click',()=>show('submission-success',false));
  $('add-button').addEventListener('click',()=>{
  if(state.me?.role==='client'){
   if(!state.me.email){pop('Brak przypisanego adresu e-mail. Poproś MarkNet o uzupełnienie adresu na swoim koncie.',true);return;}
   $('requester-email').value=state.me.email;
  }
  modal('new-ticket-modal');
 });
 $('password-button').addEventListener('click',()=>modal('password-modal'));
 $('enable-push').addEventListener('click',async()=>{
  const b=$('enable-push');b.disabled=true;
  try{await enablePhoneAlerts();pop('Powiadomienia na telefon zostały włączone.');}
  catch(e){$('push-status').textContent=e.message;pop(e.message,true);}
  finally{b.disabled=false;}
 });
 $('test-email').addEventListener('click',async()=>{
  const button=$('test-email');button.disabled=true;
  try{await api('/api/admin/notifications/test-email',{method:'POST'});pop('Testowy e-mail wysłano do administratora.');await refreshNotifications();}
  catch(err){pop(err.message,true);}
  finally{button.disabled=false;}
 });
 $('refresh-notifications').addEventListener('click',async()=>{try{await refreshNotifications();pop('Odświeżono stan wysyłek.');}catch(e){pop(e.message,true);}});
  $('test-push').addEventListener('click',async()=>{
  const b=$('test-push');b.disabled=true;
  try{await api('/api/push/test',{method:'POST'});pop('Wysłano próbny alert na telefon.');}
  catch(e){pop(e.message,true);}
  finally{b.disabled=false;}
 });
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
 for(const id of ['filter-status','filter-category'])$(id).addEventListener('change',renderTickets);
 $('filter-search').addEventListener('input',renderTickets);
 $('ticket-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,btn=form.querySelector('[type=submit]');btn.disabled=true;
  try{
    const fd=new FormData(form);
    const images=[...$('new-ticket-files').files];
    if(images.length>10 || images.some(file=>file.size>5*1024*1024 || file.size===0))throw Error('Maksymalnie 10 plików, do 5 MB każdy.');
    const data=Object.fromEntries(fd);delete data.photos;
    const r=await api('/api/tickets',{method:'POST',body:JSON.stringify(data)});
    let errors=0;
    for(const file of images){
      const item=new FormData();item.append('file',file,file.name);
      try{await api('/api/tickets/'+r.ticket.id+'/attachments',{method:'POST',body:item});}catch(err){errors++;console.warn('Załącznik nie został dodany:',file.name);}
    }
    form.reset();if(state.me?.role==='client')$('requester-email').value=state.me.email||'';
    closeModal('new-ticket-modal');
    state.lastCreatedId=r.ticket.id;
    $('filter-status').value='';
    $('filter-category').value='';
    $('filter-search').value='';
    if(state.me?.role==='admin')$('filter-org').value='';
    $('submission-title').textContent='Zgłoszenie '+r.ticket.number+' zostało przekazane do serwisu MarkNet.';
    const emailInfo=r.notification?.email==='queued'?'E-mail z potwierdzeniem i PDF został dodany do kolejki wysyłki.':'Potwierdzenie PDF możesz pobrać ze szczegółów zgłoszenia.';
    $('submission-info').textContent=(errors?'Nie udało się dołączyć '+errors+' plików. ':'')+emailInfo+' Status zgłoszenia możesz śledzić na liście poniżej.';
    show('submission-success',true);
    show('ticket-modal',false);
    window.scrollTo({top:0,behavior:'smooth'});
    try{await refresh();}catch(err){pop('Zgłoszenie zostało zapisane, ale nie udało się odświeżyć listy. Odśwież stronę.',true);}
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('comment-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{await api('/api/tickets/'+state.selectedId+'/events',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();await openTicket(state.selectedId);pop('Zapisano komentarz.');}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('attachment-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{
    const files=[...f.elements.file.files];if(!files.length||files.length>10)throw Error('Wybierz od 1 do 10 plików.');
    for(const file of files){const data=new FormData();data.append('file',file,file.name);await api('/api/tickets/'+state.selectedId+'/attachments',{method:'POST',body:data});}
    f.reset();await openTicket(state.selectedId);pop('Dodano '+files.length+' plików.');
  }
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('save-status').addEventListener('click',()=>updateTicket({status:$('detail-status').value,details:$('admin-note').value}));
 $('ack-button').addEventListener('click',()=>updateTicket({event:'acknowledge',details:$('admin-note').value}));
 $('onsite-button').addEventListener('click',()=>updateTicket({event:'on_site',details:$('admin-note').value}));
 $('resolved-button').addEventListener('click',()=>updateTicket({event:'resolve',details:$('admin-note').value}));
 $('confirmation-pdf').addEventListener('click',async()=>{if(state.selectedId)try{await downloadFile('/api/tickets/'+state.selectedId+'/confirmation.pdf','Potwierdzenie-MarkNet-'+state.selectedId+'.pdf');}catch(err){pop(err.message,true);}});
 $('ticket-pdf').addEventListener('click',async()=>{if(state.selectedId)try{await downloadFile('/api/reports/tickets/'+state.selectedId+'.pdf','MarkNet-'+state.selectedId+'.pdf');}catch(err){pop(err.message,true);}});
 $('month-pdf').addEventListener('click',async()=>{const m=$('report-month').value,org=$('report-org').value;if(m)try{await downloadFile('/api/reports/month.pdf?month='+encodeURIComponent(m)+(org?'&organization_id='+encodeURIComponent(org):''),'Raport-MarkNet-'+m+'.pdf');}catch(err){pop(err.message,true);}else pop('Wybierz miesiąc.',true);});
 $('month-csv').addEventListener('click',async()=>{const m=$('report-month').value,org=$('report-org').value;if(m)try{await downloadFile('/api/reports/month.csv?month='+encodeURIComponent(m)+(org?'&organization_id='+encodeURIComponent(org):''),'Zgloszenia-MarkNet-'+m+'.csv');}catch(err){pop(err.message,true);}else pop('Wybierz miesiąc.',true);});
 $('password-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{await api('/api/change-password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();closeModal('password-modal');pop('Hasło zostało zmienione.');}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 document.querySelectorAll('.overlay').forEach(x=>x.addEventListener('click',e=>{if(e.target===x)closeModal(x.id);}));
 document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.overlay').forEach(x=>show(x.id,false));});
}
wireEvents();initialize();