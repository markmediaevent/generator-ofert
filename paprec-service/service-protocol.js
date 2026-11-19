'use strict';

const path=require('path');
const fs=require('fs');
const sharp=require('sharp');
const PDFDocument=require('pdfkit');

const PAGE_W=595.28, PAGE_H=841.89, LEFT=50, RIGHT=545;
const BLUE='#078fc5', YELLOW='#ffd500', INK='#171d22', GREY='#747b82', LINE='#757d83';
const FONT_REGULAR='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const logoPath=path.join(__dirname,'public','logo-marknet-hd.png');

function plDate(input){
 if(!input)return '—';
 const str=String(input);
 if(/^\d{4}-\d{2}-\d{2}$/.test(str))return str.slice(8,10)+'.'+str.slice(5,7)+'.'+str.slice(0,4);
 const d=new Date(input);
 return Number.isFinite(d.valueOf())?new Intl.DateTimeFormat('pl-PL',{dateStyle:'short',timeZone:'Europe/Warsaw'}).format(d):'—';
}
function tnum(ticket){return 'MN-'+new Date(ticket.created_at).getUTCFullYear()+'-'+String(ticket.id).padStart(5,'0');}
function verdict(value,type){
 if(value==='tak')return type==='working'?'prawidłowość':'nadaje się do eksploatacji';
 if(value==='nie')return type==='working'?'nieprawidłowość':'nie nadaje się do eksploatacji';
 return 'nie oceniono';
}
function value(v){return String(v==null||String(v).trim()===''?'—':v);}
function title(doc,text,x,y,w,size=9){
 doc.font('Bold').fontSize(size).fillColor(INK).text(value(text),x,y,{width:w,breakLine:false});
}
function fieldValue(doc,text,x,y,w,size=10,align='left'){
 doc.font('Regular').fontSize(size).fillColor(INK).text(value(text),x,y,{width:w,align,breakLine:false,ellipsis:true});
}
function gridRow(doc,top,height,label,val,width=500){
 doc.lineWidth(.65).strokeColor(LINE).rect(LEFT,top,width,height).stroke();
 doc.moveTo(LEFT+111,top).lineTo(LEFT+111,top+height).stroke();
 doc.font('Regular').fontSize(9.1).fillColor(INK).text(label,LEFT+7,top+(height-13)/2,{width:100});
 fieldValue(doc,val,LEFT+119,top+(height-13)/2,width-132,9.6);
}
function newContinuation(doc,ticket){
 doc.addPage();doc.font('Bold').fontSize(10).fillColor(BLUE).text('MARKNET  |  PROTOKÓŁ SERWISOWY  '+tnum(ticket),LEFT,34,{width:490});
 doc.moveTo(LEFT,55).lineTo(RIGHT,55).lineWidth(1.2).strokeColor(YELLOW).stroke();
 doc.y=76;
}
async function renderProtocol(ticket,record,config={}){
 const doc=new PDFDocument({size:'A4',margin:50,bufferPages:true,autoFirstPage:true,
  info:{Title:'Protokół z wykonanych prac serwisowych '+tnum(ticket),Author:'Marek Wyganowski MarkNet',Subject:'Potwierdzenie wykonanych prac serwisowych'}});
 doc.registerFont('Regular',fs.existsSync(FONT_REGULAR)?FONT_REGULAR:'Helvetica');
 doc.registerFont('Bold',fs.existsSync(FONT_BOLD)?FONT_BOLD:'Helvetica-Bold');
 const chunks=[];
 let footerLogo=null;
 let signatureImage=null;
 const promise=new Promise((resolve,reject)=>{
   doc.on('data',chunk=>chunks.push(chunk));
   doc.on('end',()=>resolve(Buffer.concat(chunks)));
   doc.on('error',reject);
 });
 const companyName=config.name||'Marek Wyganowski MarkNet';
 const address=config.address||'';
 const email=config.email||'marknet.biuro@gmail.com';
 const phone=config.phone||'';
 // The original owner's scan is supplied privately through the Render environment.
 // Never serve the image as a public asset or check it into version control.
 if(process.env.PROTOCOL_SIGNATURE_BASE64){
  try{
   const raw=Buffer.from(process.env.PROTOCOL_SIGNATURE_BASE64,'base64');
   if(raw.length>0&&raw.length<1024*1024)signatureImage=await sharp(raw).ensureAlpha().png().toBuffer();
  }catch(e){console.error('Protocol stamp could not be loaded:',e.message);}
 }
 // Exact user-supplied MarkNet logo. PDFKit needs PNG/JPEG, so decode the existing WebP.
 try{
  if(fs.existsSync(logoPath)){
   const jpeg=await sharp(logoPath).flatten({background:'#ffffff'}).jpeg({quality:92}).toBuffer();
   footerLogo=jpeg;
   doc.image(jpeg,LEFT,28,{fit:[157,76]});
  }else{
   title(doc,'MARKNET',LEFT,43,165,21);
  }
 }catch(e){
  title(doc,'MARKNET',LEFT,43,165,21);
 }
 title(doc,companyName,222,36,187,10);
 if(address)fieldValue(doc,address,222,55,186,8.1);
 title(doc,'MarkNet — Systemy Zabezpieczeń',222,address?82:65,190,7.7);
 if(phone)fieldValue(doc,'Tel.: '+phone,416,38,130,8.3,'right');
 fieldValue(doc,email,412,phone?57:39,134,8.1,'right');
 fieldValue(doc,'www.marknet.com.pl',412,phone?73:55,134,8.1,'right');
 doc.lineWidth(1.6).strokeColor(YELLOW).moveTo(LEFT,117).lineTo(RIGHT,117).stroke();
 doc.font('Bold').fontSize(14).fillColor(INK).text('PROTOKÓŁ',LEFT,135,{width:495,align:'center'});
 doc.font('Bold').fontSize(12.6).text('Z WYKONANYCH PRAC SERWISOWYCH',LEFT,157,{width:495,align:'center'});
 doc.font('Regular').fontSize(8.2).fillColor(GREY).text('Numer zgłoszenia: '+tnum(ticket),LEFT,188,{width:495,align:'center'});
 const y=222;
 // Opening two-column table, keeping the Miwipol example's formal alignment.
 doc.lineWidth(.65).strokeColor(LINE).rect(LEFT,y,495,58).stroke();
 doc.moveTo(LEFT+247.5,y).lineTo(LEFT+247.5,y+58).stroke();
 doc.moveTo(LEFT,y+23).lineTo(RIGHT,y+23).stroke();
 doc.font('Regular').fontSize(9).fillColor(INK)
   .text('Data wykonania prac serwisowych:',LEFT+8,y+6,{width:230})
   .text('Wykonawca:',LEFT+256,y+6,{width:200});
 doc.font('Bold').fontSize(10).fillColor(INK)
   .text(plDate(record.work_date),LEFT+8,y+34,{width:230,align:'center'})
   .text(companyName,LEFT+253,y+33,{width:240,align:'center'});
 let row=y+58;
 const object=[ticket.organization_name, ticket.area].filter(Boolean).join(' / ')||ticket.area||ticket.organization_name||'—';
 gridRow(doc,row,37,'Obiekt:',object,495);row+=37;
 gridRow(doc,row,37,'System:',ticket.category,495);row+=37;
 gridRow(doc,row,36,'Serwisanci:',record.technicians,495);row+=36;
 const hours=Number(record.hours);
 gridRow(doc,row,35,'Ilość godzin:',Number.isFinite(hours)?hours.toLocaleString('pl-PL',{maximumFractionDigits:2}):'—',495);row+=35;
 gridRow(doc,row,35,'Data:',plDate(record.work_date),495);row+=35;
 doc.font('Regular').fontSize(10).fillColor(INK).text('1.  Wykaz wykonanych prac:',LEFT+6,row+25,{width:483});
 const bodyY=row+51;
 doc.y=bodyY;
 const workText=value(record.work_done);
 const lines=[];
 doc.font('Regular').fontSize(9.5);
 for(const paragraph of workText.replace(/\r/g,'').split('\n')){
  if(!paragraph.trim()){lines.push('');continue;}
  let row='';
  for(const word of paragraph.trim().split(/\s+/)){
   if(!row){row=word;continue;}
   if(doc.widthOfString(row+' '+word)<=462)row+=' '+word;
   else{lines.push(row);row=word;}
  }
  if(row)lines.push(row);
 }
 let bodyLineY=bodyY;
 for(const line of lines){
  const firstPage=doc.bufferedPageRange().count===1;
  if(bodyLineY+15>(firstPage?623:724)){
   newContinuation(doc,ticket);
   bodyLineY=85;
  }
  doc.font('Regular').fontSize(9.5).fillColor(INK).text(line||' ',LEFT+24,bodyLineY,
    {width:462,lineGap:0,breakLine:false});
  bodyLineY+=14.7;
 }
 doc.y=bodyLineY;
 // Zarezerwuj cały blok oceny, pieczątki, podpisów i podpisów pod liniami.
 // Bez tego PDFKit automatycznie przenosi ostatnią etykietę na pustą drugą stronę.
 const signatureMinimum=167;
 let assessY=Math.max(doc.y+17,565);
 if(assessY+signatureMinimum>PAGE_H-62){
  newContinuation(doc,ticket);
  assessY=130;
 }
 doc.font('Bold').fontSize(9.2).fillColor(INK).text(
   'Na podstawie wykonanych prac serwisowych stwierdza się: '+verdict(record.system_operational,'working')+' działania zainstalowanego systemu.',
   LEFT+5,assessY,{width:485,lineGap:2});
 const fitY=doc.y+9;
 doc.font('Bold').fontSize(9.6).text('System '+verdict(record.fit_for_use,'use')+'.',LEFT+5,fitY,{width:485});
 const sigY=doc.y+15;
 doc.font('Regular').fontSize(9.2).text('Prace serwisowe wykonał:',LEFT+5,sigY,{width:230});
 doc.text('Potwierdzenie wykonanych prac:',321,sigY,{width:220});
 const lineY=sigY+99;
 if(signatureImage)doc.image(signatureImage,LEFT+20,sigY+5,{fit:[165,94]});
 doc.lineWidth(.6).strokeColor(GREY).moveTo(LEFT+10,lineY).lineTo(LEFT+228,lineY).stroke();
 doc.moveTo(325,lineY).lineTo(RIGHT-9,lineY).stroke();
 doc.font('Regular').fontSize(8.2).fillColor(GREY).text('(podpis przedstawiciela wykonawcy)',LEFT+11,lineY+6,{width:215,align:'center',lineBreak:false});
 doc.text('(podpis przedstawiciela użytkownika)',326,lineY+6,{width:209,align:'center',lineBreak:false});
 // Cała stopka, w tym numer strony, musi pozostać wewnątrz wysokości A4.
 const footerBottom=PAGE_H-34;
 const {start,count}=doc.bufferedPageRange();
 for(let i=start;i<start+count;i++){
  doc.switchToPage(i);
  const prevBottom=doc.page.margins.bottom;doc.page.margins.bottom=0;
  doc.lineWidth(1.3).strokeColor(YELLOW).moveTo(LEFT,footerBottom-19).lineTo(RIGHT,footerBottom-19).stroke();
  doc.font('Bold').fontSize(9.2).fillColor(INK).text(companyName,LEFT,footerBottom-9,{width:290});
  doc.font('Regular').fontSize(7.7).fillColor(GREY).text('www.marknet.com.pl',LEFT,footerBottom+4,{width:220});
  if(footerLogo)doc.image(footerLogo,RIGHT-122,footerBottom-8,{fit:[90,29]});
  doc.font('Regular').fontSize(7.9).fillColor(INK).text('Strona '+(i-start+1)+' z '+count,RIGHT-95,footerBottom+6,{width:95,align:'right',lineBreak:false});
  doc.page.margins.bottom=prevBottom;
 }
 doc.end();return promise;
}
module.exports={renderProtocol};
