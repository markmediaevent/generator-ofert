'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path'),fs=require('node:fs');
const {BillingStore,toFA3,lineItems,nipOk}=require('../billing/core');
test('NIP checksum',()=>{assert.equal(nipOk('1111111111'),true);assert.equal(nipOk('1111111112'),false)});
test('Rabat i naliczenie 23% VAT odpowiadają kalkulatorowi ofert',()=>{
  const rows=lineItems({discountPercent:10,items:[{name:'Usługa',qty:2,days:3,price:100}]});
  assert.equal(rows[0].net,54000);assert.equal(rows[0].vat,12420);
});
test('Zaakceptowana oferta → jeden szkic → wystawienie → FA(3)',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marknet-billing-'));
  process.env.BILLING_SELLER_NIP='1111111111';
  process.env.BILLING_SELLER_NAME='Firma testowa';
  process.env.BILLING_SELLER_ADDRESS='Ulica testowa 1';
  process.env.BILLING_BANK_ACCOUNT='12 1234 1234 1234 1234 1234 1234';
  const offers={'OF-TEST-1':{offerStatus:'Zaakceptowana',offerNumber:'OF-TEST-1',clientName:'Test & Spółka',clientNip:'2222222222',clientAddress:'Adres 1',clientEmail:'test@example.invalid',eventName:'Konferencja',items:[{name:'Multimedia',qty:1,days:1,price:3600}]}};
  const store=new BillingStore(dir,async no=>offers[no]);
  try{
    const a=await store.convert('OF-TEST-1');
    const b=await store.convert('OF-TEST-1');
    assert.equal(a.id,b.id);assert.equal(a.status,'draft');
    const issued=store.issue(a.id);
    assert.match(issued.number,/^MM\/FV\/\d{4}\/\d{2}\/0001$/);
    assert.equal(issued.totals.net,360000);assert.equal(issued.totals.vat,82800);
    assert.throws(()=>store.update(a.id,{buyerName:'zły'}),/korektę/);
    const xml=toFA3(issued);
    assert.match(xml,/<P_13_1>3600.00<\/P_13_1>/);
    assert.match(xml,/<P_15>4428.00<\/P_15>/);
    assert.match(xml,/Test &amp; Spółka/);
    assert.equal(toFA3(issued),xml,'Wysłany XML musi być deterministyczny dla QR/hash');
    assert.equal(store.setPaid(a.id,true).paymentStatus,'paid');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('Nie można fakturować oferty bez akceptacji',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marknet-billing-'));
  try{
    const s=new BillingStore(dir,async()=>({offerStatus:'Wysłana',items:[{name:'Usługa',qty:1,days:1,price:1}]}));
    await assert.rejects(s.convert('OF-2'),/Zaakceptowana/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('Faktura ręczna, kontrola kwoty i płatność',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marknet-billing-'));
  try{
    const store=new BillingStore(dir,async()=>null);
    const draft=store.manual({description:'Obsługa eventu',net:1000});
    assert.equal(draft.status,'draft');
    assert.equal(draft.totals.net,100000);
    assert.equal(draft.totals.vat,23000);
    assert.equal(draft.offerNumber,null);
    assert.throws(()=>store.manual({description:'Błędna faktura',net:-5}),/poprawną kwotę/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
