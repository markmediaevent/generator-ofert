'use strict';
const express = require('express');
const helmet = require('helmet');
const { Pool } = require('pg');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const CONFIGURED = Boolean(process.env.DATABASE_URL && process.env.INIT_ADMIN_PASSWORD && process.env.INIT_CLIENT_PASSWORD);
if (!CONFIGURED) console.warn('Waiting for secure database connection in Render configuration.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], baseUri: ["'none'"],
  frameAncestors: ["'none'"], formAction: ["'self'"]
}} }));
app.use(express.json({ limit: '64kb' }));
app.use((req,res,next) => {
  res.set('Cache-Control', 'no-store');
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({error:'Niedozwolone żądanie.'}); }
    catch { return res.status(403).json({error:'Nieprawidłowe pochodzenie żądania.'}); }
  }
  next();
});
app.use('/api',(req,res,next)=>{if(!CONFIGURED && req.path!=='/health')return res.status(503).json({error:'Panel oczekuje na konfigurację bazy danych.'});next();});
const db = new Pool({connectionString:process.env.DATABASE_URL||'postgres://localhost/unconfigured',ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:false,max:8});
const categories = ['CCTV','Kontrola dostępu (SKD)','Alarmy (SSWiN)','Telefonia','Sieć LAN / Wi-Fi','Światłowody','Połączenia GPEC','Inne'];
const statuses = ['Nowe','Weryfikacja','W realizacji','Oczekiwanie na klienta','Rozwiązane','Zamknięte'];
const kinds = ['Usterka','Awaria'];
const priorities = ['Standardowy','Krytyczny'];
function scrypt(password,salt){return crypto.scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');}
function hashPassword(p){const salt=crypto.randomBytes(16).toString('hex');return {salt,hash:scrypt(p,salt)};}
function comparePassword(p,u){const h=Buffer.from(scrypt(p,u.pass_salt),'hex');return crypto.timingSafeEqual(h,Buffer.from(u.pass_hash,'hex'));}
function clean(value,max=300){return typeof value==='string'?value.trim().slice(0,max):'';}
function problem(res,code,message){return res.status(code).json({error:message});}
function ticketNumber(t){return 'MN-'+new Date(t.created_at).getUTCFullYear()+'-'+String(t.id).padStart(5,'0');}
async function audit(client,ticketId,userId,action,details){await client.query('INSERT INTO ticket_events(ticket_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[ticketId,userId,action,details||'']);}
async function init(){
  await db.query('CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN (\'admin\',\'client\')), pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await db.query('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL)');
  await db.query('CREATE TABLE IF NOT EXISTS tickets (id BIGSERIAL PRIMARY KEY, organization TEXT NOT NULL DEFAULT \'client\', kind TEXT NOT NULL, priority TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, area TEXT NOT NULL DEFAULT \'\', device TEXT NOT NULL DEFAULT \'\', description TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'Nowe\', created_by BIGINT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), acknowledged_at TIMESTAMPTZ, on_site_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, closed_at TIMESTAMPTZ)');
  await db.query('CREATE TABLE IF NOT EXISTS ticket_events (id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, actor_id BIGINT REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL DEFAULT \'\', created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await db.query('CREATE TABLE IF NOT EXISTS attachments (id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, uploader_id BIGINT REFERENCES users(id), filename TEXT NOT NULL, mime TEXT NOT NULL, content BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const row=(await db.query('SELECT count(*)::int AS n FROM users')).rows[0];
  if(row.n===0){
    const admin=hashPassword(process.env.INIT_ADMIN_PASSWORD);
    const client=hashPassword(process.env.INIT_CLIENT_PASSWORD);
    await db.query('INSERT INTO users(username,role,pass_salt,pass_hash) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', ['marknet','admin',admin.salt,admin.hash,'paprec','client',client.salt,client.hash]);
    console.log('Initial accounts initialized (passwords never logged).');
  }
}
function sessionCookie(token,age){return 'mn_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(process.env.NODE_ENV==='production'?'; Secure':'');}
async function auth(req,res,next){
  try{
    const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mn_session='));
    const token=cookie?cookie.slice('mn_session='.length):'';
    if(!/^[a-f0-9]{64}$/.test(token))return problem(res,401,'Zaloguj się.');
    const hashed=crypto.createHash('sha256').update(token).digest('hex');
    const rows=await db.query('SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [hashed]);
    if(!rows.rowCount)return problem(res,401,'Sesja wygasła. Zaloguj się ponownie.');
    req.user=rows.rows[0];req.tokenHash=hashed;next();
  }catch(e){next(e);}
}
function adminOnly(req,res,next){if(req.user.role!=='admin')return problem(res,403,'Brak uprawnień.');next();}
function longId(req,res,next){if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Nieprawidłowy numer zgłoszenia.');next();}
async function getTicket(id){return (await db.query('SELECT t.*, u.username AS author FROM tickets t JOIN users u ON t.created_by=u.id WHERE t.id=$1',[id])).rows[0];}
function ticketView(t){return {...t,number:ticketNumber(t)};}
const attempts=new Map();
app.post('/api/login',async(req,res,next)=>{
  try{
    const ip=req.ip||'unknown', now=Date.now(), value=attempts.get(ip)||{count:0,until:now+15*60*1000};
    if(now>value.until){value.count=0;value.until=now+15*60*1000;}
    if(value.count>=8)return problem(res,429,'Za dużo prób. Spróbuj ponownie później.');
    const username=clean(req.body.username,80).toLowerCase(), password=typeof req.body.password==='string'?req.body.password:'';
    if(!username || password.length<1 || password.length>256)return problem(res,400,'Podaj login i hasło.');
    const u=(await db.query('SELECT * FROM users WHERE username=$1',[username])).rows[0];
    if(!u || !comparePassword(password,u)){
      value.count++; attempts.set(ip,value); return problem(res,401,'Nieprawidłowy login lub hasło.');
    }
    attempts.delete(ip);
    const token=crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'7 days\')',[crypto.createHash('sha256').update(token).digest('hex'),u.id]);
    res.set('Set-Cookie',sessionCookie(token,7*24*3600));
    res.json({ok:true,role:u.role,username:u.username});
  }catch(e){next(e);}
});
app.get('/api/me',auth,(req,res)=>res.json({username:req.user.username,role:req.user.role,clientName:process.env.CLIENT_NAME||'Klient'}));
app.post('/api/logout',auth,async(req,res,next)=>{try{await db.query('DELETE FROM sessions WHERE token_hash=$1',[req.tokenHash]);res.set('Set-Cookie',sessionCookie('',0));res.json({ok:true});}catch(e){next(e);}});
app.post('/api/change-password',auth,async(req,res,next)=>{
  try{
    const old=String(req.body.oldPassword||''),fresh=String(req.body.newPassword||'');
    if(fresh.length<12 || fresh.length>128)return problem(res,400,'Nowe hasło musi mieć od 12 do 128 znaków.');
    const u=(await db.query('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
    if(!comparePassword(old,u))return problem(res,401,'Dotychczasowe hasło jest niepoprawne.');
    const p=hashPassword(fresh);
    await db.query('UPDATE users SET pass_salt=$1,pass_hash=$2 WHERE id=$3',[p.salt,p.hash,u.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[u.id,req.tokenHash]);
    res.json({ok:true});
  }catch(e){next(e);}
});
app.get('/api/meta',auth,(req,res)=>res.json({categories,statuses,kinds,priorities,clientName:process.env.CLIENT_NAME||'Klient'}));
app.get('/api/tickets',auth,async(req,res,next)=>{
  try{
    const q=req.user.role==='admin'?'SELECT t.*,u.username AS author FROM tickets t JOIN users u ON t.created_by=u.id ORDER BY t.created_at DESC LIMIT 500':'SELECT t.*,u.username AS author FROM tickets t JOIN users u ON t.created_by=u.id WHERE t.organization=$1 ORDER BY t.created_at DESC LIMIT 500';
    const rows=req.user.role==='admin'?(await db.query(q)).rows:(await db.query(q,['client'])).rows;
    res.json({tickets:rows.map(ticketView)});
  }catch(e){next(e);}
});
app.post('/api/tickets',auth,async(req,res,next)=>{
  const kind=clean(req.body.kind,30),priority=clean(req.body.priority,30),category=clean(req.body.category,100);
  const title=clean(req.body.title,180),area=clean(req.body.area,150),device=clean(req.body.device,150),description=clean(req.body.description,5000);
  if(!kinds.includes(kind)||!priorities.includes(priority)||!categories.includes(category)||title.length<5||description.length<10)return problem(res,400,'Uzupełnij prawidłowo rodzaj, priorytet, kategorię, tytuł i opis (min. 10 znaków).');
  const c=await db.connect();
  try{await c.query('BEGIN');
    const t=(await c.query('INSERT INTO tickets(kind,priority,category,title,area,device,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[kind,priority,category,title,area,device,description,req.user.id])).rows[0];
    await audit(c,t.id,req.user.id,'Utworzono zgłoszenie',priority+' / '+kind);
    await c.query('COMMIT');res.status(201).json({ticket:ticketView(t)});
  }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
});
app.get('/api/tickets/:id',auth,longId,async(req,res,next)=>{
  try{
    const t=await getTicket(req.params.id);
    if(!t || (req.user.role!=='admin'&&t.organization!=='client'))return problem(res,404,'Nie znaleziono zgłoszenia.');
    const events=(await db.query('SELECT e.id,e.action,e.details,e.created_at,u.username AS author FROM ticket_events e LEFT JOIN users u ON e.actor_id=u.id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id',[t.id])).rows;
    const files=(await db.query('SELECT id,filename,mime,created_at,octet_length(content) AS size FROM attachments WHERE ticket_id=$1 ORDER BY id',[t.id])).rows;
    res.json({ticket:ticketView(t),events,files});
  }catch(e){next(e);}
});
app.post('/api/tickets/:id/events',auth,longId,async(req,res,next)=>{
  try{
    const t=await getTicket(req.params.id);
    if(!t || (req.user.role!=='admin'&&t.organization!=='client'))return problem(res,404,'Nie znaleziono zgłoszenia.');
    if(t.status==='Zamknięte' && req.user.role!=='admin')return problem(res,409,'Zgłoszenie jest zamknięte.');
    const body=clean(req.body.body,3000);if(body.length<2)return problem(res,400,'Wpisz treść komentarza.');
    await db.query('INSERT INTO ticket_events(ticket_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[t.id,req.user.id,'Komentarz',body]);
    res.status(201).json({ok:true});
  }catch(e){next(e);}
});
app.patch('/api/tickets/:id',auth,adminOnly,longId,async(req,res,next)=>{
  const status=clean(req.body.status,80), event=clean(req.body.event,40),details=clean(req.body.details,3000);
  if(status && !statuses.includes(status))return problem(res,400,'Niepoprawny status.');
  if(event && !['acknowledge','on_site','resolve'].includes(event))return problem(res,400,'Niepoprawne zdarzenie.');
  if(!status&&!event&&!details)return problem(res,400,'Brak zmian.');
  const c=await db.connect();
  try{await c.query('BEGIN');
    const t=(await c.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(!t){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono zgłoszenia.');}
    let nextStatus=status||t.status, extra=[];
    if(event==='acknowledge'){nextStatus= status||'Weryfikacja';extra.push('acknowledged_at=COALESCE(acknowledged_at,now())');}
    if(event==='on_site'){nextStatus=status||'W realizacji';extra.push('on_site_at=COALESCE(on_site_at,now())');}
    if(event==='resolve'){nextStatus=status||'Rozwiązane';extra.push('resolved_at=COALESCE(resolved_at,now())');}
    if(nextStatus==='Rozwiązane')extra.push('resolved_at=COALESCE(resolved_at,now())');
    if(nextStatus==='Zamknięte')extra.push('closed_at=COALESCE(closed_at,now())');
    const set='status=$1'+(extra.length?','+extra.join(','):'');
    await c.query('UPDATE tickets SET '+set+' WHERE id=$2',[nextStatus,t.id]);
    await audit(c,t.id,req.user.id,'Aktualizacja: '+(event||nextStatus),details||('Status: '+t.status+' → '+nextStatus));
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
app.post('/api/tickets/:id/attachments',auth,longId,upload.single('file'),async(req,res,next)=>{
  try{
    const t=await getTicket(req.params.id);
    if(!t || (req.user.role!=='admin'&&t.organization!=='client'))return problem(res,404,'Nie znaleziono zgłoszenia.');
    if(!req.file)return problem(res,400,'Nie wybrano pliku.');
    const b=req.file.buffer, mime=req.file.mimetype;
    const jpg=b[0]===0xff && b[1]===0xd8 && b[2]===0xff;
    const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const pdf=b.subarray(0,5).toString()==='%PDF-';
    if(!((jpg&&mime==='image/jpeg')||(png&&mime==='image/png')||(pdf&&mime==='application/pdf')))return problem(res,400,'Dozwolone są wyłącznie pliki JPG, PNG lub PDF do 5 MB.');
    const name=path.basename(req.file.originalname).replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,120)||'zalacznik';
    const count=(await db.query('SELECT count(*)::int AS n FROM attachments WHERE ticket_id=$1',[t.id])).rows[0].n;
    if(count>=10)return problem(res,400,'Limit 10 załączników na zgłoszenie.');
    await db.query('INSERT INTO attachments(ticket_id,uploader_id,filename,mime,content) VALUES($1,$2,$3,$4,$5)',[t.id,req.user.id,name,mime,b]);
    await db.query('INSERT INTO ticket_events(ticket_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[t.id,req.user.id,'Dodano załącznik',name]);
    res.status(201).json({ok:true});
  }catch(e){next(e);}
});
app.get('/api/attachments/:id',auth,longId,async(req,res,next)=>{
  try{
    const a=(await db.query('SELECT a.*,t.organization FROM attachments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=$1',[req.params.id])).rows[0];
    if(!a || (req.user.role!=='admin'&&a.organization!=='client'))return problem(res,404,'Nie znaleziono pliku.');
    res.type(a.mime);res.set('Content-Disposition','attachment; filename="zalacznik-'+a.id+'.'+(a.mime==='application/pdf'?'pdf':a.mime==='image/jpeg'?'jpg':'png')+'"');res.send(a.content);
  }catch(e){next(e);}
});
function font(doc){
 const fonts=['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
 const f=fonts.find(p=>fs.existsSync(p));if(f)doc.font(f);else doc.font('Helvetica');
}
function datePL(v){return v?new Intl.DateTimeFormat('pl-PL',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Warsaw'}).format(new Date(v)):'—';}
function pdfStart(res,file){res.set('Content-Type','application/pdf');res.set('Content-Disposition','attachment; filename="'+file+'"');const doc=new PDFDocument({size:'A4',margin:44,info:{Title:'MarkNet - raport serwisowy'}});doc.pipe(res);font(doc);return doc;}
function p(doc,label,value){
  if(doc.y>718)doc.addPage();
  doc.fontSize(9).fillColor('#6a7e89').text(label,{continued:false});
  doc.fontSize(11).fillColor('#122938').text(String(value??'—'),{width:500});
  doc.moveDown(.65);
}
function head(doc,title,subtitle){
 doc.rect(0,0,595,95).fill('#0b1d2b');doc.fillColor('#6ce6d7').fontSize(18).text('MARKNET',45,27);font(doc);
 doc.fillColor('#eaf5fa').fontSize(12).text('SERWIS • RAPORT',45,53);
 doc.fillColor('#122938').fontSize(18).text(title,45,123);
 doc.fontSize(10).fillColor('#566e7a').text(subtitle,45,154);
 doc.moveTo(45,174).lineTo(550,174).strokeColor('#cddde4').stroke();doc.y=190;
}
app.get('/api/reports/tickets/:id.pdf',auth,adminOnly,async(req,res,next)=>{
  try{
    if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Niepoprawny identyfikator.');
    const t=await getTicket(req.params.id);if(!t)return problem(res,404,'Nie znaleziono zgłoszenia.');
    const ev=(await db.query('SELECT e.*,u.username FROM ticket_events e LEFT JOIN users u ON e.actor_id=u.id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id',[t.id])).rows;
    const doc=pdfStart(res,'raport-'+ticketNumber(t)+'.pdf');
    head(doc,'Protokół zgłoszenia '+ticketNumber(t),process.env.CLIENT_NAME||'Klient');
    p(doc,'Temat',t.title);p(doc,'Rodzaj / priorytet',t.kind+' / '+t.priority);p(doc,'System / lokalizacja',t.category+' / '+(t.area||'nie podano'));p(doc,'Urządzenie',t.device||'nie podano');
    p(doc,'Zgłoszone',datePL(t.created_at)+' • '+t.author);p(doc,'Status',t.status);
    p(doc,'Pierwsza weryfikacja',datePL(t.acknowledged_at));p(doc,'Przyjazd na obiekt',datePL(t.on_site_at));
    p(doc,'Rozwiązano',datePL(t.resolved_at));p(doc,'Zamknięto',datePL(t.closed_at));
    p(doc,'Opis zgłoszenia',t.description);
    if(doc.y>645)doc.addPage();
    doc.fontSize(14).fillColor('#122938').text('Historia zgłoszenia').moveDown(.4);
    for(const e of ev){p(doc,datePL(e.created_at)+' • '+(e.username||'system')+' • '+e.action,e.details||'—');}
    doc.moveDown();doc.fontSize(8).fillColor('#74838a').text('Raport wygenerowany automatycznie na podstawie danych zgłoszenia. Nie stanowi potwierdzenia wykonania prac, których nie odnotowano w historii.',{width:500});
    doc.end();
  }catch(e){next(e);}
});
app.get('/api/reports/month.pdf',auth,adminOnly,async(req,res,next)=>{
  try{
    const month=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return problem(res,400,'Wybierz miesiąc RRRR-MM.');
    const from=month+'-01', to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
    const rows=(await db.query('SELECT t.*,u.username AS author FROM tickets t JOIN users u ON t.created_by=u.id WHERE created_at >= ($1::date AT TIME ZONE \'Europe/Warsaw\') AND created_at < ($2::date AT TIME ZONE \'Europe/Warsaw\') ORDER BY created_at',[from,to])).rows;
    const doc=pdfStart(res,'raport-miesieczny-'+month+'.pdf');
    head(doc,'Raport miesięczny • '+month,process.env.CLIENT_NAME||'Klient');
    const by=(key)=>Object.entries(rows.reduce((a,t)=>(a[t[key]]=(a[t[key]]||0)+1,a),{})).map(([k,n])=>k+': '+n).join('  |  ')||'brak';
    p(doc,'Liczba nowych zgłoszeń',rows.length);
    p(doc,'Według rodzaju',by('kind'));p(doc,'Według priorytetu',by('priority'));p(doc,'Według aktualnego statusu',by('status'));
    p(doc,'Według systemu',by('category'));
    const response=rows.filter(x=>x.acknowledged_at).map(x=>(new Date(x.acknowledged_at)-new Date(x.created_at))/60000);
    p(doc,'Średni czas do odnotowanej weryfikacji',response.length?(response.reduce((a,b)=>a+b,0)/response.length).toFixed(0)+' minut ('+response.length+' zgłoszeń)':'brak danych');
    if(doc.y>630)doc.addPage();
    doc.fontSize(14).fillColor('#122938').text('Rejestr zgłoszeń').moveDown(.3);
    for(const t of rows){p(doc,ticketNumber(t)+' • '+datePL(t.created_at),t.category+' • '+t.priority+' • '+t.status+' • '+t.title);}
    if(!rows.length)p(doc,'Rejestr','Brak zgłoszeń w wybranym miesiącu');
    doc.fontSize(8).fillColor('#74838a').text('Wyniki obejmują zgłoszenia utworzone w danym miesiącu. Czasy są obliczane wyłącznie na podstawie zarejestrowanych zdarzeń.');
    doc.end();
  }catch(e){next(e);}
});
app.get('/api/reports/month.csv',auth,adminOnly,async(req,res,next)=>{
  try{
    const month=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return problem(res,400,'Nieprawidłowy miesiąc.');
    const from=month+'-01',to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
    const rows=(await db.query('SELECT * FROM tickets WHERE created_at >= ($1::date AT TIME ZONE \'Europe/Warsaw\') AND created_at < ($2::date AT TIME ZONE \'Europe/Warsaw\') ORDER BY created_at',[from,to])).rows;
    const val=(v)=>{let x=String(v??'');if(/^[=+@-]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"';};
    const columns=['Numer','Data','Rodzaj','Priorytet','System','Temat','Miejsce','Urządzenie','Status','Weryfikacja','Przyjazd','Rozwiązanie'];
    const data=rows.map(t=>[ticketNumber(t),datePL(t.created_at),t.kind,t.priority,t.category,t.title,t.area,t.device,t.status,datePL(t.acknowledged_at),datePL(t.on_site_at),datePL(t.resolved_at)]);
    res.type('text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="zgłoszenia-'+month+'.csv"');
    res.send('\ufeff'+[columns,...data].map(r=>r.map(val).join(';')).join('\r\n'));
  }catch(e){next(e);}
});
app.get('/api/health',async(req,res)=>{if(!CONFIGURED)return res.status(503).json({status:'setup_required'});try{await db.query('SELECT 1');res.json({status:'ok'});}catch{res.status(503).json({status:'unavailable'});}});
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',setHeaders(res){res.set('Cache-Control','no-store');}}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError)return problem(res,400,err.code==='LIMIT_FILE_SIZE'?'Plik przekracza 5 MB.':'Nieprawidłowy załącznik.');
  console.error('Request error',err.message);
  if(res.headersSent)return next(err);
  problem(res,500,'Nie udało się wykonać operacji. Spróbuj ponownie.');
});
if(CONFIGURED) init().then(()=>app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Service portal ready'))).catch(e=>{console.error('Database initialization failed',e.message);process.exit(1);});
else app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Service portal in setup mode'));

