'use strict';

function setupTenancy(app,{db,categories,auth,adminOnly,hashPassword,clean,problem,longId}){
  const name=(v,max=140)=>clean(v,max);
  function passwordValid(s){return typeof s==='string'&&s.length>=8&&s.length<=128;}
  function usernameValid(s){return /^[a-z0-9][a-z0-9._-]{2,49}$/.test(s);}
  function validServices(items){return Array.isArray(items)&&items.length>0&&items.length<=categories.length&&items.every(x=>categories.includes(x))&&new Set(items).size===items.length;}
  function orgId(v){return /^[1-9]\d*$/.test(String(v||''))?String(v):null;}
  function err(res,e,kind){
    if(e.code==='23505')return problem(res,409,kind==='user'?'Ten login jest już zajęty.':'Klient o tej nazwie już istnieje.');
    return null;
  }
  app.get('/api/admin/organizations',auth,adminOnly,async(req,res,next)=>{
    try{
      const rows=(await db.query("SELECT o.id,o.name,o.is_active,o.created_at, COALESCE((SELECT json_agg(s.category ORDER BY s.category) FROM organization_systems s WHERE s.organization_id=o.id),'[]'::json) AS systems, (SELECT count(*)::int FROM users u WHERE u.organization_id=o.id) AS users_count FROM organizations o ORDER BY o.name")).rows;
      res.json({organizations:rows,categories});
    }catch(e){next(e);}
  });
  app.post('/api/admin/organizations',auth,adminOnly,async(req,res,next)=>{
    const label=name(req.body?.name),systems=req.body?.systems;
    if(label.length<3||!validServices(systems))return problem(res,400,'Podaj nazwę klienta oraz co najmniej jeden obsługiwany system.');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const o=(await c.query('INSERT INTO organizations(name) VALUES($1) RETURNING *',[label])).rows[0];
      for(const sys of systems)await c.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2)',[o.id,sys]);
      await c.query('COMMIT');res.status(201).json({organization:o});
    }catch(e){await c.query('ROLLBACK');if(!err(res,e,'organization'))next(e);}
    finally{c.release();}
  });
  app.patch('/api/admin/organizations/:id',auth,adminOnly,longId,async(req,res,next)=>{
    const label=name(req.body?.name),systems=req.body?.systems;
    const enabled=req.body?.is_active;
    if(label.length<3||!validServices(systems)||typeof enabled!=='boolean')return problem(res,400,'Podaj nazwę klienta, systemy i stan aktywności.');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const o=(await c.query('UPDATE organizations SET name=$1,is_active=$2 WHERE id=$3 RETURNING *',[label,enabled,req.params.id])).rows[0];
      if(!o){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono klienta.');}
      await c.query('DELETE FROM organization_systems WHERE organization_id=$1',[o.id]);
      for(const sys of systems)await c.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2)',[o.id,sys]);
      await c.query('COMMIT');res.json({organization:o});
    }catch(e){await c.query('ROLLBACK');if(!err(res,e,'organization'))next(e);}
    finally{c.release();}
  });
  app.get('/api/admin/users',auth,adminOnly,async(req,res,next)=>{
    try{
      const users=(await db.query("SELECT u.id,u.username,u.role,u.is_active,u.organization_id,o.name AS organization_name,u.created_at FROM users u LEFT JOIN organizations o ON o.id=u.organization_id ORDER BY u.role,u.username")).rows;
      res.json({users});
    }catch(e){next(e);}
  });
  app.post('/api/admin/users',auth,adminOnly,async(req,res,next)=>{
    const login=name(req.body?.username,50).toLowerCase();
    const password=req.body?.password;
    const company=orgId(req.body?.organization_id);
    if(!usernameValid(login)||!passwordValid(password)||!company)return problem(res,400,'Podaj login (3–50 znaków), hasło (minimum 8 znaków) i klienta.');
    try{
      const org=(await db.query('SELECT id FROM organizations WHERE id=$1 AND is_active=true',[company])).rows[0];
      if(!org)return problem(res,400,'Wybierz aktywnego klienta.');
      const h=hashPassword(password);
      const u=(await db.query("INSERT INTO users(username,role,pass_salt,pass_hash,organization_id,is_active) VALUES($1,'client',$2,$3,$4,true) RETURNING id,username,role,organization_id,is_active,created_at",[login,h.salt,h.hash,company])).rows[0];
      res.status(201).json({user:u});
    }catch(e){if(!err(res,e,'user'))next(e);}
  });
  app.patch('/api/admin/users/:id',auth,adminOnly,longId,async(req,res,next)=>{
    const active=req.body?.is_active,company=orgId(req.body?.organization_id);
    if(typeof active!=='boolean'||!company)return problem(res,400,'Wybierz klienta i stan konta.');
    try{
      const org=(await db.query('SELECT id FROM organizations WHERE id=$1',[company])).rows[0];
      if(!org)return problem(res,400,'Nie znaleziono klienta.');
      const u=(await db.query("UPDATE users SET organization_id=$1,is_active=$2 WHERE id=$3 AND role='client' RETURNING id,username,organization_id,is_active",[company,active,req.params.id])).rows[0];
      if(!u)return problem(res,404,'Nie znaleziono konta klienta.');
      await db.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);
      res.json({user:u});
    }catch(e){next(e);}
  });
}

async function migrateTenancy(db,categories){
  await db.query("CREATE TABLE IF NOT EXISTS organizations (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,is_active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.query("CREATE TABLE IF NOT EXISTS organization_systems (organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,category TEXT NOT NULL,PRIMARY KEY(organization_id,category))");
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id)');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true');
  await db.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id)');
  const paprec=(await db.query("INSERT INTO organizations(name) VALUES('PAPREC Energies Gdańsk') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id")).rows[0];
  for(const category of categories)
    await db.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2) ON CONFLICT DO NOTHING',[paprec.id,category]);
  await db.query("UPDATE users SET organization_id=$1 WHERE role='client' AND username='paprec' AND organization_id IS NULL",[paprec.id]);
  await db.query("UPDATE tickets t SET organization_id=u.organization_id FROM users u WHERE t.created_by=u.id AND t.organization_id IS NULL AND u.organization_id IS NOT NULL");
  await db.query("UPDATE tickets SET organization_id=$1 WHERE organization_id IS NULL AND organization='client'",[paprec.id]);
  await db.query('CREATE INDEX IF NOT EXISTS tickets_tenant_idx ON tickets(organization_id,created_at DESC)');
}

module.exports={setupTenancy,migrateTenancy};
