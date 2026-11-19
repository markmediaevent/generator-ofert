'use strict';
const nodemailer=require('nodemailer');
const PDFDocument=require('pdfkit');
const fs=require('fs');

const fmt=v=>new Intl.DateTimeFormat('pl-PL',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Warsaw'}).format(new Date(v));
const no=t=>'MN-'+new Date(t.created_at).getUTCFullYear()+'-'+String(t.id).padStart(5,'0');
function font(doc){const files=['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];const f=files.find(fs.existsSync);if(f)doc.font(f);}
async function confirmation(t) {
 const doc=new PDFDocument({size:'A4',margin:46,info:{Title:'Potwierdzenie zgłoszenia serwisowego '+no(t)}});
 const chunks=[];doc.on('data',b=>chunks.push(b));
 const promise=new Promise((resolve,reject)=>{doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));});
 font(doc);doc.rect(0,0,595,8).fill('#ffd600');
 doc.fillColor('#009bd6').fontSize(26).text('MARK',46,31,{continued:true});doc.fillColor('#d9b300').text('NET');
 doc.fillColor('#456a80').fontSize(9).text('SYSTEMY ZABEZPIECZEŃ  |  POTWIERDZENIE ZGŁOSZENIA',46,78);
 doc.moveTo(46,104).lineTo(550,104).strokeColor('#d0e4ed').stroke();
 doc.y=124;doc.fillColor('#194762').fontSize(17).text('Zgłoszenie serwisowe '+no(t));doc.moveDown(.8);
 function field(label,value){
  if(doc.y>695)doc.addPage();
  doc.fillColor('#68869a').fontSize(9).text(label);doc.moveDown(.2);
  doc.fillColor('#183e56').fontSize(11).text(String(value??'—'),{width:495});doc.moveDown(.55);
 }
 field('Numer zgłoszenia',no(t));
 field('Klient',t.organization_name||'—');
 field('Data zgłoszenia',fmt(t.created_at));
 field('Osoba zgłaszająca',t.requester_name);
 field('Adres e-mail',t.requester_email);
 field('Rodzaj i priorytet',t.kind+' / '+t.priority);
 field('System',t.category);field('Temat',t.title);
 field('Lokalizacja',t.area||'Nie podano');field('Urządzenie',t.device||'Nie podano');
 field('Opis',t.description);
 doc.moveDown(.5);doc.fillColor('#607c90').fontSize(8).text('Dokument potwierdza przyjęcie zgłoszenia do rejestru, a nie rozpoczęcie ani zakończenie naprawy. Awarie krytyczne zgłaszaj również telefonicznie: numer telefonu wskazany w uzgodnionych procedurach serwisowych.',{width:490});
 doc.end();return promise;
}
const fakeMail=process.env.NODE_ENV==='test'&&process.env.MARKNET_TEST_SMTP==='1';
function smtpReady(){return fakeMail||Boolean(process.env.SMTP_HOST&&process.env.SMTP_USERNAME&&process.env.SMTP_PASSWORD&&process.env.SMTP_FROM);}
function phoneReady(){return Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID);}
let transporter;
function mailer(){
 if(!smtpReady())throw new Error('Brak ustawień SMTP');
 return transporter??=(fakeMail?nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'}):nodemailer.createTransport({
   host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),
   secure:Number(process.env.SMTP_PORT||465)===465,
   auth:{user:process.env.SMTP_USERNAME,pass:process.env.SMTP_PASSWORD},
   tls:{minVersion:'TLSv1.2'},
   connectionTimeout:10000,greetingTimeout:10000,socketTimeout:18000
 }));
}
function escapeHtml(value){
 return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function emailConfirmation(t) {
 if(!t.requester_email)throw new Error('Brak adresu e-mail zgłaszającego');
 const pdf=await confirmation(t);
 const number=no(t);
 const company=t.organization_name||'';
 const body=[
  'Potwierdzamy zarejestrowanie zgłoszenia serwisowego w MarkNet.',
  '',
  'Numer zgłoszenia: '+number,
  'Klient: '+company,
  'Zgłaszający: '+(t.requester_name||'—'),
  'Data: '+fmt(t.created_at),
  'Rodzaj: '+t.kind+' / '+t.priority,
  'System: '+t.category,
  'Temat: '+t.title,
  'Lokalizacja: '+(t.area||'Nie podano'),
  '',
  'Opis zgłoszenia:',
  t.description,
  '',
  'W załączniku znajduje się podgląd zgłoszenia w formacie PDF.',
  'Możesz też śledzić status pod adresem https://marknet.com.pl/serwis/',
  '',
  'To potwierdzenie rejestracji, nie potwierdzenie rozpoczęcia naprawy.',
  'W sytuacji krytycznej skontaktuj się także z serwisem zgodnie z uzgodnioną procedurą.'
 ].join('\n');
 const cells=[
  ['Numer zgłoszenia',number],
  ['Klient',company||'—'],
  ['Zgłaszający',t.requester_name||'—'],
  ['Data',fmt(t.created_at)],
  ['Rodzaj / priorytet',t.kind+' / '+t.priority],
  ['System',t.category],
  ['Temat',t.title],
  ['Lokalizacja',t.area||'Nie podano']
 ];
 const rows=cells.map(([label,value])=>'<tr><td style="padding:8px 12px;color:#617e91;border-bottom:1px solid #deedf4;font-size:13px">'+escapeHtml(label)+'</td><td style="padding:8px 12px;border-bottom:1px solid #deedf4;font-weight:600;font-size:13px">'+escapeHtml(value)+'</td></tr>').join('');
 const html=
  '<!doctype html><html lang="pl"><head><meta charset="utf-8"></head>'+
  '<body style="margin:0;background:#f5f9fc;font-family:Arial,sans-serif;color:#173b54">'+
  '<div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #d6e7ef;border-radius:14px;overflow:hidden">'+
  '<div style="padding:22px 26px;border-top:6px solid #ffda00"><strong style="font-size:25px;color:#009bd6">MARK</strong><strong style="font-size:25px;color:#e1b800">NET</strong><span style="color:#5a7589;font-size:12px;margin-left:10px">SERWIS</span></div>'+
  '<div style="padding:0 26px 26px"><h2 style="color:#14445f;margin:6px 0 12px">Potwierdzenie przyjęcia zgłoszenia</h2>'+
  '<p>Twoje zgłoszenie zostało zapisane w systemie MarkNet. Poniżej znajduje się jego podgląd.</p>'+
  '<table style="width:100%;border-collapse:collapse">'+rows+'</table>'+
  '<p style="margin-top:20px;font-weight:600">Opis zgłoszenia</p>'+
  '<div style="white-space:pre-wrap;background:#eef8fe;border-radius:8px;padding:14px;font-size:14px">'+escapeHtml(t.description)+'</div>'+
  '<p style="margin-top:20px">Pełne potwierdzenie znajdziesz w załączonym pliku <strong>PDF</strong>.</p>'+
  '<p><a href="https://marknet.com.pl/serwis/" style="display:inline-block;background:#ffda00;color:#143850;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:8px">Otwórz panel zgłoszeń</a></p>'+
  '<p style="color:#6e8798;font-size:12px;margin-top:28px">Wiadomość automatyczna. Rejestracja zgłoszenia nie oznacza rozpoczęcia naprawy. Zgłoszenia krytyczne wymagają również kontaktu zgodnego z uzgodnioną procedurą.</p></div></div></body></html>';
 const info=await mailer().sendMail({
  from:process.env.SMTP_FROM,to:t.requester_email,
  subject:'MarkNet Serwis — potwierdzenie zgłoszenia '+number,
  text:body,html,
  attachments:[{filename:'Zgloszenie-MarkNet-'+number+'.pdf',content:pdf,contentType:'application/pdf'}]
 });
 return info.messageId||'ok';
}
async function adminEmail(t){
 if(!process.env.ADMIN_NOTIFY_EMAIL)throw new Error('Brak ADMIN_NOTIFY_EMAIL');
 const info=await mailer().sendMail({
  from:process.env.SMTP_FROM,to:process.env.ADMIN_NOTIFY_EMAIL,
  subject:(t.priority==='Krytyczny'?'PILNE — ':'')+'Nowe zgłoszenie '+no(t),
  text:'Nowe zgłoszenie w MarkNet Serwis\n\n'+no(t)+'\n'+t.kind+' / '+t.priority+'\n'+t.title+'\n'+t.category+'\n'+t.area+'\nOsoba: '+t.requester_name+'\nE-mail: '+t.requester_email+'\n\nhttps://marknet.com.pl/serwis/'
 });
 return info.messageId||'ok';
}
async function mobileAlert(t){
 if(!phoneReady())throw new Error('Brak konfiguracji Telegram');
 const title=t.priority==='Krytyczny'?'🚨 PILNA AWARIA':'🔔 Nowe zgłoszenie';
 const message=title+'\n'+no(t)+'\n'+t.title+'\n'+t.category+'\n'+(t.requester_name||'PAPREC')+'\n'+fmt(t.created_at)+'\nhttps://marknet.com.pl/serwis/';
 const res=await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true}),signal:AbortSignal.timeout(12000)
 });
 const data=await res.json().catch(()=>({}));
 if(!res.ok||!data.ok)throw new Error('Telegram '+res.status+': '+String(data.description||'Błąd').slice(0,100));
 return String(data.result?.message_id||'ok');
}
async function welcomeUser({email,username,first_name,last_name,organization_name,activation_url,expiresHours}) {
 if(!smtpReady())throw new Error('Brak SMTP dla zaproszenia użytkownika');
 if(!/^https:\/\/marknet\.com\.pl\/serwis\/\?aktywacja=[a-f0-9]{64}$/.test(activation_url))
   throw new Error('Niepoprawny adres zaproszenia');
 const fullName=[first_name,last_name].filter(Boolean).join(' ').trim()||username;
 const safe=escapeHtml;
 const subject='MarkNet — dostęp do panelu serwisowego ('+organization_name+')';
 const message=[
  'Dzień dobry, '+fullName+',',
  '',
  'Utworzono dla Ciebie konto w systemie zgłoszeń serwisowych MarkNet.',
  'Firma: '+organization_name,
  'Twój login: '+username,
  '',
  'Najpierw poznaj stronę MarkNet: https://marknet.com.pl/',
  'Wejście do panelu znajduje się w górnym menu strony głównej pod nazwą „Panel serwisowy”.',
  'Na telefonie otwórz przycisk „Menu”, a następnie wybierz „Panel serwisowy”.',
  'Bezpośredni adres logowania: https://marknet.com.pl/serwis/',
  '',
  'Ustaw swoje prywatne hasło, otwierając ten jednorazowy link:',
  activation_url,
  '',
  'Link jest ważny przez '+expiresHours+' godziny. Po ustawieniu hasła zaloguj się podanym wyżej loginem.',
  'Hasła nie wysyłamy e-mailem ze względów bezpieczeństwa.',
  'Jeżeli nie spodziewasz się tej wiadomości, skontaktuj się z MarkNet.',
  '',
  'MarkNet — Systemy Zabezpieczeń',
  'https://marknet.com.pl/'
 ].join('\n');
 const html='<!doctype html><html lang="pl"><head><meta charset="utf-8"></head>'+
  '<body style="font-family:Arial,sans-serif;margin:0;background:#f3f8fb;color:#183e57">'+
  '<div style="max-width:640px;margin:22px auto;background:#fff;border:1px solid #d9e8f1;border-radius:16px;overflow:hidden">'+
  '<div style="border-top:6px solid #ffdb00;padding:23px 27px"><strong style="color:#008fd0;font-size:26px">MARK</strong><strong style="color:#f5c300;font-size:26px">NET</strong><div style="font-size:12px;color:#58758a">SYSTEMY ZABEZPIECZEŃ</div></div>'+
  '<div style="padding:0 27px 27px"><h1 style="font-size:23px;color:#143d58">Witamy w panelu serwisowym</h1>'+
  '<p>Dzień dobry, <strong>'+safe(fullName)+'</strong>!</p>'+
  '<p>Utworzono dla Ciebie konto w systemie zgłoszeń serwisowych <strong>MarkNet</strong>.</p>'+
  '<p><strong>Firma:</strong> '+safe(organization_name)+'<br><strong>Login:</strong> '+safe(username)+'</p>'+
  '<div style="background:#f0f8fd;border-radius:12px;padding:16px 18px;margin:19px 0">'+
  '<p style="margin-top:0"><strong>Najpierw poznaj MarkNet:</strong> <a href="https://marknet.com.pl/" style="color:#087cad">marknet.com.pl</a></p>'+
  '<p>Na stronie głównej w górnym menu kliknij <strong>„Panel serwisowy”</strong>. Na telefonie otwórz <strong>„Menu” → „Panel serwisowy”</strong>.</p>'+
  '<p style="margin-bottom:0">Bezpośredni adres: <a href="https://marknet.com.pl/serwis/" style="color:#087cad">marknet.com.pl/serwis/</a></p></div>'+
  '<p>Przed pierwszym logowaniem ustaw własne hasło przyciskiem poniżej:</p>'+
  '<p><a href="'+safe(activation_url)+'" style="display:inline-block;background:#ffdb00;color:#183b54;font-size:15px;font-weight:bold;padding:15px 22px;text-decoration:none;border-radius:10px">Ustaw hasło i aktywuj dostęp</a></p>'+
  '<p style="font-size:13px;color:#628094">Link jest ważny przez '+expiresHours+' godziny. Hasło wybierasz samodzielnie i nie jest przesyłane e-mailem.</p>'+
  '<p style="margin-top:28px;color:#839ba7;font-size:12px">Automatyczna wiadomość MarkNet. Jeżeli nie zlecano utworzenia konta, skontaktuj się z administratorem serwisu.</p>'+
  '</div></div></body></html>';
 const info=await mailer().sendMail({from:process.env.SMTP_FROM,to:email,subject,text:message,html});
 if(fakeMail&&process.env.MARKNET_TEST_INVITE_CAPTURE){
  await fs.promises.writeFile(process.env.MARKNET_TEST_INVITE_CAPTURE,JSON.stringify({to:email,subject,activation_url})+'\n',{flag:'a',mode:0o600});
 }
 return info.messageId||'ok';
}
async function testEmail(){
 if(!process.env.ADMIN_NOTIFY_EMAIL)throw new Error('Brak adresu administratora');
 const r=await mailer().sendMail({from:process.env.SMTP_FROM,to:process.env.ADMIN_NOTIFY_EMAIL,subject:'MarkNet Serwis - test powiadomień',text:'Połączenie SMTP działa poprawnie. Powiadomienia o zgłoszeniach mogą być wysyłane.'});
 return r.messageId||'ok';
}
module.exports={confirmation,emailConfirmation,adminEmail,mobileAlert,smtpReady,phoneReady,testEmail,welcomeUser};