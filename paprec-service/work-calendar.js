'use strict';
// Terminarz prac MIWIPOL — oddzielony od zgłoszeń awarii.
const {migrateWorkReports,setupWorkReports}=require('./work-calendar-reports');
const ORGANIZATION='MIWIPOL';
const STATES=['Zaplanowane','W trakcie','Wykonane','Odwołane'];
function validDate(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;
  const d=new Date(v+'T12:00:00Z');
  return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v&&v>='2020-01-01'&&v<='2100-12-31';
}
function validTime(v){return v===null||v===''||(typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v));}
function payload(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  const title=typeof body.title==='string'?body.title.trim():'';
  const address=typeof body.address==='string'?body.address.trim():'';
  const notes=typeof body.notes==='string'?body.notes.trim():'';
  const work_date=body.work_date;
  const start_time=body.start_time||null;
  const end_time=body.end_time||null;
  const status=body.status||'Zaplanowane';
  if(title.length<3||title.length>140||address.length<3||address.length>240||notes.length>2000
     ||!validDate(work_date)||!validTime(start_time)||!validTime(end_time)
     ||(end_time&&!start_time)||(start_time&&end_time&&end_time<=start_time)
     ||!STATES.includes(status))return null;
  return {title,address,notes,work_date,start_time,end_time,status};
}
const columns="id,organization_id,title,address,notes,status, "+
  "to_char(work_date,'YYYY-MM-DD') AS work_date, "+
  "to_char(start_time,'HH24:MI') AS start_time, "+
  "to_char(end_time,'HH24:MI') AS end_time, "+
  "created_at,updated_at,created_by,updated_by";
