'use strict';
const crypto=require('crypto');

function setupTenancy(app,{db,categories,auth,adminOnly,hashPassword,clean,problem,longId,issueInvitation}){
  const name=(v,max=140)=>clean(v,max);
  function passwordValid(s){return typeof s==='string'&&s.length>=8&&s.length<=128;}
  function emailValue(v){return typeof v==='string'?v.trim().toLowerCase():'';}
  function validEmail(v){return v.length<=254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);}
  function usernameValid(s){return /^[a-z0-9][a-z0-9._-]{2,49}$/.test(s);}
  function validServices(items){return Array.isArray(items)&&items.length>0&&items.length<=categories.length&&items.every(x=>categories.includes(x))&&new Set(items).size===items.length;}
  function orgId(v){return /^[1-9]\d*$/.test(String(v||''))?String(v):null;}
  const profileKeys=['address','nip','regon','krs','contact_name','contact_role','contact_email','contact_phone','contact_mobile'];
  function profileFrom(body){
    if(body?.profile===undefined)return null;
    if(!body.profile||typeof body.profile!=='object'||Array.isArray(body.profile))return false;
    const x={};
    for(const k of profileKeys)x[k]=name(body.profile[k],k==='address'?250:120);
    if(x.contact_email&&!validEmail(x.contact_email))return false;
    return x;
  }
  function err(res,e,kind){
    if(e.code==='23505')return problem(res,409,kind==='user'?'Ten login jest już zajęty.':'Klient o tej nazwie już istnieje.');
    return null;
  }
  app.get('/api/admin/organizations',auth,adminOnly,async(req,res,next)=>{
    try{
      const rows=(await db.query("SELECT o.id,o.name,o.is_active,o.created_at, COALESCE((SELECT json_agg(s.category ORDER BY s.category) FROM organization_systems s WHERE s.organization_id=o.id),'[]'::json) AS systems, (SELECT count(*)::int FROM users u WHERE u.organization_id=o.id AND u.deleted_at IS NULL) AS users_count FROM organizations o ORDER BY o.name")).rows;
      res.json({organizations:rows,categories});
    }catch(e){next(e);}
  });
  app.post('/api/admin/organizations',auth,adminOnly,async(req,res,next)=>{
    const label=name(req.body?.name),systems=req.body?.systems,profile=profileFrom(req.body);
    if(label.length<3||!validServices(systems)||profile===false)return problem(res,400,'Podaj nazwę klienta, obsługiwane systemy i poprawne dane kontaktowe.');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const o=(await c.query('INSERT INTO organizations(name,profile) VALUES($1,$2::jsonb) RETURNING *',[label,JSON.stringify(profile||{})])).rows[0];
      for(const sys of systems)await c.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2)',[o.id,sys]);
      await c.query('COMMIT');res.status(201).json({organization:o});
    }catch(e){await c.query('ROLLBACK');if(!err(res,e,'organization'))next(e);}
    finally{c.release();}
  });
  app.patch('/api/admin/organizations/:id',auth,adminOnly,longId,async(req,res,next)=>{
    const label=name(req.body?.name),systems=req.body?.systems,profile=profileFrom(req.body);
    const enabled=req.body?.is_active;
    if(label.length<3||!validServices(systems)||typeof enabled!=='boolean'||profile===false)return problem(res,400,'Podaj nazwę klienta, systemy, poprawne dane kontaktowe i stan aktywności.');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const o=(await c.query('UPDATE organizations SET name=$1,is_active=$2,profile=COALESCE($3::jsonb,profile) WHERE id=$4 RETURNING *',[label,enabled,profile?JSON.stringify(profile):null,req.params.id])).rows[0];
      if(!o){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono klienta.');}
      await c.query('DELETE FROM organization_systems WHERE organization_id=$1',[o.id]);
      for(const sys of systems)await c.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2)',[o.id,sys]);
      await c.query('COMMIT');res.json({organization:o});
    }catch(e){await c.query('ROLLBACK');if(!err(res,e,'organization'))next(e);}
    finally{c.release();}
  });
  app.get('/api/admin/users',auth,adminOnly,async(req,res,next)=>{
    try{
      const users=(await db.query("SELECT u.id,u.username,u.email,u.first_name,u.last_name,u.role,u.is_active,u.must_set_password,u.organization_id,o.name AS organization_name,u.created_at,(SELECT i.status FROM user_invitations i WHERE i.user_id=u.id ORDER BY i.id DESC LIMIT 1) AS invitation_status,(SELECT i.expires_at FROM user_invitations i WHERE i.user_id=u.id ORDER BY i.id DESC LIMIT 1) AS invitation_expires_at FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE u.deleted_at IS NULL ORDER BY u.role,u.username")).rows;
      res.json({users});
    }catch(e){next(e);}
  });
  app.post('/api/admin/users',auth,adminOnly,async(req,res,next)=>{
    const login=name(req.body?.username,50).toLowerCase();
    const email=emailValue(req.body?.email),firstName=name(req.body?.first_name,80),lastName=name(req.body?.last_name,80);
    const company=orgId(req.body?.organization_id);
    if(!usernameValid(login)||!company||!validEmail(email)||firstName.length<2||lastName.length<2)
      return problem(res,400,'Podaj login, imię, nazwisko, adres e-mail i klienta.');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const org=(await client.query('SELECT id FROM organizations WHERE id=$1 AND is_active=true',[company])).rows[0];
      if(!org){await client.query('ROLLBACK');return problem(res,400,'Wybierz aktywnego klienta.');}
      const initial=hashPassword(crypto.randomBytes(48).toString('base64url'));
      const u=(await client.query(
        "INSERT INTO users(username,email,first_name,last_name,role,pass_salt,pass_hash,organization_id,is_active,must_set_password) "+
        "VALUES($1,$2,$3,$4,'client',$5,$6,$7,true,true) "+
        "RETURNING id,username,email,first_name,last_name,role,organization_id,is_active,must_set_password,created_at",
        [login,email,firstName,lastName,initial.salt,initial.hash,company])).rows[0];
      const invitation=await issueInvitation(client,u.id,email);
      await client.query('COMMIT');
      res.status(201).json({user:u,invitation:{status:invitation.status,expires_at:invitation.expires_at}});
    }catch(e){
      await client.query('ROLLBACK');
      if(!err(res,e,'user'))next(e);
    }finally{client.release();}
  });
  app.delete('/api/admin/users/:id',auth,adminOnly,longId,async(req,res,next)=>{
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const u=(await c.query("UPDATE users SET deleted_at=now(),is_active=false WHERE id=$1 AND role='client' AND deleted_at IS NULL RETURNING id,username",[req.params.id])).rows[0];
      if(!u){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono konta użytkownika.');}
      await c.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
      await c.query('COMMIT');
      res.json({ok:true,username:u.username});
    }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
  });
  app.patch('/api/admin/users/:id',auth,adminOnly,longId,async(req,res,next)=>{
    const active=req.body?.is_active,company=orgId(req.body?.organization_id),email=emailValue(req.body?.email),firstName=name(req.body?.first_name,80),lastName=name(req.body?.last_name,80);
    if(typeof active!=='boolean'||!company||!validEmail(email)||firstName.length<2||lastName.length<2)
      return problem(res,400,'Wybierz klienta, imię i nazwisko, poprawny e-mail oraz stan konta.');
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const org=(await client.query('SELECT id,is_active FROM organizations WHERE id=$1',[company])).rows[0];
      if(!org){await client.query('ROLLBACK');return problem(res,400,'Nie znaleziono klienta.');}
      const previous=(await client.query("SELECT * FROM users WHERE id=$1 AND role='client' AND deleted_at IS NULL FOR UPDATE",[req.params.id])).rows[0];
      if(!previous){await client.query('ROLLBACK');return problem(res,404,'Nie znaleziono konta klienta.');}
      const changedCritical=String(previous.organization_id)!==String(company)||previous.email!==email||previous.is_active!==active;
      const u=(await client.query(
        "UPDATE users SET organization_id=$1,is_active=$2,email=$3,first_name=$4,last_name=$5 "+
        "WHERE id=$6 AND role='client' AND deleted_at IS NULL "+
        "RETURNING id,username,email,first_name,last_name,organization_id,is_active,must_set_password",
        [company,active,email,firstName,lastName,req.params.id])).rows[0];
      if(changedCritical){
        await client.query("UPDATE user_invitations SET status='cancelled' WHERE user_id=$1 AND status IN ('pending','sent')",[u.id]);
        if(u.must_set_password&&active&&org.is_active)await issueInvitation(client,u.id,email);
      }
      await client.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
      await client.query('COMMIT');
      res.json({user:u,invitation_queued:changedCritical&&u.must_set_password&&active&&org.is_active});
    }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
  });
}

