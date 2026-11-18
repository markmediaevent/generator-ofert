'use strict';
const $=id=>document.getElementById(id);
const state={me:null,meta:null,tickets:[],selectedId:null,detail:null};
function show(id,yes=true){$(id).classList.toggle('hide',!yes);}
function pop(text,error=false){const el=$('toast');el.textContent=text;el.classList.toggle('error',error);show('toast',true);clearTimeout(pop.timer);pop.timer=setTimeout(()=>show('toast',false),4200);}
async function api(url,options={}){
  const headers=options.body instanceof FormData?{}:{'Content-Type':'application/json'};
  let res=await fetch(url,{credentials:'same-origin',...options,headers:{...headers,...options.headers}});
  let data={};try{data=await res.json();}catch{}
  if(!res.ok)throw Error(data.error||'Wystąpił błąd. Spróbuj ponownie.');
  return data;
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
 $('page-title').textContent=state.me.role==='admin'?'Panel administratora MarkNet':'Panel zgłoszeń — '+state.me.clientName;
 $('page-subtitle').textContent=state.me.role==='admin'?'Zarządzanie serwisem, dokumentacją i raportami':'Zgłoś usterkę lub awarię i śledź historię obsługi';
 show('admin-reports',state.me.role==='admin');
 const category=$('new-category'),filter=$('filter-category'),status=$('filter-status');
 clear(category);clear(filter);clear(status);
 option(filter,'Wszystkie systemy','');option(status,'Wszystkie statusy','');
 for(const c of meta.categories){option(category,c);option(filter,c);}
 for(const s of meta.statuses)option(status,s);
 const d=$('detail-status');clear(d);for(const s of meta.statuses)option(d,s);
 if(!$('report-month').value)$('report-month').value=new Date().toISOString().slice(0,7);
 renderTickets();
}
function renderTickets(){
 const all=state.tickets||[],status=$('filter-status').value,category=$('filter-category').value,search=$('filter-search').value.toLocaleLowerCase('pl-PL').trim();
 const filtered=all.filter(t=>(!status||t.status===status)&&(!category||t.category===category)&&(!search||[t.number,t.title,t.area,t.device,t.description,t.category].some(x=>String(x||'').toLocaleLowerCase('pl-PL').includes(search))));
 const summary=$('summary');clear(summary);
 const values=[['Wszystkie zgłoszenia',all.length],['Nowe',all.filter(t=>t.status==='Nowe').length],['Aktywne',all.filter(t=>!['Rozwiązane','Zamknięte'].includes(t.status)).length],['Krytyczne aktywne',all.filter(t=>t.priority==='Krytyczny'&&!['Rozwiązane','Zamknięte'].includes(t.status)).length]];
 values.forEach(([label,val])=>{const card=node('div','kpi');card.append(node('small','',label),node('strong','',val));summary.append(card);});
 const list=$('ticket-list');clear(list);
 if(!filtered.length){list.append(node('div','empty','Brak zgłoszeń spełniających wybrane kryteria.'));return;}
 for(const t of filtered){
  const btn=node('button','ticket-row');btn.type='button';
  const a=node('div');a.append(node('div','ticket-number',t.number),node('div','ticket-meta',date(t.created_at)));
  const b=node('div');b.append(node('div','ticket-title',t.title),node('div','ticket-meta',t.kind+' • '+t.priority));
  const c=node('div');c.append(node('div','',t.category),node('div','ticket-meta',t.area||'Lokalizacja niepodana'));
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
  info(grid,'Status',t.status);info(grid,'System',t.category);info(grid,'Zgłoszono',date(t.created_at));info(grid,'Zgłaszający',t.author);
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
    const a=node('a','attachment-link',file.filename+' ('+Math.round(Number(file.size)/1024)+' KB)');
    a.href='/api/attachments/'+file.id;a.rel='noopener';filesBox.append(a);
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
function wireEvents(){
 $('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const btn=e.target.querySelector('button[type=submit]');btn.disabled=true;
  try{await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();state.me=await api('/api/me');await setupPortal();}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('logout-button').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}catch{}state.me=null;state.tickets=[];show('portal-view',false);show('login-view',true);});
 $('add-button').addEventListener('click',()=>modal('new-ticket-modal'));
 $('password-button').addEventListener('click',()=>modal('password-modal'));
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
 for(const id of ['filter-status','filter-category'])$(id).addEventListener('change',renderTickets);
 $('filter-search').addEventListener('input',renderTickets);
 $('ticket-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,btn=form.querySelector('[type=submit]');btn.disabled=true;
  try{
    const data=Object.fromEntries(new FormData(form));const r=await api('/api/tickets',{method:'POST',body:JSON.stringify(data)});
    form.reset();closeModal('new-ticket-modal');await refresh();pop('Zgłoszenie '+r.ticket.number+' zostało zapisane.');await openTicket(r.ticket.id);
  }catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('comment-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{await api('/api/tickets/'+state.selectedId+'/events',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();await openTicket(state.selectedId);pop('Zapisano komentarz.');}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('attachment-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{const data=new FormData(f);await api('/api/tickets/'+state.selectedId+'/attachments',{method:'POST',body:data});f.reset();await openTicket(state.selectedId);pop('Dodano załącznik.');}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 $('save-status').addEventListener('click',()=>updateTicket({status:$('detail-status').value,details:$('admin-note').value}));
 $('ack-button').addEventListener('click',()=>updateTicket({event:'acknowledge',details:$('admin-note').value}));
 $('onsite-button').addEventListener('click',()=>updateTicket({event:'on_site',details:$('admin-note').value}));
 $('resolved-button').addEventListener('click',()=>updateTicket({event:'resolve',details:$('admin-note').value}));
 $('ticket-pdf').addEventListener('click',()=>{if(state.selectedId)location.href='/api/reports/tickets/'+state.selectedId+'.pdf';});
 $('month-pdf').addEventListener('click',()=>{const m=$('report-month').value;if(m)location.href='/api/reports/month.pdf?month='+encodeURIComponent(m);else pop('Wybierz miesiąc.',true);});
 $('month-csv').addEventListener('click',()=>{const m=$('report-month').value;if(m)location.href='/api/reports/month.csv?month='+encodeURIComponent(m);else pop('Wybierz miesiąc.',true);});
 $('password-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,btn=f.querySelector('button');btn.disabled=true;
  try{await api('/api/change-password',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(f)))});f.reset();closeModal('password-modal');pop('Hasło zostało zmienione.');}
  catch(err){pop(err.message,true);}finally{btn.disabled=false;}
 });
 document.querySelectorAll('.overlay').forEach(x=>x.addEventListener('click',e=>{if(e.target===x)closeModal(x.id);}));
 document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.overlay').forEach(x=>show(x.id,false));});
}
wireEvents();initialize();