async function migrateWorkCalendar(db){
  await db.query("CREATE TABLE IF NOT EXISTS work_calendar ("+
    "id BIGSERIAL PRIMARY KEY,"+
    "organization_id BIGINT NOT NULL REFERENCES organizations(id),"+
    "title TEXT NOT NULL,"+
    "address TEXT NOT NULL DEFAULT '',"+
    "work_date DATE NOT NULL,"+
    "start_time TIME,"+
    "end_time TIME,"+
    "status TEXT NOT NULL DEFAULT 'Zaplanowane',"+
    "notes TEXT NOT NULL DEFAULT '',"+
    "created_by BIGINT REFERENCES users(id),"+
    "updated_by BIGINT REFERENCES users(id),"+
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now(),"+
    "updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.query("CREATE INDEX IF NOT EXISTS work_calendar_org_day ON work_calendar(organization_id,work_date,id)");
  await migrateWorkReports(db);
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    // Nie odtwarzaj usuniętych albo zmienionych terminów po ponownym uruchomieniu.
    const marked=await c.query("INSERT INTO service_migrations(migration_key) VALUES('miwipol_calendar_20261119_v1') ON CONFLICT DO NOTHING RETURNING migration_key");
    if(marked.rowCount){
      const org=(await c.query("INSERT INTO organizations(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id",[ORGANIZATION])).rows[0];
      for(const category of ['Bramy i szlabany','Domofony i wideodomofony','Kontrola dostępu (SKD)','Inne'])
        await c.query('INSERT INTO organization_systems(organization_id,category) VALUES($1,$2) ON CONFLICT DO NOTHING',[org.id,category]);
      await c.query("INSERT INTO work_calendar(organization_id,title,address,work_date,status) VALUES($1,$2,$3,$4,$5),($1,$6,$7,$8,$5)",
        [org.id,'Montaż szlabanu','Pawła Gdańca 4, Gdańsk','2026-11-20','Zaplanowane','Weryfikacja domofonu','Hemara 2, Gdańsk','2026-11-23']);
      console.log('MIWIPOL calendar initialized with two scheduled works.');
    }
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
function setupWorkCalendar(app,{db,auth,adminOnly,problem}){
  async function access(req,res,next){
    try{
      if(req.user.role!=='admin'&&!(req.user.role==='client'&&req.user.organization_name===ORGANIZATION))
        return problem(res,403,'Terminarz jest przeznaczony dla MIWIPOL i administratora MarkNet.');
      const org=(await db.query('SELECT id FROM organizations WHERE name=$1 AND is_active=true',[ORGANIZATION])).rows[0];
      if(!org)return problem(res,404,'Kalendarz firmy MIWIPOL nie jest dostępny.');
      if(req.user.role!=='admin'&&String(req.user.organization_id)!==String(org.id))
        return problem(res,403,'Brak uprawnień do terminarza.');
      req.calendarOrg=org.id;next();
    }catch(error){next(error);}
  }
  app.get('/api/work-calendar',auth,access,async(req,res,next)=>{
    try{
      const from=String(req.query.from||''),to=String(req.query.to||'');
      if(!validDate(from)||!validDate(to))return problem(res,400,'Podaj poprawny zakres dat.');
      const diff=(new Date(to+'T12:00:00Z')-new Date(from+'T12:00:00Z'))/86400000;
      if(diff<0||diff>62)return problem(res,400,'Podaj zakres dat do 63 dni.');
      const result=await db.query("SELECT "+columns+",(SELECT count(*)::int FROM work_calendar_photos p WHERE p.calendar_id=work_calendar.id) AS photos_count,"+
        "(SELECT count(*)::int FROM work_calendar_activity a WHERE a.calendar_id=work_calendar.id AND a.kind='note') AS notes_count "+
        "FROM work_calendar WHERE organization_id=$1 AND work_date BETWEEN $2::date AND $3::date ORDER BY work_date,start_time NULLS FIRST,id",[req.calendarOrg,from,to]);
      res.json({organization:ORGANIZATION,events:result.rows});
    }catch(error){next(error);}
  });
  app.post('/api/work-calendar',auth,access,adminOnly,async(req,res,next)=>{
    try{
      const d=payload(req.body);
      if(!d)return problem(res,400,'Wpisz nazwę, adres, poprawną datę, godziny i status.');
      const r=await db.query("INSERT INTO work_calendar(organization_id,title,address,work_date,start_time,end_time,status,notes,created_by,updated_by) "+
         "VALUES($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9,$9) RETURNING "+columns,
        [req.calendarOrg,d.title,d.address,d.work_date,d.start_time,d.end_time,d.status,d.notes,req.user.id]);
      res.status(201).json({event:r.rows[0]});
    }catch(error){next(error);}
  });
  app.patch('/api/work-calendar/:id',auth,access,adminOnly,async(req,res,next)=>{
    try{
      if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Nieprawidłowy numer zadania.');
      const d=payload(req.body);
      if(!d)return problem(res,400,'Wpisz nazwę, adres, poprawną datę, godziny i status.');
      const c=await db.connect();
      try{
        await c.query('BEGIN');
        const oldStatus=(await c.query("SELECT status FROM work_calendar WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.calendarOrg])).rows[0];
        if(!oldStatus){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono zadania.');}
        const r=await c.query("UPDATE work_calendar SET title=$3,address=$4,work_date=$5::date,start_time=$6::time,"+
          "end_time=$7::time,status=$8,notes=$9,updated_by=$10,updated_at=now(),"+
          "completed_at=CASE WHEN $8='Wykonane' THEN COALESCE(completed_at,now()) ELSE NULL END,"+
          "completed_by=CASE WHEN $8='Wykonane' THEN $10 ELSE NULL END "+
          "WHERE id=$1 AND organization_id=$2 RETURNING "+columns,
          [req.params.id,req.calendarOrg,d.title,d.address,d.work_date,d.start_time,d.end_time,d.status,d.notes,req.user.id]);
        if(oldStatus.status!==d.status)
          await c.query("INSERT INTO work_calendar_activity(calendar_id,author_id,kind,body,old_status,new_status) VALUES($1,$2,'status',$3,$4,$5)",
            [req.params.id,req.user.id,'Zmiana statusu',oldStatus.status,d.status]);
        await c.query('COMMIT');
        res.json({event:r.rows[0]});
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    }catch(error){next(error);}
  });
  app.delete('/api/work-calendar/:id',auth,access,adminOnly,async(req,res,next)=>{
    try{
      if(!/^[1-9]\d*$/.test(req.params.id))return problem(res,400,'Nieprawidłowy numer zadania.');
      const r=await db.query('DELETE FROM work_calendar WHERE id=$1 AND organization_id=$2 RETURNING id',[req.params.id,req.calendarOrg]);
      if(!r.rowCount)return problem(res,404,'Nie znaleziono zadania.');
      res.json({ok:true});
    }catch(error){next(error);}
  });
  setupWorkReports(app,{db,auth,access,adminOnly,problem});
}
module.exports={migrateWorkCalendar,setupWorkCalendar,validDate,validTime,payload};
