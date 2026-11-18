'use strict';
const express = require('express');
const helmet = require('helmet');
const { Pool } = require('pg');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const notifications=require('./notifications');
const webpush=require('web-push');
const {setupTenancy,migrateTenancy}=require('./tenancy');
const pushConfigured=Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT);
if(pushConfigured)webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);

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
const TRUSTED_FRONTENDS = new Set(['https://marknet.com.pl','https://www.marknet.com.pl']);
app.use((req,res,next) => {
  res.set('Cache-Control', 'no-store');
  const origin=req.headers.origin;
  const isTrusted=origin && TRUSTED_FRONTENDS.has(origin);
  if(isTrusted) {
    res.set('Access-Control-Allow-Origin',origin);
    res.set('Vary','Origin');
    res.set('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age','600');
  }
  if(req.method==='OPTIONS')return isTrusted?res.sendStatus(204):res.sendStatus(403);
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && origin) {
    try { if(new URL(origin).host!==req.headers.host && !isTrusted) return res.status(403).json({error:'Niedozwolone żądanie.'}); }
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
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_name TEXT');
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_email TEXT');
  await db.query("CREATE TABLE IF NOT EXISTS notification_jobs (id BIGSERIAL PRIMARY KEY, ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('confirmation','admin_email','phone')), status TEXT NOT NULL DEFAULT 'pending', attempt_count INT NOT NULL DEFAULT 0, retry_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ, last_error TEXT, UNIQUE(ticket_id,kind))");
  await db.query("CREATE INDEX IF NOT EXISTS notification_jobs_due ON notification_jobs(retry_at,id) WHERE status='pending'");
  await db.query("CREATE TABLE IF NOT EXISTS push_subscriptions (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const row=(await db.query('SELECT count(*)::int AS n FROM users')).rows[0];
  if(row.n===0){
    const admin=hashPassword(process.env.INIT_ADMIN_PASSWORD);
    const client=hashPassword(process.env.INIT_CLIENT_PASSWORD);
    await db.query('INSERT INTO users(username,role,pass_salt,pass_hash) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)', ['marknet','admin',admin.salt,admin.hash,'paprec','client',client.salt,client.hash]);
    console.log('Initial accounts initialized (passwords never logged).');
  }
  await migrateTenancy(db,categories);
  // Jednorazowo odzyskaj wysyłki błędnie oznaczone jako wykonane przez starszą wersję procesora.
  await db.query("CREATE TABLE IF NOT EXISTS service_migrations (migration_key TEXT PRIMARY KEY, executed_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const repairRun=await db.query("INSERT INTO service_migrations(migration_key) VALUES('notification_delivery_repair_20261118') ON CONFLICT DO NOTHING RETURNING migration_key");
  if(repairRun.rowCount){
    const repair=await db.query("UPDATE notification_jobs SET status='pending', attempt_count=0, retry_at=now(), delivered_at=NULL, last_error=NULL WHERE status='delivered' AND delivered_at IS NOT NULL AND delivered_at < TIMESTAMPTZ '2026-11-18 08:30:00+00'");
    console.log('Recovered previously misclassified notification jobs:',repair.rowCount);
  }
  // Jednorazowa migracja utworzenia profilu Portu Czystej Energii oraz konta b.zieba.
  // W repozytorium znajduje się wyłącznie losowy sól i skrót scrypt; hasło jawne nie jest publikowane.
  const portProvision=await db.connect();
  try{
    await portProvision.query('BEGIN');
    const migration=(await portProvision.query(
      "INSERT INTO service_migrations(migration_key) VALUES('port_czystej_energii_profile_20261118_v1') ON CONFLICT DO NOTHING RETURNING migration_key"
    ));
    if(migration.rowCount){
      const orgName='Port Czystej Energii Sp. z o.o.';
      const profile={
        address:'ul. Jabłoniowa 57, 80-175 Gdańsk',
        nip:'583-322-49-15',
        regon:'366163098',
        krs:'0000654720',
        contact_name:'Beata Ewa Zięba',
        contact_role:'Kierownik, Dział energetyki i ciepłownictwa',
        contact_email:'bzieba@portczystejenergii.pl',
        contact_phone:'+48 58 585-36-02',
        contact_mobile:'506-912-871'
      };
      const org=(await portProvision.query(
        "INSERT INTO organizations(name,profile) VALUES($1,$2::jsonb) ON CONFLICT(name) DO UPDATE SET profile=EXCLUDED.profile RETURNING id",
        [orgName,JSON.stringify(profile)]
      )).rows[0];
      const paprec=(await portProvision.query(
        "SELECT id FROM organizations WHERE name='PAPREC Energies Gdańsk'"
      )).rows[0];
      if(!paprec)throw new Error('Brak profilu PAPREC do skopiowania zakresu systemów.');
      const count=(await portProvision.query(
        'SELECT count(*)::int AS n FROM organization_systems WHERE organization_id=$1',[paprec.id]
      )).rows[0].n;
      if(count<1)throw new Error('PAPREC nie ma przypisanych systemów.');
      await portProvision.query('DELETE FROM organization_systems WHERE organization_id=$1',[org.id]);
      await portProvision.query(
        "INSERT INTO organization_systems(organization_id,category) SELECT $1,category FROM organization_systems WHERE organization_id=$2",
        [org.id,paprec.id]
      );
      const account=(await portProvision.query(
        "INSERT INTO users(username,email,role,pass_salt,pass_hash,organization_id,is_active) VALUES($1,$2,'client',$3,$4,$5,true) ON CONFLICT(username) DO NOTHING RETURNING id",
        ['b.zieba','bzieba@portczystejenergii.pl','f7e87a8487046c3d641b5b0043273cc3',
         'da722869398452ef73fe7cf54811711a080d88a2994e41821d0338219f457a57172c471e04f8afb6620c1b365f23e5a05e267b8d10643d9ff105d2953c72d1f5',org.id]
      )).rows[0];
      await portProvision.query('COMMIT');
      console.log('Port Czystej Energii provisioning:',JSON.stringify({organization_created:true,system_count:count,account_created:!!account}));
    }else{
      await portProvision.query('COMMIT');
    }
  }catch(e){
    await portProvision.query('ROLLBACK');
    console.error('Port Czystej Energii provisioning failed:',e.message);
  }finally{portProvision.release();}
  const portAccount=await db.connect();
  try{
    await portAccount.query('BEGIN');
    const change=(await portAccount.query(
      "INSERT INTO service_migrations(migration_key) VALUES('port_czystej_energii_bzieba_v2_20261118') ON CONFLICT DO NOTHING RETURNING migration_key"
    ));
    if(change.rowCount){
      const updated=await portAccount.query(
        "UPDATE users SET first_name=$1,last_name=$2,pass_salt=$3,pass_hash=$4 WHERE username=$5 AND role='client' AND deleted_at IS NULL",
        ['Beata Ewa','Zięba','8f9929f86a2d345ae1521d1be585e700','784bf7516cbbc126e70f8a11d3771ccb72ee0802b4d47e30271c8a6a365ac64fb8210d27d48c0f21c0d797c16965d7124852318a46b72b71f5529a1187645072','b.zieba']
      );
      if(updated.rowCount!==1)throw new Error('Nie udało się skonfigurować profilu b.zieba.');
      await portAccount.query("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='b.zieba')");
      await portAccount.query('COMMIT');
      console.log('b.zieba profile and initial password configured');
    }else{
      await portAccount.query('COMMIT');
    }
  }catch(e){
    await portAccount.query('ROLLBACK');
    console.error('Profile initialization failed:',e.message);
  }finally{portAccount.release();}
  // Verify without logging emails, credentials or sensitive company information.
  const portCheck=(await db.query(
    "SELECT o.id,o.is_active,COUNT(DISTINCT s.category)::int AS systems,MAX(CASE WHEN u.username='b.zieba' AND u.role='client' AND u.is_active=true AND u.deleted_at IS NULL AND u.email='bzieba@portczystejenergii.pl' THEN 1 ELSE 0 END)::int AS user_ready "+
    "FROM organizations o LEFT JOIN organization_systems s ON s.organization_id=o.id LEFT JOIN users u ON u.organization_id=o.id "+
    "WHERE o.name='Port Czystej Energii Sp. z o.o.' GROUP BY o.id,o.is_active"
  )).rows[0];
  console.log('Port Czystej Energii account readiness:',JSON.stringify(portCheck||{missing:true}));
  const readiness=(await db.query(
    "SELECT "+
    "(SELECT count(*)::int FROM users WHERE role='client' AND is_active=true AND (email IS NULL OR btrim(email)='')) AS clients_missing_email, "+
    "(SELECT count(*)::int FROM users WHERE role='client' AND is_active=true) AS active_client_users, "+
    "(SELECT count(*)::int FROM notification_jobs WHERE status='pending') AS pending_notifications, "+
    "(SELECT count(*)::int FROM notification_jobs WHERE status='pending' AND attempt_count>0) AS failed_notifications, "+
    "(SELECT count(*)::int FROM notification_jobs WHERE status='delivered') AS delivered_notifications, "+
    "(SELECT count(*)::int FROM push_subscriptions) AS subscribed_devices, "+
    "(SELECT EXISTS(SELECT 1 FROM users WHERE username='paprec' AND is_active=true AND email IS NOT NULL AND btrim(email)<>'')) AS paprec_email_ready, "+
    "(SELECT EXISTS(SELECT 1 FROM organization_systems os JOIN organizations o ON o.id=os.organization_id WHERE o.name='PAPREC Energies Gdańsk' AND os.category='Połączenia GPEC')) AS paprec_gpec_enabled"
  )).rows[0];
  console.log('Readiness preflight:',JSON.stringify({...readiness,smtp_configured:notifications.smtpReady(),push_configured:pushConfigured}));
}
function sessionCookie(token,age){return 'mn_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(process.env.NODE_ENV==='production'?'; Secure':'');}
async function auth(req,res,next){
  try{
    const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mn_session='));
    const bearer=String(req.headers.authorization||'').match(/^Bearer ([a-f0-9]{64})$/);
    const token=bearer?bearer[1]:(cookie?cookie.slice('mn_session='.length):'');
    if(!/^[a-f0-9]{64}$/.test(token))return problem(res,401,'Zaloguj się.');
    const hashed=crypto.createHash('sha256').update(token).digest('hex');
    const rows=await db.query("SELECT u.id,u.username,u.email,u.first_name,u.last_name,u.role,u.organization_id,o.name AS organization_name,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN organizations o ON o.id=u.organization_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true AND u.deleted_at IS NULL AND (u.role='admin' OR o.is_active=true)",[hashed]);
    if(!rows.rowCount)return problem(res,401,'Sesja wygasła. Zaloguj się ponownie.');
    req.user=rows.rows[0];req.tokenHash=hashed;next();
  }catch(e){next(e);}
}
function adminOnly(req,res,next){if(req.user.role!=='admin')return problem(res,403,'Brak uprawnień.');next();}
function longId(req,res,next){if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Nieprawidłowy numer zgłoszenia.');next();}
async function getTicket(id){return (await db.query('SELECT t.*,u.username AS author,o.name AS organization_name FROM tickets t JOIN users u ON t.created_by=u.id LEFT JOIN organizations o ON o.id=t.organization_id WHERE t.id=$1 AND t.deleted_at IS NULL',[id])).rows[0];}
function canAccessTicket(t,u){return !!t && (u.role==='admin' || (u.organization_id!=null && String(t.organization_id)===String(u.organization_id)));}
function ticketView(t){return {...t,number:ticketNumber(t)};}
const attempts=new Map();
app.post('/api/login',async(req,res,next)=>{
  try{
    const ip=req.ip||'unknown', now=Date.now(), value=attempts.get(ip)||{count:0,until:now+15*60*1000};
    if(now>value.until){value.count=0;value.until=now+15*60*1000;}
    if(value.count>=8)return problem(res,429,'Za dużo prób. Spróbuj ponownie później.');
    const username=clean(req.body.username,80).toLowerCase(), password=typeof req.body.password==='string'?req.body.password:'';
    if(!username || password.length<1 || password.length>256)return problem(res,400,'Podaj login i hasło.');
    const u=(await db.query('SELECT u.*,o.is_active AS org_active FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE u.username=$1',[username])).rows[0];
    if(!u || !u.is_active || u.deleted_at || (u.role==='client' && !u.org_active) || !comparePassword(password,u)){
      value.count++; attempts.set(ip,value); return problem(res,401,'Nieprawidłowy login lub hasło.');
    }
    attempts.delete(ip);
    const token=crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'7 days\')',[crypto.createHash('sha256').update(token).digest('hex'),u.id]);
    if(req.headers.origin && TRUSTED_FRONTENDS.has(req.headers.origin)) {
      res.json({ok:true,role:u.role,username:u.username,accessToken:token});
    } else {
      res.set('Set-Cookie',sessionCookie(token,7*24*3600));
      res.json({ok:true,role:u.role,username:u.username});
    }
  }catch(e){next(e);}
});
app.get('/api/me',auth,(req,res)=>res.json({username:req.user.username,email:req.user.email||'',first_name:req.user.first_name||'',last_name:req.user.last_name||'',role:req.user.role,organization_id:req.user.organization_id,clientName:req.user.organization_name||'MarkNet'}));
app.post('/api/logout',auth,async(req,res,next)=>{try{await db.query('DELETE FROM sessions WHERE token_hash=$1',[req.tokenHash]);if(!req.headers.authorization)res.set('Set-Cookie',sessionCookie('',0));res.json({ok:true});}catch(e){next(e);}});
app.post('/api/change-password',auth,async(req,res,next)=>{
  try{
    const old=String(req.body.oldPassword||''),fresh=String(req.body.newPassword||'');
    if(fresh.length<8 || fresh.length>128)return problem(res,400,'Nowe hasło musi mieć od 8 do 128 znaków.');
    const u=(await db.query('SELECT * FROM users WHERE id=$1',[req.user.id])).rows[0];
    if(!comparePassword(old,u))return problem(res,401,'Dotychczasowe hasło jest niepoprawne.');
    const p=hashPassword(fresh);
    await db.query('UPDATE users SET pass_salt=$1,pass_hash=$2 WHERE id=$3',[p.salt,p.hash,u.id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[u.id,req.tokenHash]);
    res.json({ok:true});
  }catch(e){next(e);}
});
app.get('/api/meta',auth,async(req,res,next)=>{
 try{
  const allowed=req.user.role==='admin'?categories:(await db.query('SELECT category FROM organization_systems WHERE organization_id=$1 ORDER BY category',[req.user.organization_id])).rows.map(r=>r.category);
  res.json({categories:allowed,allCategories:req.user.role==='admin'?categories:undefined,statuses,kinds,priorities,clientName:req.user.organization_name||'MarkNet'});
 }catch(e){next(e);}
});
app.get('/api/tickets',auth,async(req,res,next)=>{
 try{
  const sql="SELECT t.*,u.username AS author,o.name AS organization_name FROM tickets t JOIN users u ON t.created_by=u.id LEFT JOIN organizations o ON o.id=t.organization_id";
  let rows;
  if(req.user.role==='admin'){
    const filter=/^[1-9]\d*$/.test(String(req.query.organization_id||''))?String(req.query.organization_id):null;
    rows=(await db.query(sql+(filter?" WHERE t.deleted_at IS NULL AND t.organization_id=$1":" WHERE t.deleted_at IS NULL")+" ORDER BY t.created_at DESC LIMIT 500",filter?[filter]:[])).rows;
  } else {
    rows=(await db.query(sql+" WHERE t.organization_id=$1 AND t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT 500",[req.user.organization_id])).rows;
  }
  res.json({tickets:rows.map(ticketView)});
 }catch(e){next(e);}
});
app.post('/api/tickets',auth,async(req,res,next)=>{
  const kind=clean(req.body.kind,30),priority=clean(req.body.priority,30),category=clean(req.body.category,100);
  const area=clean(req.body.area,150),device=clean(req.body.device,150),description=clean(req.body.description,5000);
  const title=clean(kind+' – '+category+(area?' – '+area:''),180);
  const profileName=clean([req.user.first_name,req.user.last_name].filter(Boolean).join(' '),120);
  const requesterName=clean((req.user.role==='client'&&profileName)?profileName:req.body.requester_name,120);
  // Konto klienta zawsze wysyła potwierdzenie na adres przypisany przez administratora.
  const requesterEmail=(req.user.role==='client'?String(req.user.email||''):clean(req.body.requester_email,254)).trim().toLowerCase();
  const validEmail=/^[a-z0-9.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(requesterEmail);
  if(!kinds.includes(kind)||!priorities.includes(priority)||!categories.includes(category)||description.length<10||requesterName.length<3)return problem(res,400,'Uzupełnij rodzaj, priorytet, kategorię, osobę zgłaszającą i opis.');
  if(!validEmail)return problem(res,400,req.user.role==='client'?'Nie masz przypisanego poprawnego adresu e-mail. Poproś administratora MarkNet o uzupełnienie adresu na Twoim koncie.':'Podaj prawidłowy adres e-mail odbiorcy potwierdzenia.');
  const orgId=req.user.role==='admin'?String(req.body.organization_id||''):String(req.user.organization_id||'');
  if(!/^[1-9]\d*$/.test(orgId))return problem(res,400,'Wybierz klienta dla zgłoszenia.');
  const c=await db.connect();
  try{await c.query('BEGIN');
    const allowed=(await c.query("SELECT o.id FROM organizations o JOIN organization_systems s ON s.organization_id=o.id WHERE o.id=$1 AND o.is_active=true AND s.category=$2",[orgId,category])).rows[0];
    if(!allowed){await c.query('ROLLBACK');return problem(res,400,'Wybrany system nie jest objęty obsługą tego klienta.');}
    const t=(await c.query('INSERT INTO tickets(kind,priority,category,title,area,device,description,created_by,requester_name,requester_email,organization_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[kind,priority,category,title,area,device,description,req.user.id,requesterName,requesterEmail,orgId])).rows[0];
    await audit(c,t.id,req.user.id,'Utworzono zgłoszenie',priority+' / '+kind);
    await c.query("INSERT INTO notification_jobs(ticket_id,kind) SELECT $1, x FROM unnest(ARRAY['confirmation','admin_email','phone']::text[]) AS x",[t.id]);
    await c.query('COMMIT');res.status(201).json({ticket:ticketView(t),notification:{email:notifications.smtpReady()?'queued':'configuration_required'}});
  }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
});
app.delete('/api/tickets/:id',auth,adminOnly,longId,async(req,res,next)=>{
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const t=(await c.query('SELECT id,created_at FROM tickets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id])).rows[0];
  if(!t){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono zgłoszenia.');}
  await c.query('UPDATE tickets SET deleted_at=now(),deleted_by=$2 WHERE id=$1',[t.id,req.user.id]);
  await c.query("UPDATE notification_jobs SET status='cancelled',last_error='Powiadomienia anulowano po usunięciu zgłoszenia' WHERE ticket_id=$1 AND status='pending'",[t.id]);
  await audit(c,t.id,req.user.id,'Usunięto z aktywnego rejestru','Archiwizacja administracyjna');
  await c.query('COMMIT');
  res.json({ok:true,number:ticketNumber(t)});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
});
app.get('/api/admin/archived-tickets',auth,adminOnly,async(req,res,next)=>{
 try{
  const t=(await db.query("SELECT t.id,t.title,t.created_at,t.deleted_at,t.deleted_by,o.name AS organization_name FROM tickets t LEFT JOIN organizations o ON o.id=t.organization_id WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 100")).rows;
  res.json({tickets:t.map(ticketView)});
 }catch(e){next(e);}
});
app.post('/api/admin/tickets/:id/restore',auth,adminOnly,longId,async(req,res,next)=>{
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const t=(await c.query("UPDATE tickets SET deleted_at=NULL,deleted_by=NULL WHERE id=$1 AND deleted_at IS NOT NULL RETURNING *",[req.params.id])).rows[0];
  if(!t){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono usuniętego zgłoszenia.');}
  await audit(c,t.id,req.user.id,'Przywrócono do aktywnego rejestru','Przywrócenie przez administratora');
  await c.query('COMMIT');
  res.json({ok:true,number:ticketNumber(t)});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
});
app.get('/api/tickets/:id',auth,longId,async(req,res,next)=>{
  try{
    const t=await getTicket(req.params.id);
    if(!canAccessTicket(t,req.user))return problem(res,404,'Nie znaleziono zgłoszenia.');
    const events=(await db.query('SELECT e.id,e.action,e.details,e.created_at,u.username AS author FROM ticket_events e LEFT JOIN users u ON e.actor_id=u.id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id',[t.id])).rows;
    const files=(await db.query('SELECT id,filename,mime,created_at,octet_length(content) AS size FROM attachments WHERE ticket_id=$1 ORDER BY id',[t.id])).rows;
    res.json({ticket:ticketView(t),events,files});
  }catch(e){next(e);}
});
app.post('/api/tickets/:id/events',auth,longId,async(req,res,next)=>{
  try{
    const t=await getTicket(req.params.id);
    if(!canAccessTicket(t,req.user))return problem(res,404,'Nie znaleziono zgłoszenia.');
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
    if(!canAccessTicket(t,req.user))return problem(res,404,'Nie znaleziono zgłoszenia.');
    if(!req.file)return problem(res,400,'Nie wybrano pliku.');
    const b=req.file.buffer, mime=req.file.mimetype;
    const jpg=b[0]===0xff && b[1]===0xd8 && b[2]===0xff;
    const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const pdf=b.subarray(0,5).toString()==='%PDF-';
    const webp=b.length>12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';
    const brand=b.length>=12?b.subarray(8,12).toString():'';
    const heic=b.length>=12&&b.subarray(4,8).toString()==='ftyp'&&['heic','heix','hevc','hevx','mif1','msf1'].includes(brand);
    const photo=(jpg&&mime==='image/jpeg')||(png&&mime==='image/png')||(webp&&mime==='image/webp')||(heic&&['image/heic','image/heif','application/octet-stream'].includes(mime));
    if(!(photo||(pdf&&mime==='application/pdf')))return problem(res,400,'Dozwolone są zdjęcia JPG, PNG, WebP, HEIC lub PDF do 5 MB.');
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
    const a=(await db.query('SELECT a.*,t.organization_id FROM attachments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=$1 AND t.deleted_at IS NULL',[req.params.id])).rows[0];
    if(!canAccessTicket(a,req.user))return problem(res,404,'Nie znaleziono pliku.');
    res.type(a.mime);res.set('Content-Disposition','attachment; filename="zalacznik-'+a.id+'.'+(a.mime==='application/pdf'?'pdf':a.mime==='image/jpeg'?'jpg':a.mime==='image/webp'?'webp':a.mime==='image/heic'||a.mime==='image/heif'?'heic':'png')+'"');res.send(a.content);
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
  doc.fontSize(9).fillColor('#6b899b').text(label,{continued:false});
  doc.fontSize(11).fillColor('#13455f').text(String(value??'—'),{width:500});
  doc.moveDown(.65);
}
function head(doc,title,subtitle){
 doc.rect(0,0,595,98).fill('#ffffff');
 doc.rect(0,93,595,5).fill('#ffd500');
 doc.fillColor('#009bd2').fontSize(24).text('MARK',45,24);
 doc.fillColor('#f2c900').fontSize(24).text('NET',116,24);
 doc.fillColor('#59809a').fontSize(9).text('SYSTEMY ZABEZPIECZEŃ',45,58);
 doc.fillColor('#137eae').fontSize(10).text('PANEL SERWISOWY / RAPORT',380,38,{width:175,align:'right'});
 doc.fillColor('#12425e').fontSize(17).text(title,45,123);
 doc.fontSize(10).fillColor('#6c8799').text(subtitle,45,154);
 doc.moveTo(45,174).lineTo(550,174).strokeColor('#c9e3ee').stroke();doc.y=190;
}
app.get('/api/tickets/:id/confirmation.pdf',auth,longId,async(req,res,next)=>{
 try{
  const t=await getTicket(req.params.id);
  if(!canAccessTicket(t,req.user))return problem(res,404,'Nie znaleziono zgłoszenia.');
  const pdf=await notifications.confirmation({
   ...t,requester_name:t.requester_name||t.author,requester_email:t.requester_email||'Nie podano'
  });
  res.type('application/pdf');res.set('Content-Disposition','attachment; filename="MarkNet-'+ticketNumber(t)+'.pdf"');res.send(pdf);
 }catch(e){next(e);}
});
app.get('/api/reports/tickets/:id.pdf',auth,adminOnly,async(req,res,next)=>{
  try{
    if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Niepoprawny identyfikator.');
    const t=await getTicket(req.params.id);if(!t)return problem(res,404,'Nie znaleziono zgłoszenia.');
    const ev=(await db.query('SELECT e.*,u.username FROM ticket_events e LEFT JOIN users u ON e.actor_id=u.id WHERE e.ticket_id=$1 ORDER BY e.created_at,e.id',[t.id])).rows;
    const doc=pdfStart(res,'raport-'+ticketNumber(t)+'.pdf');
    head(doc,'Protokół zgłoszenia '+ticketNumber(t),t.organization_name||'Klient');
    p(doc,'Temat',t.title);p(doc,'Rodzaj / priorytet',t.kind+' / '+t.priority);p(doc,'System / lokalizacja',t.category+' / '+(t.area||'nie podano'));p(doc,'Urządzenie',t.device||'nie podano');
    p(doc,'Zgłoszone',datePL(t.created_at)+' • '+t.author);p(doc,'Status',t.status);
    p(doc,'Pierwsza weryfikacja',datePL(t.acknowledged_at));p(doc,'Przyjazd na obiekt',datePL(t.on_site_at));
    p(doc,'Rozwiązano',datePL(t.resolved_at));p(doc,'Zamknięto',datePL(t.closed_at));
    p(doc,'Opis zgłoszenia',t.description);
    if(doc.y>645)doc.addPage();
    doc.fontSize(14).fillColor('#13455f').text('Historia zgłoszenia').moveDown(.4);
    for(const e of ev){p(doc,datePL(e.created_at)+' • '+(e.username||'system')+' • '+e.action,e.details||'—');}
    doc.moveDown();doc.fontSize(8).fillColor('#74838a').text('Raport wygenerowany automatycznie na podstawie danych zgłoszenia. Nie stanowi potwierdzenia wykonania prac, których nie odnotowano w historii.',{width:500});
    doc.end();
  }catch(e){next(e);}
});
app.get('/api/reports/month.pdf',auth,adminOnly,async(req,res,next)=>{
  try{
    const month=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return problem(res,400,'Wybierz miesiąc RRRR-MM.');
    const from=month+'-01', to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10);
    const orgId=/^[1-9]\d*$/.test(String(req.query.organization_id||''))?String(req.query.organization_id):null;
    const rows=(await db.query("SELECT t.*,u.username AS author,o.name AS organization_name FROM tickets t JOIN users u ON t.created_by=u.id LEFT JOIN organizations o ON o.id=t.organization_id WHERE t.created_at >= ($1::date AT TIME ZONE 'Europe/Warsaw') AND t.created_at < ($2::date AT TIME ZONE 'Europe/Warsaw') AND ($3::bigint IS NULL OR t.organization_id=$3) AND t.deleted_at IS NULL ORDER BY t.created_at",[from,to,orgId])).rows;
    const headingOrg=orgId?(await db.query('SELECT name FROM organizations WHERE id=$1',[orgId])).rows[0]?.name||'Klient':'Wszyscy klienci';
    const doc=pdfStart(res,'raport-miesieczny-'+month+'.pdf');
    head(doc,'Raport miesięczny • '+month,headingOrg);
    const by=(key)=>Object.entries(rows.reduce((a,t)=>(a[t[key]]=(a[t[key]]||0)+1,a),{})).map(([k,n])=>k+': '+n).join('  |  ')||'brak';
    p(doc,'Liczba nowych zgłoszeń',rows.length);
    p(doc,'Według rodzaju',by('kind'));p(doc,'Według priorytetu',by('priority'));p(doc,'Według aktualnego statusu',by('status'));
    p(doc,'Według systemu',by('category'));
    const response=rows.filter(x=>x.acknowledged_at).map(x=>(new Date(x.acknowledged_at)-new Date(x.created_at))/60000);
    p(doc,'Średni czas do odnotowanej weryfikacji',response.length?(response.reduce((a,b)=>a+b,0)/response.length).toFixed(0)+' minut ('+response.length+' zgłoszeń)':'brak danych');
    if(doc.y>630)doc.addPage();
    doc.fontSize(14).fillColor('#13455f').text('Rejestr zgłoszeń').moveDown(.3);
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
    const orgId=/^[1-9]\d*$/.test(String(req.query.organization_id||''))?String(req.query.organization_id):null;
    const rows=(await db.query("SELECT t.*,o.name AS organization_name FROM tickets t LEFT JOIN organizations o ON o.id=t.organization_id WHERE t.created_at >= ($1::date AT TIME ZONE 'Europe/Warsaw') AND t.created_at < ($2::date AT TIME ZONE 'Europe/Warsaw') AND ($3::bigint IS NULL OR t.organization_id=$3) AND t.deleted_at IS NULL ORDER BY t.created_at",[from,to,orgId])).rows;
    const val=(v)=>{let x=String(v??'');if(/^[=+@-]/.test(x))x="'"+x;return '"'+x.replace(/"/g,'""')+'"';};
    const columns=['Numer','Klient','Data','Rodzaj','Priorytet','System','Temat','Miejsce','Urządzenie','Status','Weryfikacja','Przyjazd','Rozwiązanie'];
    const data=rows.map(t=>[ticketNumber(t),t.organization_name||'',datePL(t.created_at),t.kind,t.priority,t.category,t.title,t.area,t.device,t.status,datePL(t.acknowledged_at),datePL(t.on_site_at),datePL(t.resolved_at)]);
    res.type('text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="zgloszenia-'+month+'.csv"');
    res.send('\ufeff'+[columns,...data].map(r=>r.map(val).join(';')).join('\r\n'));
  }catch(e){next(e);}
});
async function sendWebPush(userId,payload){
  if(!pushConfigured)throw new Error('Push requires VAPID configuration');
  const items=(await db.query('SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=$1',[userId])).rows;
  if(!items.length)throw new Error('Brak aktywnej subskrypcji powiadomień na telefonie');
  let successes=0;
  for(const item of items){
    try {
      await webpush.sendNotification({endpoint:item.endpoint,keys:{p256dh:item.p256dh,auth:item.auth}},JSON.stringify(payload),{TTL:3600,urgency:payload.critical?'high':'normal'});
      successes++;
    }catch(e) {
      if(e.statusCode===404||e.statusCode===410)await db.query('DELETE FROM push_subscriptions WHERE id=$1',[item.id]);
      else console.warn('Web push delivery failed',e.statusCode||'unknown');
    }
  }
  if(!successes)throw new Error('Nie udało się dostarczyć powiadomienia web push');
  return successes;
}
app.get('/api/push/public-key',auth,adminOnly,(req,res)=>{
  if(!pushConfigured)return problem(res,503,'Powiadomienia web push nie są skonfigurowane.');
  res.json({publicKey:process.env.VAPID_PUBLIC_KEY});
});
app.post('/api/push/subscribe',auth,adminOnly,async(req,res,next)=>{
 try{
  const sub=req.body?.subscription||req.body;
  const endpoint=sub?.endpoint, p256dh=sub?.keys?.p256dh, authKey=sub?.keys?.auth;
  if(typeof endpoint!=='string'||endpoint.length>2048||!endpoint.startsWith('https://')||
    typeof p256dh!=='string'||p256dh.length<40||p256dh.length>512||typeof authKey!=='string'||authKey.length<8||authKey.length>512)
    return problem(res,400,'Nieprawidłowa subskrypcja.');
  await db.query('INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=now()',[req.user.id,endpoint,p256dh,authKey]);
  res.status(201).json({ok:true});
 }catch(e){next(e);}
});
app.post('/api/push/test',auth,adminOnly,async(req,res,next)=>{
 try{
  const count=await sendWebPush(req.user.id,{title:'MarkNet Serwis',body:'Powiadomienia na telefonie działają.',url:'/serwis/',critical:false,tag:'marknet-push-test'});
  res.json({ok:true,delivered:count});
 }catch(e){return problem(res,503,'Nie udało się wysłać próbnego powiadomienia. Sprawdź instalację aplikacji i zgodę na powiadomienia.');}
});
async function phoneAlertForTicket(t){
  const title=t.priority==='Krytyczny'?'PILNE: nowe zgłoszenie MarkNet':'Nowe zgłoszenie MarkNet';
  const payload={title,body:ticketNumber(t)+' • '+t.category,url:'/serwis/',critical:t.priority==='Krytyczny',tag:'ticket-'+t.id};
  try{
    const admins=(await db.query("SELECT id FROM users WHERE role='admin'")).rows;
    let successful=0;
    for(const admin of admins)try{successful+=await sendWebPush(admin.id,payload);}catch{}
    if(successful)return successful;
  }catch(e){console.warn('Web push query failed:',e.message);}
  if(notifications.phoneReady())return notifications.mobileAlert(t);
  throw new Error('Brak aktywnej subskrypcji web push lub Telegram');
}
async function deliverNotifications(){
  const result=await db.query("SELECT j.id AS notification_job_id,j.kind AS notification_kind,j.attempt_count,t.*,u.username AS author,o.name AS organization_name FROM notification_jobs j JOIN tickets t ON t.id=j.ticket_id JOIN users u ON u.id=t.created_by LEFT JOIN organizations o ON o.id=t.organization_id WHERE j.status='pending' AND j.retry_at<=now() AND t.deleted_at IS NULL ORDER BY j.id LIMIT 12");
  for(const job of result.rows){
    try{
      if(job.notification_kind==='confirmation')await notifications.emailConfirmation(job);
      if(job.notification_kind==='admin_email')await notifications.adminEmail(job);
      if(job.notification_kind==='phone')await phoneAlertForTicket(job);
      await db.query("UPDATE notification_jobs SET status='delivered',delivered_at=now(),last_error=NULL WHERE id=$1",[job.notification_job_id]);
      console.info('Notification delivered:',job.notification_kind,job.notification_job_id);
    }catch(e){
      const delay=Math.min(3600,Math.pow(2,Math.min(8,job.attempt_count))*30);
      await db.query("UPDATE notification_jobs SET attempt_count=attempt_count+1,retry_at=now()+($2::int*interval '1 second'),last_error=$3 WHERE id=$1",[job.notification_job_id,delay,String(e.message||e).slice(0,350)]);
      console.warn('Notification pending retry:',job.notification_kind,job.notification_job_id,String(e.message||e).slice(0,100));
    }
  }
}
let delivering=false;
async function runNotificationJobs(){if(delivering)return;delivering=true;try{await deliverNotifications();}catch(e){console.error('Notification queue error',e.message);}finally{delivering=false;}}
app.post('/api/admin/notifications/test-email',auth,adminOnly,async(req,res,next)=>{
 try{if(!notifications.smtpReady())return problem(res,503,'Brak hasła SMTP w konfiguracji Render.');
  await notifications.testEmail();res.json({ok:true});
 }catch(e){console.warn('SMTP test failed',e.message);return problem(res,503,'Test wysyłki e-mail nie powiódł się. Sprawdź hasło aplikacji i ustawienia konta.');}
});
app.get('/api/admin/notifications',auth,adminOnly,async(req,res,next)=>{
 try{
  const jobs=await db.query("SELECT j.id,j.ticket_id,j.kind,j.status,j.attempt_count,j.delivered_at,j.last_error,j.retry_at FROM notification_jobs j ORDER BY j.id DESC LIMIT 100");
  const phone=(await db.query("SELECT count(*)::int AS subscribed FROM push_subscriptions p JOIN users u ON u.id=p.user_id WHERE u.role='admin' AND u.is_active=true")).rows[0];
  res.json({jobs:jobs.rows,configured:{email:notifications.smtpReady(),phone:(pushConfigured&&phone.subscribed>0)||notifications.phoneReady(),push_subscriptions:phone.subscribed}});
 }catch(e){next(e);}
});
setupTenancy(app,{db,categories,auth,adminOnly,hashPassword,clean,problem,longId});
app.post('/api/admin/users/:id/reset-password',auth,adminOnly,longId,async(req,res,next)=>{
 try{
  const password=typeof req.body?.newPassword==='string'?req.body.newPassword:'';
  if(password.length<8||password.length>128)return problem(res,400,'Hasło musi mieć od 8 do 128 znaków.');
  const u=(await db.query("SELECT id,username FROM users WHERE id=$1 AND role='client' AND deleted_at IS NULL",[req.params.id])).rows[0];
  if(!u)return problem(res,404,'Konto klienta nie istnieje.');
  const h=hashPassword(password);
  await db.query('UPDATE users SET pass_hash=$1,pass_salt=$2 WHERE id=$3',[h.hash,h.salt,u.id]);
  await db.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
  res.json({ok:true,username:u.username});
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
if(CONFIGURED) init().then(()=>app.listen(process.env.PORT||10000,'0.0.0.0',()=>{console.log('Service portal ready');setInterval(runNotificationJobs,process.env.NODE_ENV==='test'?250:15000).unref();runNotificationJobs();})).catch(e=>{console.error('Database initialization failed',e.message);process.exit(1);});
else app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Service portal in setup mode'));

