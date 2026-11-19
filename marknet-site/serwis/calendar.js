'use strict';
// Prywatny terminarz MIWIPOL: bez zewnętrznych bibliotek i zapisu w localStorage.
const workCal={today:warToday(),year:0,month:0,selected:'',events:[],view:'month',initialized:false,visible:false,seq:0,error:''};
workCal.year=Number(workCal.today.slice(0,4));
workCal.month=Number(workCal.today.slice(5,7))-1;
workCal.selected=workCal.today;
function warToday(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function calISO(d){return d.toISOString().slice(0,10);}
function calUTC(y,m,d){return new Date(Date.UTC(y,m,d));}
function calMonthName(y,m){const name=new Intl.DateTimeFormat('pl-PL',{month:'long',year:'numeric',timeZone:'UTC'}).format(calUTC(y,m,1));return name.charAt(0).toLocaleUpperCase('pl-PL')+name.slice(1);}
function calDateLabel(v){return new Intl.DateTimeFormat('pl-PL',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(v+'T12:00:00Z'));}
function calDateShort(v){return new Intl.DateTimeFormat('pl-PL',{day:'numeric',month:'short',weekday:'short',timeZone:'UTC'}).format(new Date(v+'T12:00:00Z'));}
function calRange(){
 const first=calUTC(workCal.year,workCal.month,1);
 const offset=(first.getUTCDay()+6)%7;
 const from=calUTC(workCal.year,workCal.month,1-offset);
 const to=calUTC(workCal.year,workCal.month,42-offset);
 return [calISO(from),calISO(to)];
}
function calStateClass(status){return status==='Wykonane'?'done':status==='W trakcie'?'active':status==='Odwołane'?'cancelled':'planned';}
function calTime(item){return item.start_time?(item.start_time+(item.end_time?'–'+item.end_time:'')):'Cały dzień';}
function calButton(label,cls,click){const b=node('button',cls,label);b.type='button';b.addEventListener('click',click);return b;}
function setupWorkCalendar(){
 const allowed=state.me?.role==='admin'||(state.me?.role==='client'&&state.me.clientName==='MIWIPOL');
 workCal.visible=allowed;
 show('work-calendar',allowed);
 if(!allowed){workCal.seq++;workCal.events=[];return;}
 if(!workCal.initialized)bindWorkCalendar();
 const today=warToday();
 workCal.today=today;workCal.selected=today;workCal.year=Number(today.slice(0,4));workCal.month=Number(today.slice(5,7))-1;
 workCal.view='month';
 calendarLoad();
}
async function calendarLoad(){
 if(!workCal.visible)return;
 const seq=++workCal.seq;
 const [from,to]=calRange();
 $('cal-feedback').textContent='Ładowanie terminów…';
 workCal.error='';
 try{
  const r=await api('/api/work-calendar?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));
  if(seq!==workCal.seq||!workCal.visible)return;
  workCal.events=Array.isArray(r.events)?r.events:[];
  workCal.error='';calendarRender();
 }catch(e){
  if(seq!==workCal.seq)return;
  workCal.events=[];workCal.error=e.message;calendarRender();
 }
}
function calendarRender(){
 if(!workCal.visible)return;
 $('cal-month').textContent=calMonthName(workCal.year,workCal.month);
 $('cal-month-view').setAttribute('aria-pressed',String(workCal.view==='month'));
 $('cal-list-view').setAttribute('aria-pressed',String(workCal.view==='list'));
 show('cal-month-area',workCal.view==='month');show('cal-list-area',workCal.view==='list');
 const currentPrefix=String(workCal.year)+'-'+String(workCal.month+1).padStart(2,'0');
 const current=workCal.events.filter(e=>e.work_date.startsWith(currentPrefix));
 $('cal-feedback').textContent=workCal.error?'Nie można pobrać kalendarza: '+workCal.error:
  (current.length+' '+(current.length===1?'zadanie':current.length>=2&&current.length<=4?'zadania':'zadań')+' w tym miesiącu · '+current.filter(e=>e.status==='Zaplanowane').length+' zaplanowanych');
 if(workCal.error){
  const area=$('cal-month-grid');clear(area);area.append(calButton('Spróbuj ponownie','btn outline',calendarLoad));
  clear($('cal-selected-list'));clear($('cal-list-area'));return;
 }
 const map=new Map();
 for(const item of workCal.events){if(!map.has(item.work_date))map.set(item.work_date,[]);map.get(item.work_date).push(item);}
 const grid=$('cal-month-grid');clear(grid);
 const [from]=calRange();const start=new Date(from+'T12:00:00Z');
 for(let i=0;i<42;i++){
  const d=new Date(start.getTime()+i*86400000),key=calISO(d),items=map.get(key)||[];
  const inside=d.getUTCMonth()===workCal.month;
  const day=calButton('','cal-day'+(inside?'':' muted')+(key===workCal.today?' today':'')+(key===workCal.selected?' selected':'')+([0,6].includes(d.getUTCDay())?' weekend':''),()=>{
   workCal.selected=key;calendarRender();
  });
  day.setAttribute('aria-pressed',String(key===workCal.selected));
  day.setAttribute('aria-label',calDateLabel(key)+', '+items.length+' zadań');
  day.append(node('span','cal-day-number',String(d.getUTCDate())));
  if(items.length){
   const itemsEl=node('span','cal-day-items');
   for(const item of items.slice(0,2)){
    itemsEl.append(node('span','cal-pill '+calStateClass(item.status),
      (item.start_time?item.start_time+' ':'')+item.title));
   }
   if(items.length>2)itemsEl.append(node('span','cal-more','+'+(items.length-2)+' więcej'));
   day.append(itemsEl);
   day.append(node('span','cal-mobile-dots',String(items.length)));
  }
  grid.append(day);
 }
 const selectedItems=map.get(workCal.selected)||[];
 $('cal-selected-title').textContent=calDateLabel(workCal.selected);
 const agenda=$('cal-selected-list');clear(agenda);
 if(!selectedItems.length)agenda.append(node('div','cal-empty','Brak prac w tym dniu. Kliknij „Dodaj pracę”, aby zaplanować termin.'));
 for(const item of selectedItems)agenda.append(calendarItem(item));
 const list=$('cal-list-area');clear(list);
 if(workCal.view==='list'){
  const rows=current.slice().sort((a,b)=>a.work_date.localeCompare(b.work_date)||(a.start_time||'').localeCompare(b.start_time||''));
  if(!rows.length)list.append(node('div','cal-empty','Brak zaplanowanych prac w tym miesiącu.'));
  let previous='';
  for(const item of rows){
   if(item.work_date!==previous){list.append(node('div','cal-group-date',calDateShort(item.work_date)));previous=item.work_date;}
   list.append(calendarItem(item));
  }
 }
}
function calendarItem(item){
 const b=calButton('','cal-agenda-item',()=>openCalendarForm(item));
 const datePart=node('span','cal-agenda-date',calTime(item));
 const content=node('span','cal-agenda-details');
 content.append(node('strong','',item.title),node('small','',item.address));
 const status=node('span','cal-status '+calStateClass(item.status),item.status);
 b.append(datePart,content,status);return b;
}
function calendarShift(offset){
 const next=calUTC(workCal.year,workCal.month+offset,1);
 workCal.year=next.getUTCFullYear();workCal.month=next.getUTCMonth();
 const prefix=String(workCal.year)+'-'+String(workCal.month+1).padStart(2,'0');
 workCal.selected=prefix===workCal.today.slice(0,7)?workCal.today:prefix+'-01';
 calendarLoad();
}
function openCalendarForm(item){
 if(!workCal.visible)return;
 const form=$('cal-form');form.reset();
 form.dataset.eventId=item?String(item.id):'';
 form.elements.title.value=item?.title||'';
 form.elements.address.value=item?.address||'';
 form.elements.work_date.value=item?.work_date||workCal.selected;
 form.elements.start_time.value=item?.start_time||'';
 form.elements.end_time.value=item?.end_time||'';
 form.elements.status.value=item?.status||'Zaplanowane';
 form.elements.notes.value=item?.notes||'';
 $('cal-modal-title').textContent=item?'Edytuj zaplanowaną pracę':'Nowa praca · MIWIPOL';
 show('cal-remove',Boolean(item));
 modal('cal-modal');
 requestAnimationFrame(()=>$('cal-form').elements.title.focus());
}
function bindWorkCalendar(){
 if(workCal.initialized)return;workCal.initialized=true;
 $('cal-prev').addEventListener('click',()=>calendarShift(-1));
 $('cal-next').addEventListener('click',()=>calendarShift(1));
 $('cal-today').addEventListener('click',()=>{
  const t=warToday();workCal.today=t;workCal.year=Number(t.slice(0,4));workCal.month=Number(t.slice(5,7))-1;workCal.selected=t;calendarLoad();
 });
 $('cal-month-view').addEventListener('click',()=>{workCal.view='month';calendarRender();});
 $('cal-list-view').addEventListener('click',()=>{workCal.view='list';calendarRender();});
 $('cal-add').addEventListener('click',()=>openCalendarForm(null));
 $('cal-add-day').addEventListener('click',()=>openCalendarForm(null));
 $('cal-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=e.target,save=$('cal-save'),id=f.dataset.eventId;
  const data=Object.fromEntries(new FormData(f));
  data.start_time=data.start_time||null;data.end_time=data.end_time||null;
  save.disabled=true;
  try{
   await api('/api/work-calendar'+(id?'/'+encodeURIComponent(id):''),{
    method:id?'PATCH':'POST',body:JSON.stringify(data)
   });
   closeModal('cal-modal');
   const y=Number(data.work_date.slice(0,4)),m=Number(data.work_date.slice(5,7))-1;
   workCal.year=y;workCal.month=m;workCal.selected=data.work_date;
   await calendarLoad();
   pop(id?'Zapisano zmiany w terminarzu.':'Dodano pracę do kalendarza.');
  }catch(error){pop(error.message,true);}finally{save.disabled=false;}
 });
 $('cal-remove').addEventListener('click',async()=>{
  const id=$('cal-form').dataset.eventId;
  if(!id||!window.confirm('Usunąć tę pracę z kalendarza MIWIPOL?'))return;
  const b=$('cal-remove');b.disabled=true;
  try{
   await api('/api/work-calendar/'+encodeURIComponent(id),{method:'DELETE'});
   closeModal('cal-modal');await calendarLoad();pop('Usunięto pracę z kalendarza.');
  }catch(error){pop(error.message,true);}finally{b.disabled=false;}
 });
}
