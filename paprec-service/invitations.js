'use strict';
const crypto=require('crypto');

const APP_URL='https://marknet.com.pl/serwis/';
const expiresHours=72;
const key=crypto.createHash('sha256').update('marknet-service-invitations-v1|'+(process.env.INIT_ADMIN_PASSWORD||'')).digest();
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const validEmail=email=>typeof email==='string'&&email.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
const tokenPattern=/^[a-f0-9]{64}$/;

function secretFor(token){
 const iv=crypto.randomBytes(12);
 const enc=crypto.createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([enc.update(token,'utf8'),enc.final()]);
 return {ciphertext:ciphertext.toString('hex'),iv:iv.toString('hex'),tag:enc.getAuthTag().toString('hex')};
}
function decodeSecret(row){
 const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(row.iv,'hex'));
 d.setAuthTag(Buffer.from(row.tag,'hex'));
 return Buffer.concat([d.update(Buffer.from(row.ciphertext,'hex')),d.final()]).toString('utf8');
}
async function migrateInvitations(db){
 await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_set_password BOOLEAN NOT NULL DEFAULT false');
 await db.query("CREATE TABLE IF NOT EXISTS user_invitations (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_email TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,ciphertext TEXT NOT NULL,iv TEXT NOT NULL,tag TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','accepted','cancelled','expired')),attempt_count INT NOT NULL DEFAULT 0,retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '72 hours',delivered_at TIMESTAMPTZ,last_error TEXT)");
 await db.query("CREATE INDEX IF NOT EXISTS user_invitations_due ON user_invitations(retry_at,id) WHERE status='pending'");
 await db.query("CREATE INDEX IF NOT EXISTS user_invitations_user ON user_invitations(user_id,id DESC)");
}
async function issueInvitation(client,userId,email){
 if(!validEmail(email))throw Error('Niepoprawny adres e-mail zaproszenia.');
 const token=crypto.randomBytes(32).toString('hex');
 const encrypted=secretFor(token);
 await client.query("UPDATE user_invitations SET status='cancelled' WHERE user_id=$1 AND status IN ('pending','sent')",[userId]);
 const invitation=(await client.query(
 "INSERT INTO user_invitations(user_id,recipient_email,token_hash,ciphertext,iv,tag) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,expires_at",
 [userId,email,digest(token),encrypted.ciphertext,encrypted.iv,encrypted.tag])).rows[0];
 return {status:'pending',id:invitation.id,expires_at:invitation.expires_at};
}
async function sendPendingInvitations(db,notifications){
 await db.query("UPDATE user_invitations SET status='expired' WHERE status IN ('pending','sent') AND expires_at<=now()");
 const rows=(await db.query(
 "SELECT i.*,u.username,u.first_name,u.last_name,o.name AS organization_name FROM user_invitations i "+
 "JOIN users u ON u.id=i.user_id JOIN organizations o ON o.id=u.organization_id "+
 "WHERE i.status='pending' AND i.retry_at<=now() AND i.expires_at>now() AND u.is_active=true AND u.deleted_at IS NULL AND u.must_set_password=true AND o.is_active=true ORDER BY i.id LIMIT 12")).rows;
 for(const row of rows){
  try{
   const token=decodeSecret(row);
   const url=APP_URL+'?aktywacja='+token;
   await notifications.welcomeUser({
     email:row.recipient_email,username:row.username,first_name:row.first_name,last_name:row.last_name,
     organization_name:row.organization_name,activation_url:url,expiresHours
   });
   await db.query("UPDATE user_invitations SET status='sent',delivered_at=now(),last_error=NULL WHERE id=$1 AND status='pending'",[row.id]);
   console.info('User invitation delivered:',row.id);
  }catch(e){
   const delay=Math.min(1800,30*2**Math.min(row.attempt_count,6));
   await db.query("UPDATE user_invitations SET attempt_count=attempt_count+1,retry_at=now()+($2::int*interval '1 second'),last_error=$3 WHERE id=$1 AND status='pending'",[row.id,delay,String(e.message||e).slice(0,350)]);
   console.warn('Invitation retry scheduled:',row.id,String(e.message||e).slice(0,100));
  }
 }
}
function setupInvitationRoutes(app,{db,auth,adminOnly,hashPassword,problem,longId}){
 app.post('/api/activate',async(req,res,next)=>{
  const token=typeof req.body?.token==='string'?req.body.token:'';
  const password=typeof req.body?.password==='string'?req.body.password:'';
  const repeat=typeof req.body?.confirmPassword==='string'?req.body.confirmPassword:'';
  if(!tokenPattern.test(token)||password.length<8||password.length>128||password!==repeat)
   return problem(res,400,'Podaj poprawny link aktywacyjny i dwa identyczne hasła (minimum 8 znaków).');
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const row=(await client.query(
    "SELECT i.id,i.status,i.expires_at,u.id AS user_id,u.username,u.is_active,u.deleted_at,u.must_set_password,o.is_active AS organization_active "+
    "FROM user_invitations i JOIN users u ON u.id=i.user_id JOIN organizations o ON o.id=u.organization_id "+
    "WHERE i.token_hash=$1 FOR UPDATE OF i",[digest(token)])).rows[0];
   if(!row||!['pending','sent'].includes(row.status)||new Date(row.expires_at).valueOf()<=Date.now()||
       !row.is_active||row.deleted_at||!row.organization_active||!row.must_set_password){
    await client.query('ROLLBACK');return problem(res,410,'Link aktywacyjny wygasł lub został już użyty. Skontaktuj się z administratorem MarkNet.');
   }
   const h=hashPassword(password);
   await client.query('UPDATE users SET pass_hash=$1,pass_salt=$2,must_set_password=false WHERE id=$3',[h.hash,h.salt,row.user_id]);
   await client.query("UPDATE user_invitations SET status='accepted' WHERE id=$1",[row.id]);
   await client.query("UPDATE user_invitations SET status='cancelled' WHERE user_id=$1 AND id<>$2 AND status IN ('pending','sent')",[row.user_id,row.id]);
   await client.query('DELETE FROM sessions WHERE user_id=$1',[row.user_id]);
   await client.query('COMMIT');
   res.json({ok:true,username:row.username});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
 });
 app.post('/api/admin/users/:id/invite',auth,adminOnly,longId,async(req,res,next)=>{
  const client=await db.connect();
  try{
   await client.query('BEGIN');
   const user=(await client.query(
    "SELECT u.id,u.email,u.must_set_password,u.is_active,u.deleted_at,o.is_active AS org_active "+
    "FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1 AND u.role='client' FOR UPDATE OF u",[req.params.id])).rows[0];
   if(!user||user.deleted_at)return problemRollback(client,res,404,'Nie znaleziono użytkownika.');
   if(!user.is_active||!user.org_active)return problemRollback(client,res,409,'Najpierw aktywuj konto i firmę.');
   if(!user.must_set_password)return problemRollback(client,res,409,'To konto zostało już aktywowane. W razie potrzeby użyj zmiany hasła.');
   const invite=await issueInvitation(client,user.id,user.email);
   await client.query('COMMIT');
   res.json({ok:true,invitation:invite});
  }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
 });
 async function problemRollback(client,res,status,message){await client.query('ROLLBACK');return problem(res,status,message);}
}
module.exports={migrateInvitations,issueInvitation,sendPendingInvitations,setupInvitationRoutes};
