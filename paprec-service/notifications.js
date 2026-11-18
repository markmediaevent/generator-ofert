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
function smtpReady(){return Boolean(process.env.SMTP_HOST&&process.env.SMTP_USERNAME&&process.env.SMTP_PASSWORD&&process.env.SMTP_FROM);}
function phoneReady(){return Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID);}
let transporter;
function mailer(){
 if(!smtpReady())throw new Error('Brak ustawień SMTP');
 return transporter??=nodemailer.createTransport({
   host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),
   secure:Number(process.env.SMTP_PORT||465)===465,
   auth:{user:process.env.SMTP_USERNAME,pass:process.env.SMTP_PASSWORD},
   tls:{minVersion:'TLSv1.2'},
   connectionTimeout:10000,greetingTimeout:10000,socketTimeout:18000
 });
}
async function emailConfirmation(t) {
 if(!t.requester_email)throw new Error('Brak adresu e-mail zgłaszającego');
 const pdf=await confirmation(t);
 const body='Potwierdzamy rejestrację zgłoszenia serwisowego '+no(t)+'.\n\nTemat: '+t.title+'\nSystem: '+t.category+'\nPriorytet: '+t.priority+'\nData: '+fmt(t.created_at)+'\n\nW załączniku znajduje się potwierdzenie PDF.\n\nW przypadku awarii krytycznej skontaktuj się również telefonicznie z serwisem MarkNet: numer telefonu wskazany w uzgodnionych procedurach serwisowych.\n\nPanel zgłoszeń: https://marknet.com.pl/serwis/';
 const info=await mailer().sendMail({
  from:process.env.SMTP_FROM,to:t.requester_email,subject:'MarkNet — potwierdzenie '+no(t),
  text:body,attachments:[{filename:'MarkNet-'+no(t)+'.pdf',content:pdf,contentType:'application/pdf'}]
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
async function testEmail(){
 if(!process.env.ADMIN_NOTIFY_EMAIL)throw new Error('Brak adresu administratora');
 const r=await mailer().sendMail({from:process.env.SMTP_FROM,to:process.env.ADMIN_NOTIFY_EMAIL,subject:'MarkNet Serwis - test powiadomień',text:'Połączenie SMTP działa poprawnie. Powiadomienia o zgłoszeniach mogą być wysyłane.'});
 return r.messageId||'ok';
}
module.exports={confirmation,emailConfirmation,adminEmail,mobileAlert,smtpReady,phoneReady,testEmail};