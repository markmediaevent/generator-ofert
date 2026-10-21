'use strict';
const query=new URLSearchParams(location.search);
const offer=query.get('offer')||'';
const apiPath='/api/packlists/'+encodeURIComponent(offer);
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt=value=>Number(value).toLocaleString('pl-PL',{maximumFractionDigits:2});
let quote=null;
let state={checked:{},checkedBy:{},notes:{},extraItems:[],ledConfigs:{},revision:0};
let items=[],pending=0,queue=Promise.resolve(),noteTimers=new Map(), lastError=false,loading=false;
const keyFor=(item,index)=>/^[a-zA-Z0-9._:-]{1,125}$/.test(String(item.uid||''))?item.uid:'legacy-'+index;
function setStatus(text,isError=false){const box=$('status');box.textContent=text;box.classList.toggle('error',isError);lastError=isError;}
function crewItem(item){return item.category==='crew'||item.source==='personnel'||item.kind==='crew';}
function screenItem(item){return MM_LED.isScreen(item);}
function initialLed(key,item){return state.ledConfigs[key]||MM_LED.initialConfig(item);}
function calcFor(item,key){return MM_LED.calculate(initialLed(key,item));}
function logisticFor(key){return {...MM_LED.LOGISTICS_DEFAULTS,...(state.ledLogistics?.[key]||{})};}
function derivedLedRows(){
 const rows=[];
 for(const row of quoteRows()){
   if(!screenItem(row.data))continue;
   const c=calcFor(row.data,row.key);
   if(!c)continue;
   const plan=MM_LED.logistics(c,logisticFor(row.key));
   const grp='Ekran '+row.data.name+' — osprzęt';
   const generated=[
     ['case','Skrzynie transportowe na kabinety',plan.cases,'case','Założono '+plan.caseSize+' kabinetów / case'],
     ['data-jumper','Przewody DATA pomiędzy kabinetami',plan.dataJumpers,'szt.','Połączenia w obrębie '+plan.dataRuns+' ciągów DATA'],
     ['data-feed','Przewody DATA do pierwszych kabinetów',plan.dataRuns,'szt.','Jeden przewód wejściowy na ciąg DATA'],
     ['power-jumper','Przewody zasilające między kabinetami',plan.powerJumpers,'szt.','Połączenia w obrębie '+plan.powerRuns+' obwodów AC'],
     ['power-feed','Przewody zasilające startowe',plan.powerRuns,'szt.','Jeden przewód startowy na obwód AC']
   ];
   if(plan.spares>0)generated.unshift(['spare','Kabinet zapasowy',plan.spares,'szt.','Kabinet zapasowy nie wchodzi w wymiary ekranu']);
   for(const [type,name,qty,unit,details] of generated){
     rows.push({key:'autogen:'+row.key+':'+type,auto:true,extra:false,data:{
       name,qty,unitLabel:unit,category:'led',categoryLabel:'Osprzęt LED · automatycznie',
       groupName:grp,source:'led-auto',details,ownership:'unknown'
     }});
   }
 }
 return rows;
}
function qtyText(item,key){
  if(screenItem(item)){
    const result=calcFor(item,key);
    if(result)return result.total+' kabinetów';
    return 'Ustal kabinety';
  }
  const qty=fmt(item.qty||0);
  return qty+' '+(item.pricingMode==='per_m2'?'m²':item.unitLabel||item.unit|| (item.kind==='task'?'zad.':'szt.'));
}
function quoteRows(){
 return (Array.isArray(quote?.items)?quote.items:[]).map((data,index)=>({data,key:keyFor(data,index),extra:false}));
}
function rebuild(){
 const extra=(state.extraItems||[]).map(item=>({
   key:item.id,extra:true,data:{
    name:item.name,groupName:item.groupName,categoryLabel:item.kind==='crew'?'Personel techniczny':'Ręczne pozycje',
    qty:item.qty,unitLabel:item.unit,source:item.kind==='crew'?'personnel':'manual-pack',
    kind:item.kind,ownership:'manual',sourceLabel:item.source,details:item.details
   }
 }));
 items=[...quoteRows(),...derivedLedRows(),...extra];
}
function progress(){
 const checked=items.filter(i=>state.checked[i.key]===true).length;
 $('summary').style.display='flex';
 $('summary').innerHTML='<strong>Wykonano: '+checked+' / '+items.length+' pozycji</strong><span>'+Math.round((checked/(items.length||1))*100)+'%</span>';
}
function meta(){
 const entries=[
   ['Numer oferty',quote.offerNumber||offer],['Wydarzenie',quote.eventName||'—'],
   ['Klient',quote.clientName||'—'],['Data wydarzenia',quote.eventDate||'—'],
   ['Lokalizacja',quote.location||'—'],['Status oferty',quote.offerStatus||'Szkic']
 ];
 $('meta').innerHTML=entries.map(([key,val])=>'<div><span>'+esc(key)+'</span><strong>'+esc(val)+'</strong></div>').join('');
}
function grouped(){
 const result=new Map();
 for(const row of items){
   const item=row.data;
   const label=crewItem(item)?'PERSONEL / OBSŁUGA': (row.auto?'AUTOMAT LED':row.extra?'DODANE RĘCZNIE':'SPRZĘT / ZAKRES OFERTY');
   const group=item.groupName||item.categoryLabel||'Pozostałe';
   const key=label+' / '+group;
   if(!result.has(key))result.set(key,{title:key,rows:[],crew:crewItem(item)});
   result.get(key).rows.push(row);
 }
 return Array.from(result.values());
}
function groupHtml(group){
 const head='<div class="grid-head"><span>OK</span><span>Pozycja / szczegóły</span><span>Ilość</span><span>Źródło / obsada</span><span>Uwagi / akcje</span></div>';
 const rows=group.rows.map(row=>{
   const item=row.data,key=row.key,checked=state.checked[key]===true;
   const led=screenItem(item)?calcFor(item,key):null;
   const leds=screenItem(item)?(led?led.columns+' × '+led.rows+' · '+(led.cabWidth*100)+'×'+(led.cabHeight*100)+' cm'+(led.exact?'':' · WYMIAR ZAOKRĄGLONY'):'Brak modelu lub wymiarów — skonfiguruj powyżej'):'';
   const details=[item.groupName||'',item.details||'',leds].filter(Boolean).join(' · ');
   const owner=row.auto?'Wyliczono automatycznie':row.extra?(item.sourceLabel||'Dodano do pack listy'):
     crewItem(item)?(item.assignedNames||item.sourceLabel||'Do obsadzenia'):
     item.ownership==='cross-rental'?'Cross-rental':
     item.ownership==='own'||item.ownership==='owned'?'Własny':'Do ustalenia';
   const stock=Number(item.stockAtQuote);
   const stockWarning=!row.extra&&item.stockAtQuote!=null&&item.ownership!=='cross-rental'&&!screenItem(item)&&Number(item.qty)>stock?' · sprawdź stan magazynu':'';
   const by=state.checkedBy?.[key];
   const checkWho=checked&&by?.username?'<small>Zaznaczył: '+esc(by.username)+'</small>':'';
   const actions=row.extra?'<div class="extra-actions no-print"><button type="button" class="small-btn" data-edit="'+esc(key)+'">Edytuj</button><button type="button" class="small-btn remove" data-remove="'+esc(key)+'">Usuń</button></div>':'';
   return '<div class="pack-row" data-row="'+esc(key)+'" data-checked="'+checked+'">'+
    '<button class="check" type="button" data-check="'+esc(key)+'" aria-label="'+(checked?'Odznacz':'Zaznacz')+'" aria-pressed="'+checked+'">'+(checked?'☑':'☐')+'</button>'+
    '<div><strong>'+esc(item.name||'Pozycja')+'</strong><small>'+esc(details)+'</small>'+checkWho+'</div>'+
    '<div class="qty">'+esc(qtyText(item,key))+'</div>'+
    '<div class="source">'+esc(owner+stockWarning)+'</div>'+
    '<div><div class="note" contenteditable="true" role="textbox" aria-label="Notatka logistyczna" data-note="'+esc(key)+'">'+esc(
      Object.prototype.hasOwnProperty.call(state.notes||{},key)?state.notes[key]:item.internalNotes||''
    )+'</div>'+actions+'</div></div>';
 }).join('');
 return '<section class="group"><div class="group-head"><h2>'+esc(group.title)+'</h2><small>'+group.rows.length+' pozycji</small></div>'+head+rows+'</section>';
}
function modelsOptions(selected){
 const options=[['','— wybierz model —'],...Object.values(MM_LED.MODELS).map(x=>[x.id,x.label+' ('+(x.width*100)+'×'+(x.height*100)+' cm)'])];
 return options.map(([id,label])=>'<option value="'+esc(id)+'"'+(id===selected?' selected':'')+'>'+esc(label)+'</option>').join('');
}
function ledHtml(){
 const screens=items.filter(row=>!row.extra&&!row.auto&&screenItem(row.data));
 if(!screens.length){$('ledPanel').innerHTML='';return;}
 $('ledPanel').innerHTML='<section class="led-section"><div class="group-head"><h2>Ekrany LED — przeliczenie kabinetów</h2></div>'+
 '<p class="help">Liczba kabinetów = kolumny × rzędy. Ustaw pojemność skrzyń i maksymalną liczbę kabinetów w ciągu DATA / AC. To założenia planowania, niezweryfikowane limity producentów. Zweryfikuj obciążenia, dokumentację i topologię przed realizacją. Zmiana ustawień odznacza wyliczone pozycje tego ekranu.</p>'+
 screens.map(row=>{
   const config=initialLed(row.key,row.data);
   const result=MM_LED.calculate(config);
   const logistics=logisticFor(row.key);
   const plan=MM_LED.logistics(result,logistics);
   const text=result?
     result.columns+' kolumn × '+result.rows+' rzędów = '+result.total+' kabinetów '+result.modelLabel+
     ' ('+(result.cabWidth*100)+'×'+(result.cabHeight*100)+' cm).'+
     (result.exact?' Układ idealnie pasuje.':' UWAGA! Układ daje '+fmt(result.builtWidth)+' × '+fmt(result.builtHeight)+' m, zamiast '+fmt(config.width)+' × '+fmt(config.height)+' m. Popraw wymiary lub potwierdź nadmiar.')
     :'Wybierz model i podaj wymiary w metrach, aby automatycznie wyliczyć kabinety.';
   return '<form class="led-config" data-led-config="'+esc(row.key)+'">'+
     '<strong class="led-label">'+esc(row.data.name)+'</strong>'+
     '<label>Model<select name="model">'+modelsOptions(config.model)+'</select></label>'+
     '<label>Szerokość ekranu (m)<input name="width" type="number" min="0.01" max="500" step="0.01" value="'+esc(config.width||'')+'" required></label>'+
     '<label>Wysokość ekranu (m)<input name="height" type="number" min="0.01" max="500" step="0.01" value="'+esc(config.height||'')+'" required></label>'+
     '<label class="led-orientation"'+(config.model==='dicolor-p4'?'':' style="display:none"')+'>Obrót kabinetu (Dicolor)<select name="orientation"><option value="vertical"'+(config.orientation!=='horizontal'?' selected':'')+'>Bez obrotu (50×100 cm)</option><option value="horizontal"'+(config.orientation==='horizontal'?' selected':'')+'>Po obrocie (100×50 cm)</option></select></label>'+
     '<label>Kabinety / case<input name="caseSize" type="number" min="1" max="50" step="1" value="'+esc(logistics.caseSize)+'" required></label>'+
     '<label>Kabinety / ciąg DATA<input name="dataChainSize" type="number" min="1" max="100" step="1" value="'+esc(logistics.dataChainSize)+'" required></label>'+
     '<label>Kabinety / obwód AC<input name="powerChainSize" type="number" min="1" max="100" step="1" value="'+esc(logistics.powerChainSize)+'" required></label>'+
     '<label>Kabinety zapasowe<input name="spares" type="number" min="0" max="1000" step="1" value="'+esc(logistics.spares)+'" required></label>'+
     '<div class="led-result '+(result&&!result.exact?'warn':'')+'">'+esc(text+(plan?' | Skrzynie: '+plan.cases+' · DATA: '+plan.dataJumpers+' łączących + '+plan.dataRuns+' startowych · AC: '+plan.powerJumpers+' łączących + '+plan.powerRuns+' startowych':'') )+'</div>'+
     '<button type="submit" class="btn primary">Przelicz i zapisz</button></form>';
 }).join('')+'</section>';
}
function render(){
 if(!quote)return;
 rebuild();meta();ledHtml();
 $('list').innerHTML=grouped().map(groupHtml).join('')||'<section class="group"><p style="padding:15px">Brak pozycji. Dodaj pierwszą poniżej.</p></section>';
 progress();
}
function noteValue(el){return (el.innerText||'').slice(0,500);}
function normalizeState(input){
 return {checked:input?.checked||{},checkedBy:input?.checkedBy||{},notes:input?.notes||{},
   extraItems:input?.extraItems||[],ledConfigs:input?.ledConfigs||{},ledLogistics:input?.ledLogistics||{},revision:input?.revision||0,updatedAt:input?.updatedAt||''};
}
function requestMutation(payload){
 pending++;
 setStatus('Zapisywanie zmian w pack liście…');
 const action=queue.catch(()=>{}).then(async()=>{
   const response=await fetch(apiPath,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.message||'Błąd zapisu ('+response.status+').');
   return result;
 });
 queue=action.then(result=>{
   pending--;
   if(!pending){state=normalizeState(result.data);render();setStatus('Zapisano · '+new Date().toLocaleTimeString('pl-PL'));}
   return result;
 },error=>{
   pending--;
   setStatus('BŁĄD ZAPISU: '+error.message+' — odśwież dane i spróbuj ponownie.',true);
   throw error;
 });
 return queue;
}
function changeChecked(key){
 const current=state.checked[key]===true, next=!current;
 if(next)state.checked[key]=true;else delete state.checked[key];
 const row=document.querySelector('[data-row="'+CSS.escape(key)+'"]');
 if(row){
   row.dataset.checked=String(next);
   const button=row.querySelector('[data-check]');
   if(button){button.textContent=next?'☑':'☐';button.setAttribute('aria-pressed',String(next));}
 }
 progress();
 requestMutation({action:'setChecked',id:key,value:next}).catch(()=>{});
}
function setNote(key,value){
 state.notes[key]=value;
 requestMutation({action:'setNote',id:key,value}).catch(()=>{});
}
function cancelExtraEdit(){
 $('extraForm').reset();
 $('extraId').value='';
 $('extraSave').textContent='Dodaj do listy';
 $('extraCancel').hidden=true;
}
function extraFormData(){
 const f=$('extraForm');
 return {
  kind:f.elements.kind.value,name:f.elements.name.value.trim(),qty:Number(f.elements.qty.value),
  unit:f.elements.unit.value.trim(),groupName:f.elements.groupName.value.trim(),
  source:f.elements.source.value.trim(),details:f.elements.details.value.trim()
 };
}
function showExtraEdit(id){
 const current=(state.extraItems||[]).find(x=>x.id===id);
 if(!current)return;
 const f=$('extraForm');for(const key of ['kind','name','qty','unit','groupName','source','details'])f.elements[key].value=current[key]||'';
 $('extraId').value=id;
 $('extraSave').textContent='Zapisz zmianę';
 $('extraCancel').hidden=false;
 f.scrollIntoView({behavior:'smooth',block:'center'});
}
$('extraForm').addEventListener('submit',event=>{
 event.preventDefault();
 if(!quote){setStatus('Najpierw wczytaj ofertę.',true);return;}
 const item=extraFormData();
 if(!item.name||!Number.isFinite(item.qty)||item.qty<=0){setStatus('Wpisz nazwę i poprawną ilość.',true);return;}
 const id=$('extraId').value;
 $('extraSave').disabled=true;
 requestMutation(id?{action:'updateItem',id,item}:{action:'addItem',item})
  .then(()=>cancelExtraEdit()).catch(()=>{}).finally(()=>$('extraSave').disabled=false);
});
$('extraCancel').addEventListener('click',cancelExtraEdit);
$('extraForm').elements.kind.addEventListener('change',event=>{
 if(event.target.value==='task'&&$('extraForm').elements.unit.value==='szt.')$('extraForm').elements.unit.value='zad.';
});
$('list').addEventListener('click',event=>{
 const check=event.target.closest('[data-check]');
 if(check){changeChecked(check.dataset.check);return;}
 const edit=event.target.closest('[data-edit]');
 if(edit){showExtraEdit(edit.dataset.edit);return;}
 const remove=event.target.closest('[data-remove]');
 if(remove){
   const id=remove.dataset.remove;
   if(!confirm('Usunąć ręcznie dodaną pozycję z pack listy?'))return;
   requestMutation({action:'removeItem',id}).catch(()=>{});
 }
});
$('list').addEventListener('focusout',event=>{
 const el=event.target.closest('[data-note]');
 if(!el)return;
 const key=el.dataset.note,value=noteValue(el);
 if((state.notes[key]??'')!==value)setNote(key,value);
});
$('ledPanel').addEventListener('submit',event=>{
 const form=event.target.closest('[data-led-config]');
 if(!form)return;
 event.preventDefault();
 const config={
   model:form.elements.model.value,
   width:Number(form.elements.width.value),height:Number(form.elements.height.value),
   orientation:form.elements.orientation.value
 };
 const logistics={
   caseSize:Number(form.elements.caseSize.value),
   dataChainSize:Number(form.elements.dataChainSize.value),
   powerChainSize:Number(form.elements.powerChainSize.value),
   spares:Number(form.elements.spares.value)
 };
 if(!MM_LED.calculate(config)){setStatus('Wybierz model i poprawne wymiary ekranu LED.',true);return;}
 if(!Number.isInteger(logistics.caseSize)||logistics.caseSize<1||logistics.caseSize>50 ||
    !Number.isInteger(logistics.dataChainSize)||logistics.dataChainSize<1||logistics.dataChainSize>100 ||
    !Number.isInteger(logistics.powerChainSize)||logistics.powerChainSize<1||logistics.powerChainSize>100 ||
    !Number.isInteger(logistics.spares)||logistics.spares<0||logistics.spares>1000){
   setStatus('Popraw liczbę kabinetów na case, ciąg DATA, obwód AC i zapas.',true);return;
 }
 requestMutation({action:'setLedSetup',id:form.dataset.ledConfig,config,logistics}).catch(()=>{});
});
$('ledPanel').addEventListener('input',event=>{
 const form=event.target.closest('[data-led-config]');
 if(!form)return;
 const config={model:form.elements.model.value,width:form.elements.width.value,height:form.elements.height.value,orientation:form.elements.orientation.value};
 const result=MM_LED.calculate(config),el=form.querySelector('.led-result');
 const plan=MM_LED.logistics(result,{
   caseSize:Number(form.elements.caseSize.value),dataChainSize:Number(form.elements.dataChainSize.value),
   powerChainSize:Number(form.elements.powerChainSize.value),spares:Number(form.elements.spares.value)
 });
 el.classList.toggle('warn',!!result&&!result.exact);
 el.textContent=result?(result.columns+' × '+result.rows+' = '+result.total+' kabinetów. '+(result.exact?'Wymiary pasują.':'NADMIAR: '+fmt(result.builtWidth)+' × '+fmt(result.builtHeight)+' m.')+(plan?' Skrzynie: '+plan.cases+' · DATA '+plan.dataJumpers+' + '+plan.dataRuns+' · AC '+plan.powerJumpers+' + '+plan.powerRuns:'')):'Uzupełnij wymiary i wybierz model.';
});
$('ledPanel').addEventListener('change',event=>{
 const form=event.target.closest('[data-led-config]');
 if(!form)return;
 const payload={model:form.elements.model.value,width:form.elements.width.value,height:form.elements.height.value,orientation:form.elements.orientation.value};
 const orientation=form.querySelector('.led-orientation');
 if(orientation)orientation.style.display=payload.model==='dicolor-p4'?'flex':'none';
 const result=MM_LED.calculate(payload);
 if(result){
   const el=form.querySelector('.led-result');
   const plan=MM_LED.logistics(result,{caseSize:Number(form.elements.caseSize.value),dataChainSize:Number(form.elements.dataChainSize.value),powerChainSize:Number(form.elements.powerChainSize.value),spares:Number(form.elements.spares.value)});
   el.textContent=result.columns+' × '+result.rows+' = '+result.total+' kabinetów'+(result.exact?' · wymiary dokładne':' · nadmiar: '+fmt(result.builtWidth)+'×'+fmt(result.builtHeight)+' m')+(plan?' · Skrzynie: '+plan.cases+' · DATA '+plan.dataJumpers+' + '+plan.dataRuns+' · AC '+plan.powerJumpers+' + '+plan.powerRuns:'');
 }
});
async function clearChecks(){
 if(!confirm('Odznaczyć wszystkie pozycje dla tego wydarzenia?'))return;
 requestMutation({action:'resetChecks'}).catch(()=>{});
}
async function reload(){
 if(!offer){setStatus('Brak numeru oferty. Otwórz pack listę z generatora.',true);return;}
 if(pending)return;
 try{
   const response=await fetch(apiPath);
   if(!response.ok)throw new Error(response.status===401?'Sesja wygasła — zaloguj się ponownie.':'Nie można odświeżyć listy.');
   state=normalizeState((await response.json()).data);
   render();setStatus('Synchronizacja zakończona · '+new Date().toLocaleTimeString('pl-PL'));
 }catch(error){setStatus(error.message,true);}
}
$('logoutPack').addEventListener('click',async()=>{
 await fetch('/api/logout',{method:'POST'}).catch(()=>{});
 localStorage.removeItem('admin_token');
 location.href='/login';
});
async function init(){
 if(!offer){setStatus('Brak numeru oferty. Wygeneruj pack listę z generatora ofert.',true);return;}
 const mine=await fetch('/api/me').catch(()=>null);
 if(!mine||mine.status===401){location.href='/login';return;}
 if(mine.ok){const me=await mine.json();$('offerBack').hidden=me.role==='pracownik';}
 try{
   const [saved,pack]=await Promise.all([fetch(apiPath+'/brief'),fetch(apiPath)]);
   if(!saved.ok)throw new Error('Nie znaleziono zapisanej oferty. Zapisz ją najpierw w generatorze.');
   if(!pack.ok)throw new Error(pack.status===401?'Zaloguj się ponownie.':'Błąd pobierania pack listy.');
   quote=(await saved.json()).data||{};
   state=normalizeState((await pack.json()).data);
   render();setStatus('Lista gotowa · zmiany zapisują się na serwerze. Pracownicy mogą zaznaczać pozycje na swoich urządzeniach.');
 }catch(error){setStatus(error.message,true);}
}
async function printPacklist(){
 try{await queue;}catch(error){}
 window.print();
}
setInterval(()=>{
 if(pending||document.activeElement?.isContentEditable||$('extraForm').contains(document.activeElement)||$('ledPanel').contains(document.activeElement))return;
 reload();
},30000);
init();
