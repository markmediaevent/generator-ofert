'use strict';
const crypto = require('node:crypto');
const ROOTS={test:'https://api-test.ksef.mf.gov.pl/v2',demo:'https://api-demo.ksef.mf.gov.pl/v2',prod:'https://api.ksef.mf.gov.pl/v2'};
function checkMode(){
  const mode=process.env.KSEF_ENV||'test';
  if(!ROOTS[mode])throw Error('Nieznane środowisko KSeF.');
  if(mode!=='prod'||process.env.KSEF_LIVE_ENABLED!=='true')
    throw Error('Wysyłanie rzeczywistych faktur do KSeF jest zablokowane. Wymaga przetestowanej integracji i jawnego włączenia trybu PROD.');
  if(!process.env.KSEF_TOKEN)throw Error('Brak KSEF_TOKEN w sekretach serwera.');
  return ROOTS[mode];
}
function b64(b){return Buffer.from(b).toString('base64')}
function sha(b){return b64(crypto.createHash('sha256').update(b).digest())}
async function call(base,url,{method='GET',body,token}={}){
  const headers={'Accept':'application/json','X-Error-Format':'problem-details'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(token)headers.Authorization='Bearer '+token;
  const r=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(18000)});
  const raw=await r.text();let obj;
  try{obj=JSON.parse(raw)}catch{obj={message:raw.slice(0,700)}}
  if(!r.ok){const err=new Error('KSeF HTTP '+r.status+': '+JSON.stringify(obj).slice(0,700));err.code=r.status;throw err}
  return obj;
}
function pickKey(certs,usage){
  const now=Date.now();
  const options=certs.filter(c=>Array.isArray(c.usage)&&c.usage.includes(usage)
    &&(!c.validFrom||Date.parse(c.validFrom)<=now)&&(!c.validTo||Date.parse(c.validTo)>now));
  options.sort((a,b)=>Date.parse(b.validFrom||0)-Date.parse(a.validFrom||0));
  if(!options.length)throw Error('Brak aktualnego klucza publicznego KSeF: '+usage);
  const c=options[0];
  const der=Buffer.from(c.certificate,'base64');
  return {key:new crypto.X509Certificate(der).publicKey,id:c.certificateId};
}
function rsa(data,key){
  return b64(crypto.publicEncrypt({key,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(data)));
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function authenticate(base,nip){
  const token=process.env.KSEF_TOKEN;
  const [challenge,certs]=await Promise.all([
    call(base,'/auth/challenge',{method:'POST'}),call(base,'/security/public-key-certificates')
  ]);
  const key=pickKey(certs,'KsefTokenEncryption');
  const encryptedToken=rsa(token+'|'+String(Date.parse(challenge.timestamp)),key.key);
  const started=await call(base,'/auth/ksef-token',{method:'POST',body:{
    challenge:challenge.challenge,contextIdentifier:{type:'Nip',value:nip},
    encryptedToken,publicKeyId:key.id
  }});
  const temporary=started.authenticationToken?.token;
  if(!temporary||!started.referenceNumber)throw Error('KSeF nie zwrócił tokena operacyjnego.');
  let ok=false;
  for(let n=0;n<10;n++){
    const check=await call(base,'/auth/'+encodeURIComponent(started.referenceNumber),{token:temporary});
    if(check.status?.code===200){ok=true;break}
    if(check.status?.code>=400)throw Error('Błąd autoryzacji KSeF: '+JSON.stringify(check.status).slice(0,400));
    await delay(1100);
  }
  if(!ok)throw Error('Autoryzacja KSeF jeszcze trwa. Spróbuj później.');
  const auth=await call(base,'/auth/token/redeem',{method:'POST',token:temporary});
  if(!auth.accessToken?.token)throw Error('KSeF nie zwrócił accessToken.');
  return {access:auth.accessToken.token,certs};
}
async function submitInvoice(xml,nip){
  const base=checkMode(), {access,certs}=await authenticate(base,nip);
  const key=pickKey(certs,'SymmetricKeyEncryption');
  const sym=crypto.randomBytes(32),iv=crypto.randomBytes(16);
  const opened=await call(base,'/sessions/online',{method:'POST',token:access,body:{
    formCode:{systemCode:'FA (3)',schemaVersion:'1-0E',value:'FA'},
    encryption:{encryptedSymmetricKey:rsa(sym,key.key),initializationVector:b64(iv),publicKeyId:key.id}
  }});
  if(!opened.referenceNumber)throw Error('Brak numeru sesji KSeF.');
  const xmlBuffer=Buffer.from(xml,'utf8');
  const cipher=crypto.createCipheriv('aes-256-cbc',sym,iv),encrypted=Buffer.concat([cipher.update(xmlBuffer),cipher.final()]);
  const submitted=await call(base,'/sessions/online/'+encodeURIComponent(opened.referenceNumber)+'/invoices',{method:'POST',token:access,body:{
    invoiceHash:sha(xmlBuffer),invoiceSize:xmlBuffer.length,encryptedInvoiceHash:sha(encrypted),
    encryptedInvoiceSize:encrypted.length,encryptedInvoiceContent:b64(encrypted),offlineMode:false
  }});
  if(!submitted.referenceNumber)throw Error('KSeF nie zwrócił numeru referencyjnego faktury.');
  const result={sessionRef:opened.referenceNumber,invoiceRef:submitted.referenceNumber,invoiceHash:sha(xmlBuffer)};
  try{await call(base,'/sessions/online/'+encodeURIComponent(opened.referenceNumber)+'/close',{method:'POST',token:access})}
  catch(e){result.closeWarning='Przekazano fakturę, ale nie potwierdzono zamknięcia sesji: '+e.message}
  return result;
}
async function checkInvoice(nip,sessionRef,invoiceRef){
  const base=checkMode(),{access}=await authenticate(base,nip);
  return call(base,'/sessions/'+encodeURIComponent(sessionRef)+'/invoices/'+encodeURIComponent(invoiceRef),{token:access});
}
async function getUpo(nip,sessionRef,invoiceRef){
  const base=checkMode(),{access}=await authenticate(base,nip);
  const r=await fetch(base+'/sessions/'+encodeURIComponent(sessionRef)+'/invoices/'+encodeURIComponent(invoiceRef)+'/upo',
    {headers:{Authorization:'Bearer '+access},signal:AbortSignal.timeout(18000)});
  if(!r.ok)throw Error('UPO nie jest jeszcze dostępne ('+r.status+').');
  return Buffer.from(await r.arrayBuffer());
}
module.exports={submitInvoice,checkInvoice,getUpo};
