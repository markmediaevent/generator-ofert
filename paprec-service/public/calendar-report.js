'use strict';
// Historia pracy i dokumentacja zdjęciowa MIWIPOL.
const calReport={current:null,seq:0,images:[],details:null};
const isWorkAdmin=()=>state.me?.role==='admin';
function releaseReportPhotos(){
 for(const url of calReport.images)URL.revokeObjectURL(url);
 calReport.images=[];
}
function closeWorkReport(){
 calReport.current=null;calReport.details=null;calReport.seq++;
 releaseReportPhotos();
 closeModal('cal-report-modal');
}
async function updateWorkCompletion(item,button){
 if(!isWorkAdmin())return;
 if(button)button.disabled=true;
 const status=item.status==='Wykonane'?'Zaplanowane':'Wykonane';
 try{
  await api('/api/work-calendar/'+encodeURIComponent(item.id)+'/status',{method:'PATCH',body:JSON.stringify({status})});
  await calendarLoad();
  if(calReport.current&&String(calReport.current.id)===String(item.id))await refreshWorkReport();
  pop(status==='Wykonane'?'Praca oznaczona jako wykonana.':'Praca ponownie oznaczona jako zaplanowana.');
 }catch(e){pop(e.message,true);}finally{if(button)button.disabled=false;}
}
function makeCalendarEntry(item){
 const row=node('div','cal-entry');
 if(isWorkAdmin()){
  const done=item.status==='Wykonane';
  const b=node('button','cal-check'+(done?' checked':''),done?'✓':'');
  b.type='button';b.title=done?'Cofnij oznaczenie wykonania':'Oznacz pracę jako wykonaną';
  b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(done));
  b.addEventListener('click',()=>updateWorkCompletion(item,b));
  row.append(b);
 }else{
  row.append(node('span','cal-check cal-check-readonly'+(item.status==='Wykonane'?' checked':''),item.status==='Wykonane'?'✓':'•'));
 }
 const b=calButton('','cal-agenda-item',()=>openWorkReport(item));
 const datePart=node('span','cal-agenda-date',calTime(item));
 const content=node('span','cal-agenda-details');
 content.append(node('strong','',item.title),node('small','',item.address));
 const counts=[];
 if(Number(item.notes_count)>0)counts.push('📝 '+item.notes_count+' notatek');
 if(Number(item.photos_count)>0)counts.push('📷 '+item.photos_count+' zdjęć');
 if(counts.length)content.append(node('small','cal-progress-count',counts.join(' · ')));
 const status=node('span','cal-status '+calStateClass(item.status),item.status);
 b.append(datePart,content,status);
 row.append(b);
 return row;
}
async function openWorkReport(item){
 calReport.current=item;calReport.details=null;
 $('cal-report-title').textContent=item.title;
 $('cal-report-address').textContent=item.address;
 $('cal-report-date').textContent=calDateLabel(item.work_date)+(item.start_time?' · '+calTime(item):'');
 $('cal-report-status').textContent=item.status;
 $('cal-report-status').className='cal-status '+calStateClass(item.status);
 show('cal-report-controls',isWorkAdmin());
 show('cal-report-edit',isWorkAdmin());
 modal('cal-report-modal');
 await refreshWorkReport();
}
async function refreshWorkReport(silent=false){
 if(!calReport.current)return;
 const id=String(calReport.current.id),seq=++calReport.seq;
 if(!silent)$('cal-report-feedback').textContent='Pobieranie raportu…';
 try{
  const result=await api('/api/work-calendar/'+encodeURIComponent(id)+'/report');
  if(calReport.seq!==seq||!calReport.current||String(calReport.current.id)!==id)return;
  calReport.details=result;
  calReport.current=result.event;
  paintWorkReport(result,seq);
 }catch(error){
  if(calReport.seq!==seq)return;
  $('cal-report-feedback').textContent='Nie udało się pobrać raportu: '+error.message;
 }
}
function paintWorkReport(result,seq){
 const e=result.event;
 $('cal-report-title').textContent=e.title;
 $('cal-report-address').textContent=e.address;
 $('cal-report-date').textContent=calDateLabel(e.work_date)+(e.start_time?' · '+calTime(e):'');
 const badge=$('cal-report-status');badge.textContent=e.status;badge.className='cal-status '+calStateClass(e.status);
 $('cal-report-feedback').textContent='Bieżący raport · '+result.activity.length+' wpisów · '+result.photos.length+' zdjęć';
 $('cal-report-planned-note').textContent=e.notes?'Uwagi do planu: '+e.notes:'';
 const done=e.status==='Wykonane';
 const mark=$('cal-report-complete');
 mark.textContent=done?'✓ Wykonane — cofnij oznaczenie':'✓ Oznacz jako wykonane';
 mark.className=done?'btn cal-done-action':'btn main';
 show('cal-report-controls',isWorkAdmin());
 show('cal-report-edit',isWorkAdmin());
 const activity=$('cal-report-activity');clear(activity);
 releaseReportPhotos();
 if(!result.activity.length)activity.append(node('p','cal-empty','Brak wpisów w raporcie. Dodaj notatkę lub zdjęcie, aby rozpocząć dokumentację.'));
 const byActivity=new Map();
 for(const photo of result.photos){
  const key=String(photo.activity_id);
  if(!byActivity.has(key))byActivity.set(key,[]);
  byActivity.get(key).push(photo);
 }
 for(const log of result.activity){
  const article=node('article','cal-log-entry');
  const header=node('div','cal-log-top');
  const heading=log.kind==='note'?'Notatka z prac':log.kind==='status'?'Zmiana statusu':'Dodano zdjęcie';
  header.append(node('strong','',heading),node('small','',date(log.created_at)+' · '+log.author));
  article.append(header);
  if(log.kind==='status')article.append(node('p','cal-log-body',(log.old_status||'')+' → '+(log.new_status||'')));
  else if(log.kind==='note')article.append(node('p','cal-log-body',log.body));
  const photos=byActivity.get(String(log.id))||[];
  if(photos.length){
   const gallery=node('div','cal-photo-grid');
   for(const photo of photos){
    const a=node('a','cal-photo-link');a.target='_blank';a.rel='noopener noreferrer';a.title='Otwórz zdjęcie: '+photo.filename;
    const img=node('img','cal-photo');img.alt=photo.filename;img.loading='lazy';
    const caption=node('span','cal-photo-name',photo.filename);
    a.append(img,caption);gallery.append(a);
    renderProtectedPhoto(photo.id,a,img,seq);
   }
   article.append(gallery);
  }
  activity.append(article);
 }
}
async function renderProtectedPhoto(photoId,link,img,seq){
 try{
  const url='/api/work-calendar/photos/'+encodeURIComponent(photoId);
  const response=await fetch(API_BASE+url,{
   credentials:API_BASE?'omit':'same-origin',
   headers:reqHeaders(undefined,{})
  });
  if(!response.ok)throw Error('Zdjęcie niedostępne');
  const blob=await response.blob();
  if(calReport.seq!==seq||!calReport.current)return;
  const objectURL=URL.createObjectURL(blob);
  calReport.images.push(objectURL);
  link.href=objectURL;img.src=objectURL;
 }catch(err){
  if(calReport.seq!==seq)return;
  img.alt='Nie udało się pobrać zdjęcia';
  link.removeAttribute('href');
 }
}
function setupWorkReporting(){
 $('cal-report-refresh').addEventListener('click',()=>refreshWorkReport());
 $('cal-report-edit').addEventListener('click',()=>{
  const item=calReport.current;
  if(!isWorkAdmin()||!item)return;
  closeWorkReport();openCalendarForm(item);
 });
 $('cal-report-complete').addEventListener('click',async()=>{
  if(calReport.current&&isWorkAdmin())await updateWorkCompletion(calReport.current,$('cal-report-complete'));
 });
 $('cal-note-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!isWorkAdmin()||!calReport.current)return;
  const f=e.target,b=f.querySelector('button[type="submit"]'),body=f.elements.body.value.trim();
  if(body.length<2)return pop('Wpisz treść notatki.',true);
  b.disabled=true;
  try{
   await api('/api/work-calendar/'+encodeURIComponent(calReport.current.id)+'/notes',{
    method:'POST',body:JSON.stringify({body})
   });
   f.reset();await refreshWorkReport();pop('Notatka została dodana do raportu MIWIPOL.');
  }catch(error){pop(error.message,true);}finally{b.disabled=false;}
 });
 $('cal-photo-input').addEventListener('change',()=>{
  const files=[...$('cal-photo-input').files];
  $('cal-photo-selected').textContent=files.length?('Wybrano '+files.length+' zdjęć: '+files.map(f=>f.name).join(', ')):'JPG, PNG, WebP lub HEIC · do 12 naraz, 40 na pracę · maks. 8 MB';
 });
 $('cal-photo-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!isWorkAdmin()||!calReport.current)return;
  const form=e.target,button=form.querySelector('button[type="submit"]'),files=[...$('cal-photo-input').files];
  if(!files.length)return pop('Najpierw wybierz zdjęcia.',true);
  if(files.length>12||files.some(x=>x.size>8*1024*1024||!x.size))return pop('Wybierz do 12 zdjęć, każde maksymalnie 8 MB.',true);
  button.disabled=true;
  let saved=0;
  try{
   for(const file of files){
    const fd=new FormData();fd.append('file',file,file.name);
    try{await api('/api/work-calendar/'+encodeURIComponent(calReport.current.id)+'/photos',{method:'POST',body:fd});saved++;}
    catch(err){pop('Zapisano '+saved+' zdjęć. Błąd: '+err.message,true);break;}
   }
   form.reset();$('cal-photo-selected').textContent='JPG, PNG, WebP lub HEIC · do 12 naraz, 40 na pracę · maks. 8 MB';
   await refreshWorkReport();
   if(saved===files.length)pop('Zdjęcia dodane do raportu: '+saved+'.');
  }catch(error){pop(error.message,true);}finally{button.disabled=false;}
 });
 document.querySelectorAll('[data-close="cal-report-modal"]').forEach(el=>el.addEventListener('click',()=>{
  calReport.current=null;calReport.details=null;calReport.seq++;releaseReportPhotos();
 }));
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&calReport.current&& !$('cal-report-modal').classList.contains('hide')){
   calReport.current=null;calReport.details=null;calReport.seq++;releaseReportPhotos();
  }
 });
}
document.addEventListener('DOMContentLoaded',setupWorkReporting);
