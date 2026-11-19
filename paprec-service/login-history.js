'use strict';

const MAX_DAYS=90;
async function migrateLoginHistory(db){
 await db.query("CREATE TABLE IF NOT EXISTS login_history (id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,username TEXT NOT NULL,organization_id BIGINT,organization_name TEXT,role TEXT NOT NULL,success BOOLEAN NOT NULL,ip_address TEXT,user_agent TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
 await db.query('CREATE INDEX IF NOT EXISTS login_history_recent ON login_history(created_at DESC,id DESC)');
 await db.query('CREATE INDEX IF NOT EXISTS login_history_user_recent ON login_history(user_id,created_at DESC)');
 await purgeLoginHistory(db);
}
async function purgeLoginHistory(db){
 await db.query("DELETE FROM login_history WHERE created_at<now()-interval '90 days'");
}
async function recordLogin(db,req,user,success){
 if(!user||!user.id)return;
 const ip=String(req.ip||'').slice(0,64);
 const agent=String(req.get('user-agent')||'').slice(0,255);
 try{
  await db.query(
   'INSERT INTO login_history(user_id,username,organization_id,organization_name,role,success,ip_address,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [user.id,user.username,user.organization_id||null,user.organization_name|| (user.role==='admin'?'MarkNet':null),user.role,success,ip,agent]
  );
 }catch(e){
  console.warn('Login audit unavailable:',String(e.message||'error').slice(0,90));
 }
}
function setupLoginHistoryRoutes(app,{db,auth,adminOnly,problem}){
 app.get('/api/admin/login-history',auth,adminOnly,async(req,res,next)=>{
  const limit=Math.min(200,Math.max(1,Number.parseInt(String(req.query.limit||'100'),10)||100));
  const result=String(req.query.result||'');
  const userId=String(req.query.user_id||'');
  const companyId=String(req.query.organization_id||'');
  if(result&&!['success','failure'].includes(result))
   return problem(res,400,'Niepoprawny filtr wyników logowania.');
  if(userId&&!/^[1-9]\d*$/.test(userId))
   return problem(res,400,'Niepoprawny identyfikator użytkownika.');
  if(companyId&&!/^[1-9]\d*$/.test(companyId))
   return problem(res,400,'Niepoprawny identyfikator firmy.');
  try{
   const where=["created_at>=now()-interval '90 days'"];
   const args=[];
   if(userId){args.push(userId);where.push('user_id=$'+args.length);}
   if(companyId){args.push(companyId);where.push('organization_id=$'+args.length);}
   if(result){args.push(result==='success');where.push('success=$'+args.length);}
   args.push(limit);
   const rows=(await db.query(
    'SELECT id,user_id,username,organization_id,organization_name,role,success,ip_address,user_agent,created_at FROM login_history '+
    'WHERE '+where.join(' AND ')+' ORDER BY created_at DESC,id DESC LIMIT $'+args.length,args
   )).rows;
   res.json({entries:rows,retention_days:MAX_DAYS});
  }catch(e){next(e);}
 });
}
module.exports={migrateLoginHistory,purgeLoginHistory,recordLogin,setupLoginHistoryRoutes};
