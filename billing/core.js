'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const fmt = n => (n / 100).toFixed(2);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function problem(msg, code=400) { const e = new Error(msg); e.status=code; throw e; }
function nipOk(value) {
  const s=String(value||'').replace(/[\s-]/g,'');
  if(!/^\d{10}$/.test(s)) return false;
  const d=[...s].map(Number), w=[6,5,7,2,3,4,5,6,7];
  return d.slice(0,9).reduce((a,n,i)=>a+n*w[i],0)%11===d[9];
}
function lineItems(offer) {
  if(!Array.isArray(offer.items)||!offer.items.length) problem('Oferta nie ma pozycji.');
  if(offer.items.length>150) problem('Za dużo pozycji w ofercie.');
  const discount=Number(offer.discountPercent||0);
  if(!Number.isFinite(discount)||discount<0||discount>=100) problem('Nieprawidłowy rabat.');
  const lines=offer.items.map((r,i)=>{
    const q=Number(r.qty),d=Number(r.days),p=Number(r.price);
    if(![q,d,p].every(Number.isFinite)||q<=0||d<=0||p<0) problem('Nieprawidłowe wartości pozycji '+(i+1));
    const name=String(r.name||'').trim();
    if(!name) problem('Pozycja bez nazwy.');
    const base=Math.round(q*d*p*100);
    return {description:(name+(r.desc?' — '+r.desc:'')).slice(0,400),detail:String(q)+' × '+String(d)+' dni',base,net:Math.round(base*(1-discount/100)),vat:0};
  });
  const net=Math.round(lines.reduce((s,r)=>s+r.base,0)*(1-discount/100));
  lines[lines.length-1].net += net-lines.reduce((s,r)=>s+r.net,0);
  lines.forEach(r=>r.vat=Math.round(r.net*0.23));
  lines[lines.length-1].vat+=Math.round(net*0.23)-lines.reduce((s,r)=>s+r.vat,0);
  return lines.map(({base,...r})=>r);
}
function totals(lines){const net=lines.reduce((s,r)=>s+r.net,0),vat=lines.reduce((s,r)=>s+r.vat,0);return {net,vat,gross:net+vat};}
const iso = () => new Date().toISOString().slice(0,10);
const afterDays = (s,n) => {const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
class BillingStore {
  constructor(root,readOffer){this.root=path.join(root,'billing');this.readOffer=readOffer;fs.mkdirSync(this.root,{recursive:true,mode:0o700});}
  file(id){if(!/^[0-9a-f-]{36}$/i.test(String(id)))problem('Błędne ID.',400);return path.join(this.root,id+'.json')}
  list(){return fs.readdirSync(this.root).filter(f=>/^[a-f0-9-]{36}\.json$/i.test(f)).map(f=>{try{return JSON.parse(fs.readFileSync(path.join(this.root,f),'utf8'))}catch{return null}}).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
  get(id){const f=this.file(id);if(!fs.existsSync(f))problem('Faktura nie istnieje.',404);return JSON.parse(fs.readFileSync(f,'utf8'))}
  save(v){v.updatedAt=new Date().toISOString();const f=this.file(v.id),tmp=f+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2),{encoding:'utf8',mode:0o600});fs.renameSync(tmp,f);return v}
  async convert(number){
    number=String(number||'').trim();if(!number||number.length>150)problem('Numer oferty jest niepoprawny.');
    const old=this.list().find(v=>v.offerNumber===number);if(old)return old;
    const offer=await this.readOffer(number);if(!offer)problem('Brak zapisanej oferty.',404);
    if(offer.offerStatus!=='Zaakceptowana')problem('Oferta musi mieć status Zaakceptowana.');
    const lines=lineItems(offer), date=iso();
    return this.save({
      id:crypto.randomUUID(),status:'draft',number:null,offerNumber:number,createdAt:new Date().toISOString(),
      issueDate:date,saleDate:offer.eventDate||date,dueDate:afterDays(date,7),
      buyerName:String(offer.clientName||''),buyerNip:String(offer.clientNip||''),buyerAddress:String(offer.clientAddress||''),buyerEmail:String(offer.clientEmail||''),
      title:String(offer.eventName||'Obsługa wydarzenia'),
      seller:{name:process.env.BILLING_SELLER_NAME||'Marek Wyganowski MarkNet',nip:process.env.BILLING_SELLER_NIP||'',address:process.env.BILLING_SELLER_ADDRESS||'',bank:process.env.BILLING_BANK_ACCOUNT||''},
      lines,totals:totals(lines),emailEvents:[],ksef:{state:'not_sent'}
    });
  }
  update(id,data){
    const inv=this.get(id);if(inv.status!=='draft')problem('Po wystawieniu fakturę można zmienić wyłącznie przez korektę.',409);
    for(const key of ['buyerName','buyerNip','buyerAddress','buyerEmail','title','issueDate','saleDate','dueDate'])if(Object.prototype.hasOwnProperty.call(data,key)){
      if(typeof data[key]!=='string'||data[key].length>500)problem('Błędne pole '+key);
      inv[key]=data[key].trim();
    }
    return this.save(inv);
  }
  issue(id){
    const inv=this.get(id);if(inv.status!=='draft')problem('Dokument już został wystawiony.',409);
    if(!nipOk(inv.seller.nip)||!inv.seller.address||!inv.seller.bank)problem('Uzupełnij NIP, adres i rachunek sprzedawcy w ustawieniach serwera.');
    if(!nipOk(inv.buyerNip)||!inv.buyerName.trim()||!inv.buyerAddress.trim())problem('Uzupełnij prawidłowy NIP, nazwę i adres nabywcy.');
    for(const key of ['issueDate','saleDate','dueDate'])if(!/^\d{4}-\d{2}-\d{2}$/.test(inv[key])||Number.isNaN(Date.parse(inv[key])))problem('Błędna data '+key);
    const ym=inv.issueDate.slice(0,7);
    const used=this.list().filter(v=>v.number&&v.issueDate.slice(0,7)===ym).map(v=>Number((v.number.match(/\/(\d+)$/)||[])[1]||0));
    inv.number='MM/FV/'+ym.slice(0,4)+'/'+ym.slice(5,7)+'/'+String(Math.max(0,...used)+1).padStart(4,'0');
    inv.status='issued';inv.issuedAt=new Date().toISOString();inv.xmlCreatedAt=inv.issuedAt;return this.save(inv);
  }
}
function toFA3(inv){
  if(inv.status==='draft'||!inv.number)problem('Najpierw wystaw fakturę.');
  const rows=inv.lines.map((r,i)=>'<FaWiersz><NrWierszaFa>'+(i+1)+'</NrWierszaFa><P_7>'+esc(r.description+' ('+r.detail+')')+'</P_7><P_8A>usługa</P_8A><P_8B>1</P_8B><P_9A>'+fmt(r.net)+'</P_9A><P_11>'+fmt(r.net)+'</P_11><P_12>23</P_12></FaWiersz>').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
  +'<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">'
  +'<Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>'+esc(inv.xmlCreatedAt||inv.issuedAt)+'</DataWytworzeniaFa><SystemInfo>MarkNet Faktury</SystemInfo></Naglowek>'
  +'<Podmiot1><DaneIdentyfikacyjne><NIP>'+esc(inv.seller.nip)+'</NIP><Nazwa>'+esc(inv.seller.name)+'</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>'+esc(inv.seller.address)+'</AdresL1></Adres></Podmiot1>'
  +'<Podmiot2><DaneIdentyfikacyjne><NIP>'+esc(inv.buyerNip.replace(/[\s-]/g,''))+'</NIP><Nazwa>'+esc(inv.buyerName)+'</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>'+esc(inv.buyerAddress)+'</AdresL1></Adres><JST>2</JST><GV>2</GV></Podmiot2>'
  +'<Fa><KodWaluty>PLN</KodWaluty><P_1>'+esc(inv.issueDate)+'</P_1><P_2>'+esc(inv.number)+'</P_2><P_6>'+esc(inv.saleDate)+'</P_6>'
  +'<P_13_1>'+fmt(inv.totals.net)+'</P_13_1><P_14_1>'+fmt(inv.totals.vat)+'</P_14_1><P_15>'+fmt(inv.totals.gross)+'</P_15>'
  +'<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje><RodzajFaktury>VAT</RodzajFaktury>'
  +rows+'<Platnosc><TerminPlatnosci><Termin>'+esc(inv.dueDate)+'</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci><RachunekBankowy><NrRB>'+esc(inv.seller.bank)+'</NrRB></RachunekBankowy></Platnosc></Fa></Faktura>';
}
module.exports={BillingStore,toFA3,fmt,nipOk,problem,lineItems};
