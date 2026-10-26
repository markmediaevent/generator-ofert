'use strict';
const $=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const labels={available:'✓ Dostępny',unavailable:'× Niedostępny',unknown:'— Brak deklaracji'};
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
$('month').value=today.slice(0,7);
let team=false,isAdmin=false,busy=false,days={},users=[];
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function lock(value){busy=value;for(const el of document.querySelectorAll('button,input'))el.disabled=value;}
async function api(url,options){const response=await fetch(url,options);if(response.status===401){location.href='/login';throw Error('Zaloguj się ponownie.');}const data=await response.json();if(!response.ok)throw Error(data.message||'Nie udało się pobrać danych.');return data;}
function dates(){const month=$('month').value;const [year,m]=month.split('-').map(Number);return Array.from({length:new Date(Date.UTC(year,m,0)).getUTCDate()},(_,i)=>month+'-'+String(i+1).padStart(2,'0'));}
function dayState(entries,date){return ['available','unavailable'].includes(entries?.[date]?.status)?entries[date].status:'unknown';}
function draw(){
 const list=dates();$('monthTitle').textContent=new Date(list[0]+'T12:00:00Z').toLocaleDateString('pl-PL',{month:'long',year:'numeric',timeZone:'Europe/Warsaw'});
 $('heading').textContent=team?'Dyspozycyjność zespołu':'Moja dyspozycyjność';
 $('intro').textContent=team?'Deklaracje pracowników i realizatorów. Brak deklaracji nie oznacza dostępności.':'Zaznacz dni, w których możesz pracować. Twoje deklaracje widzi administrator.';
 $('toggle').textContent=team?'Mój kalendarz':'Dyspozycyjność zespołu';$('hint').hidden=team;$('calendar').hidden=team;$('teamTable').hidden=!team;
 if(team){
  $('teamTable').innerHTML=users.length?'<table><caption>'+users.length+' osób · stan deklaracji na wybrany miesiąc</caption><thead><tr><th>Pracownik</th>'+list.map(date=>'<th>'+Number(date.slice(-2))+'<small>'+new Date(date+'T12:00:00Z').toLocaleDateString('pl-PL',{weekday:'short',timeZone:'Europe/Warsaw'})+'</small></th>').join('')+'</tr></thead><tbody>'+users.map(user=>'<tr><th scope="row">'+escapeHtml(user.username)+'</th>'+list.map(date=>{const state=dayState(user.days,date);return '<td class="'+state+'" aria-label="'+escapeHtml(user.username+' '+date+' '+labels[state])+'" title="'+date+' '+labels[state]+'">'+({available:'✓',unavailable:'×',unknown:'—'}[state])+'</td>';}).join('')+'</tr>').join('')+'</tbody></table>':'<p>Brak kont pracowników i realizatorów.</p>';
 }else{
  const offset=(new Date(list[0]+'T12:00:00Z').getUTCDay()+6)%7;
  $('calendar').innerHTML=['Pon','Wt','Śr','Czw','Pt','Sob','Niedz'].map(name=>'<div class="weekday">'+name+'</div>').join('')+Array.from({length:offset},()=>'<div aria-hidden="true"></div>').join('')+list.map(date=>{const state=dayState(days,date);return '<button class="day '+state+(date===today?' today':'')+'" data-date="'+date+'" type="button" aria-label="'+date+' '+labels[state]+'"'+(date===today?' aria-current="date"':'')+'><strong>'+Number(date.slice(-2))+'</strong><span class="day-state-long">'+labels[state]+'</span><span class="day-state-short" aria-hidden="true">'+({available:'✓ Tak',unavailable:'× Nie',unknown:'—'}[state])+'</span></button>';}).join('');
 }
}
async function load(){
 if(busy)return;const month=$('month').value;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)){status('Wybierz miesiąc.',true);return;}
 lock(true);status('Wczytywanie kalendarza…');$('calendar').innerHTML='';$('teamTable').innerHTML='';
 try{const data=await api((team?'/api/admin/availability':'/api/my-availability')+'?month='+encodeURIComponent(month));days=data.days||{};users=data.users||[];draw();status(team?'Deklaracje zespołu są aktualne.':'Kliknij dzień, aby zapisać dyspozycję.');}
 catch(error){status(error.message,true);}finally{lock(false);}
}
$('calendar').addEventListener('click',async event=>{
 const button=event.target.closest('[data-date]');if(!button||busy||team)return;
 const date=button.dataset.date,current=dayState(days,date),next={unknown:'available',available:'unavailable',unavailable:'unknown'}[current];
 lock(true);status('Zapisywanie…');
 try{const data=await api('/api/my-availability',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,status:next})});days=data.days;draw();status('Zapisano '+date+': '+labels[next]);document.querySelector('[data-date="'+date+'"]')?.focus();}
 catch(error){status(error.message,true);}finally{lock(false);document.querySelector('[data-date="'+date+'"]')?.focus();}
});
$('month').addEventListener('change',load);$('refresh').addEventListener('click',load);
for(const [id,delta] of [['previous',-1],['next',1]])$(id).addEventListener('click',()=>{if(busy)return;const [y,m]=$('month').value.split('-').map(Number);const value=new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7);if(value<'2000-01'||value>'2100-12')return;$('month').value=value;load();});
$('toggle').addEventListener('click',()=>{if(busy||!isAdmin)return;team=!team;load();});
(async()=>{try{lock(true);const me=await api('/api/me');isAdmin=me.role==='admin';team=isAdmin;$('adminLink').hidden=!isAdmin;$('toggle').hidden=!isAdmin;lock(false);await load();}catch(error){lock(false);status(error.message,true);}})();