async function migrateTenancy(db,categories){
  await db.query("CREATE TABLE IF NOT EXISTS organizations (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,is_active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.query("CREATE TABLE IF NOT EXISTS organization_systems (organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,category TEXT NOT NULL,PRIMARY KEY(organization_id,category))");
  await db.query("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb");
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id)');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id)');
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id)');
  const paprec=(await db.query("INSERT INTO organizations(name) VALUES('PAPREC Energies Gdańsk') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id")).rows[0];
  const serviceCount=(await db.query('SELECT count(*)::int AS n FROM organization_systems WHERE organization_id=$1',[paprec.id])).rows[0].n;
  if(serviceCount===0){
    for(const category of categories)
      await db.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2) ON CONFLICT DO NOTHING',[paprec.id,category]);
  }
  await db.query("UPDATE users SET organization_id=$1 WHERE role='client' AND username='paprec' AND organization_id IS NULL",[paprec.id]);
  await db.query("UPDATE tickets t SET organization_id=u.organization_id FROM users u WHERE t.created_by=u.id AND t.organization_id IS NULL AND u.organization_id IS NOT NULL");
  await db.query("UPDATE tickets SET organization_id=$1 WHERE organization_id IS NULL AND organization='client'",[paprec.id]);
  await db.query('CREATE INDEX IF NOT EXISTS tickets_tenant_idx ON tickets(organization_id,created_at DESC) WHERE deleted_at IS NULL');
  await db.query('CREATE INDEX IF NOT EXISTS tickets_deleted_idx ON tickets(deleted_at DESC) WHERE deleted_at IS NOT NULL');
}

module.exports={setupTenancy,migrateTenancy};
