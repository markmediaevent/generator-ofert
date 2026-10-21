'use strict';
const express=require('express'),fs=require('fs');
const {BillingStore,toFA3,fmt,problem}=require('./core');
const ksef=require('./ksef');
const {createTransport}=require('nodemailer');
function pdfBuffer(inv){
  const PDFDocument=require('pdfkit');
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:46,info:{Title:'Faktura '+inv.number,Author:'MarkNet'}});
    const chunks=[];doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    const font=process.env.BILLING_FONT||'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    const bold=process.env.BILLING_FONT_BOLD||'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const canFont=fs.existsSync(font);
    if(canFont){doc.registerFont('regular',font);doc.registerFont('bold',fs.existsSync(bold)?bold:font);}
    const reg=canFont?'regular':'Helvetica', strong=canFont?'bold':'Helvetica-Bold';
    doc.rect(0,0,595,108).fill('#142b4d');
    doc.fillColor('#fff').font(strong).fontSize(23).text('MARKNET  /  FAKTURA VAT',47,41);
    doc.font(reg).fontSize(10).text(inv.number,47,79);
    doc.fillColor('#142b4d');
    let y=135;
    doc.font(strong).fontSize(10).text('SPRZEDAWCA',46,y);doc.text('NABYWCA',310,y);
    y+=24; doc.font(reg).fontSize(9);
    doc.text(inv.seller.name,46,y,{width:235});doc.text(inv.buyerName,310,y,{width:235});
    y+=23;doc.text(inv.seller.address,46,y,{width:235});doc.text(inv.buyerAddress,310,y,{width:235});
    y+=39;doc.text('NIP: '+inv.seller.nip,46,y);doc.text('NIP: '+inv.buyerNip,310,y);
    y+=38;doc.moveTo(46,y).lineTo(549,y).strokeColor('#dde4ed').stroke();
    y+=15;doc.font(reg).fontSize(9)
      .text('Wystawiono: '+inv.issueDate,46,y).text('Sprzedaż: '+inv.saleDate,216,y).text('Termin: '+inv.dueDate,390,y);
    y+=35;
    doc.font(strong).fontSize(9).text('POZYCJA',46,y).text('NETTO',387,y,{width:75,align:'right'}).text('VAT',470,y,{width:70,align:'right'});
    y+=18;doc.strokeColor('#dde4ed').moveTo(46,y).lineTo(549,y).stroke();y+=11;
    inv.lines.forEach((r,i)=>{
      const label=(i+1)+'. '+r.description+' ('+r.detail+')';
      doc.font(reg).fontSize(8.5);
      const height=doc.heightOfString(label,{width:330})+9;
      if(y+height>737){doc.addPage();y=53;}
      doc.text(label,46,y,{width:330});
      doc.text(fmt(r.net)+' zł',386,y,{width:75,align:'right'});
      doc.text('23%',472,y,{width:67,align:'right'});
      y+=height;
      doc.strokeColor('#edf0f5').moveTo(46,y).lineTo(549,y).stroke();y+=7;
    });
    if(y>636){doc.addPage();y=55;}
    y+=18;doc.font(reg).fontSize(11);
    doc.text('Netto: ',340,y,{width:112,align:'right'});
    doc.font(strong).text(fmt(inv.totals.net)+' zł',451,y,{width:95,align:'right'});
    y+=25;doc.font(reg).text('VAT 23%: ',340,y,{width:112,align:'right'});
    doc.font(strong).text(fmt(inv.totals.vat)+' zł',451,y,{width:95,align:'right'});
    y+=35;doc.roundedRect(327,y,219,57,7).fill('#142b4d');
    doc.fillColor('#fff').font(strong).fontSize(14).text('DO ZAPŁATY',341,y+9);
    doc.fontSize(16).text(fmt(inv.totals.gross)+' PLN',341,y+30);
    y+=83;doc.fillColor('#142b4d').font(reg).fontSize(9).text('Przelew bankowy na rachunek:',46,y);
    y+=18;doc.font(strong).text(inv.seller.bank,46,y);
    if(inv.ksef&&inv.ksef.ksefNumber){
      y+=36;doc.font(reg).text('Numer KSeF: '+inv.ksef.ksefNumber,46,y,{width:500});
    }else{
      y+=35;doc.font(reg).fontSize(8).fillColor('#6a7789').text('Brak potwierdzonego numeru KSeF — ten PDF nie zawiera urzędowego kodu weryfikacyjnego.',46,y,{width:500});
    }
    doc.end();
  });
}
function createBillingRouter({dataDir,offerLoader}){
  const router=express.Router(),store=new BillingStore(dataDir,offerLoader);
  router.use((req,res,next)=>{
    if(process.env.BILLING_ENABLED!=='true'||!process.env.ADMIN_PASS||process.env.ADMIN_PASS==='markmedia123')
      return res.status(503).json({ok:false,message:'Moduł faktur wymaga BILLING_ENABLED=true i silnego ADMIN_PASS w Render.'});
    next();
  });
  function wrap(fn){return async(req,res)=>{try{await fn(req,res)}catch(e){res.status(e.status||500).json({ok:false,message:e.message||'Błąd modułu faktur.'})}}}
  router.get('/list',wrap(async(req,res)=>res.json({ok:true,invoices:store.list().map(i=>({
    id:i.id,number:i.number,offerNumber:i.offerNumber,buyerName:i.buyerName,status:i.status,createdAt:i.createdAt,
    gross:i.totals.gross,ksefState:i.ksef.state,ksefNumber:i.ksef.ksefNumber||null
  }))})));
  router.post('/from-offer/:number',wrap(async(req,res)=>res.json({ok:true,invoice:await store.convert(req.params.number)})));
  router.get('/:id',wrap(async(req,res)=>res.json({ok:true,invoice:store.get(req.params.id)})));
  router.patch('/:id',wrap(async(req,res)=>res.json({ok:true,invoice:store.update(req.params.id,req.body||{})})));
  router.post('/:id/issue',wrap(async(req,res)=>res.json({ok:true,invoice:store.issue(req.params.id)})));
  router.get('/:id/xml',wrap(async(req,res)=>{const i=store.get(req.params.id);res.type('application/xml; charset=utf-8').set('Content-Disposition','attachment; filename="faktura-FA3.xml"').send(toFA3(i))}));
  router.get('/:id/pdf',wrap(async(req,res)=>{const i=store.get(req.params.id);if(i.status==='draft')problem('Wystaw fakturę, aby pobrać PDF.');const p=await pdfBuffer(i);res.type('application/pdf').set('Content-Disposition','attachment; filename="faktura.pdf"').send(p)}));
  router.post('/:id/email',wrap(async(req,res)=>{
    const i=store.get(req.params.id);
    if(i.status==='draft')problem('Faktura nie jest wystawiona.');
    // Nie wysyłamy wizualizacji KSeF bez potwierdzenia przyjęcia.
    if(i.ksef.state!=='accepted')problem('Wyślij e-mail dopiero po potwierdzeniu KSeF.',409);
    const {SMTP_HOST,SMTP_PORT,SMTP_USER,SMTP_PASS,SMTP_FROM}=process.env;
    if(!SMTP_HOST||!SMTP_FROM||!SMTP_USER||!SMTP_PASS)problem('Brak konfiguracji SMTP.',503);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.buyerEmail||''))problem('Niepoprawny e-mail klienta.');
    const pdf=await pdfBuffer(i);
    const t=createTransport({host:SMTP_HOST,port:Number(SMTP_PORT||587),secure:Number(SMTP_PORT||587)===465,auth:{user:SMTP_USER,pass:SMTP_PASS}});
    await t.sendMail({from:SMTP_FROM,to:i.buyerEmail,subject:'Faktura '+i.number+' — MarkNet',
      text:'Dzień dobry,\n\nw załączeniu przesyłam fakturę VAT '+i.number+' na kwotę '+fmt(i.totals.gross)+' PLN, z terminem płatności '+i.dueDate+'.\n\nProszę o terminową płatność.\n\nPozdrawiam,\nMarkNet',
      attachments:[{filename:'Faktura-'+i.number.replace(/\//g,'-')+'.pdf',content:pdf,contentType:'application/pdf'}]});
    i.emailEvents.push({recipient:i.buyerEmail,at:new Date().toISOString()});store.save(i);
    res.json({ok:true,message:'Wysłano PDF na '+i.buyerEmail});
  }));
  router.post('/:id/ksef/send',wrap(async(req,res)=>{
    if(req.body?.confirm!==true)problem('Wymagane jawne potwierdzenie wysyłki.');
    const i=store.get(req.params.id);
    if(i.status!=='issued'||i.ksef.state!=='not_sent')problem('Ten dokument jest już w procesie wysyłki lub nie został wystawiony.',409);
    const xml=toFA3(i);
    i.ksef={state:'sending',startedAt:new Date().toISOString()};store.save(i);
    try{
      const result=await ksef.submitInvoice(xml,i.seller.nip);
      i.ksef={...i.ksef,...result,state:'pending'};store.save(i);
      res.json({ok:true,invoice:i});
    }catch(e){
      // Nie ponawiamy automatycznie, gdy nie wiemy, czy KSeF przyjął dokument.
      i.ksef={...i.ksef,state:'unknown',error:String(e.message).slice(0,600)};store.save(i);
      throw e;
    }
  }));
  router.post('/:id/ksef/status',wrap(async(req,res)=>{
    const i=store.get(req.params.id);
    if(!i.ksef.sessionRef||!i.ksef.invoiceRef)problem('Brak referencji sesji i faktury KSeF.',409);
    const answer=await ksef.checkInvoice(i.seller.nip,i.ksef.sessionRef,i.ksef.invoiceRef);
    i.ksef.lastCheckedAt=new Date().toISOString();
    i.ksef.lastStatus=answer.status||null;
    if(answer.status?.code===200&&answer.ksefNumber){i.ksef.state='accepted';i.ksef.ksefNumber=answer.ksefNumber;}
    else if(answer.status?.code>=400)i.ksef.state='rejected';
    store.save(i);
    res.json({ok:true,invoice:i});
  }));
  router.get('/:id/ksef/upo',wrap(async(req,res)=>{
    const i=store.get(req.params.id);
    if(i.ksef.state!=='accepted')problem('UPO jeszcze niedostępne.',409);
    const xml=await ksef.getUpo(i.seller.nip,i.ksef.sessionRef,i.ksef.invoiceRef);
    res.type('application/xml').set('Content-Disposition','attachment; filename="UPO.xml"').send(xml);
  }));
  return router;
}
module.exports={createBillingRouter};
