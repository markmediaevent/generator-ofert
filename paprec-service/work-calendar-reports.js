'use strict';
// Raporty postępu MIWIPOL: historia statusów, notatki, fotografie — tylko uprawnione konta.
const multer=require('multer');
const sharp=require('sharp');
const MAX_PHOTOS=12;
const MAX_BYTES=8*1024*1024;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_BYTES,files:1}});
const statuses=new Set(['Zaplanowane','W trakcie','Wykonane','Odwołane']);
const positiveId=id=>/^[1-9]\d*$/.test(String(id||''));
async function migrateWorkReports(db){
  await db.query("ALTER TABLE work_calendar ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ");
  await db.query("ALTER TABLE work_calendar ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES users(id)");
  await db.query("CREATE TABLE IF NOT EXISTS work_calendar_activity ("+
    "id BIGSERIAL PRIMARY KEY,"+
    "calendar_id BIGINT NOT NULL REFERENCES work_calendar(id) ON DELETE CASCADE,"+
    "author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,"+
    "kind TEXT NOT NULL CHECK(kind IN ('note','status','photo')),"+
    "body TEXT NOT NULL DEFAULT '',"+
    "old_status TEXT,new_status TEXT,"+
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.query("CREATE INDEX IF NOT EXISTS work_calendar_activity_idx ON work_calendar_activity(calendar_id,created_at,id)");
  await db.query("CREATE TABLE IF NOT EXISTS work_calendar_photos ("+
    "id BIGSERIAL PRIMARY KEY,"+
    "calendar_id BIGINT NOT NULL REFERENCES work_calendar(id) ON DELETE CASCADE,"+
    "activity_id BIGINT NOT NULL REFERENCES work_calendar_activity(id) ON DELETE CASCADE,"+
    "filename TEXT NOT NULL,"+
    "mime TEXT NOT NULL DEFAULT 'image/jpeg',"+
    "content BYTEA NOT NULL,"+
    "created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await db.query("CREATE INDEX IF NOT EXISTS work_calendar_photos_idx ON work_calendar_photos(calendar_id,id)");
}
function setupWorkReports(app,{db,auth,access,adminOnly,problem}){
  // Zabezpieczenie tenant-id: id zadania i organizacja zawsze sprawdzane w SQL.
  const verifyId=(req,res,next)=>positiveId(req.params.id)?next():problem(res,400,'Nieprawidłowy identyfikator.');
  async function eventFor(req){
    return (await db.query("SELECT w.id,w.organization_id,w.title,w.address,w.status,w.notes, "+
      "to_char(w.work_date,'YYYY-MM-DD') AS work_date,to_char(w.start_time,'HH24:MI') AS start_time,"+
      "to_char(w.end_time,'HH24:MI') AS end_time,w.completed_at "+
      "FROM work_calendar w WHERE w.id=$1 AND w.organization_id=$2",[req.params.id,req.calendarOrg])).rows[0];
  }
  app.get('/api/work-calendar/:id/report',auth,access,verifyId,async(req,res,next)=>{
    try{
      const event=await eventFor(req);
      if(!event)return problem(res,404,'Nie znaleziono pracy.');
      const activity=(await db.query("SELECT a.id,a.kind,a.body,a.old_status,a.new_status,a.created_at,"+
        "COALESCE(NULLIF(concat_ws(' ',u.first_name,u.last_name),''),u.username,'MarkNet') AS author "+
        "FROM work_calendar_activity a LEFT JOIN users u ON u.id=a.author_id "+
        "WHERE a.calendar_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 150",[event.id])).rows;
      const photos=(await db.query("SELECT id,activity_id,filename,created_at,octet_length(content) AS size "+
        "FROM work_calendar_photos WHERE calendar_id=$1 ORDER BY id DESC",[event.id])).rows;
      res.json({event,activity,photos,canEdit:req.user.role==='admin'});
    }catch(e){next(e);}
  });
  app.patch('/api/work-calendar/:id/status',auth,access,adminOnly,verifyId,async(req,res,next)=>{
    const nextStatus=req.body?.status;
    if(!statuses.has(nextStatus))return problem(res,400,'Nieprawidłowy status pracy.');
    const c=await db.connect();
    try{
      await c.query('BEGIN');
      const previous=(await c.query("SELECT status FROM work_calendar WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.calendarOrg])).rows[0];
      if(!previous){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono pracy.');}
      if(previous.status!==nextStatus){
        await c.query("UPDATE work_calendar SET status=$3,updated_at=now(),updated_by=$4,"+
          "completed_at=CASE WHEN $3='Wykonane' THEN now() ELSE NULL END,"+
          "completed_by=CASE WHEN $3='Wykonane' THEN $4 ELSE NULL END WHERE id=$1 AND organization_id=$2",
          [req.params.id,req.calendarOrg,nextStatus,req.user.id]);
        await c.query("INSERT INTO work_calendar_activity(calendar_id,author_id,kind,body,old_status,new_status) "+
          "VALUES($1,$2,'status',$3,$4,$5)",
          [req.params.id,req.user.id,'Zmiana statusu',previous.status,nextStatus]);
      }
      await c.query('COMMIT');
      res.json({ok:true,status:nextStatus,changed:previous.status!==nextStatus});
    }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}
  });
  app.post('/api/work-calendar/:id/notes',auth,access,adminOnly,verifyId,async(req,res,next)=>{
    try{
      const body=typeof req.body?.body==='string'?req.body.body.trim():'';
      if(body.length<2||body.length>3000)return problem(res,400,'Notatka musi zawierać od 2 do 3000 znaków.');
      const exists=await eventFor(req);
      if(!exists)return problem(res,404,'Nie znaleziono pracy.');
      const result=await db.query("INSERT INTO work_calendar_activity(calendar_id,author_id,kind,body) VALUES($1,$2,'note',$3) RETURNING id,created_at",
        [exists.id,req.user.id,body]);
      res.status(201).json({ok:true,note:result.rows[0]});
    }catch(e){next(e);}
  });
  app.post('/api/work-calendar/:id/photos',auth,access,adminOnly,verifyId,upload.single('file'),async(req,res,next)=>{
    try{
      if(!req.file||!req.file.buffer?.length)return problem(res,400,'Wybierz zdjęcie.');
      if(!['image/jpeg','image/png','image/webp','image/heic','image/heif','application/octet-stream'].includes(req.file.mimetype))
        return problem(res,400,'Dozwolone są zdjęcia JPG, PNG, WebP i HEIC.');
      let binary;
      try{
        const decoder=sharp(req.file.buffer,{limitInputPixels:45000000,failOn:'error'});
        const info=await decoder.metadata();
        if(!['jpeg','png','webp','heif'].includes(info.format))return problem(res,400,'Nieobsługiwany format obrazu.');
        binary=await decoder.rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true})
          .jpeg({quality:80,mozjpeg:true}).toBuffer();
      }catch(e){return problem(res,400,'Nie udało się odczytać zdjęcia. Wybierz JPG, PNG, WebP lub poprawny HEIC.');}
      const filename=String(req.file.originalname||'Zdjęcie').slice(0,150).replace(/[\r\n\x00-\x1f]/g,'');
      const c=await db.connect();
      try{
        await c.query('BEGIN');
        const event=(await c.query("SELECT id FROM work_calendar WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.calendarOrg])).rows[0];
        if(!event){await c.query('ROLLBACK');return problem(res,404,'Nie znaleziono pracy.');}
        const count=(await c.query("SELECT count(*)::int AS n FROM work_calendar_photos WHERE calendar_id=$1",[event.id])).rows[0].n;
        if(count>=MAX_PHOTOS){await c.query('ROLLBACK');return problem(res,409,'Limit 12 zdjęć dla jednej pracy został osiągnięty.');}
        const activity=(await c.query("INSERT INTO work_calendar_activity(calendar_id,author_id,kind,body) "+
          "VALUES($1,$2,'photo',$3) RETURNING id",[event.id,req.user.id,filename])).rows[0];
        const photo=(await c.query("INSERT INTO work_calendar_photos(calendar_id,activity_id,filename,mime,content) "+
          "VALUES($1,$2,$3,'image/jpeg',$4) RETURNING id,created_at",
          [event.id,activity.id,filename,binary])).rows[0];
        await c.query('COMMIT');res.status(201).json({photo:{...photo,filename}});
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }catch(e){next(e);}
  });
  app.get('/api/work-calendar/photos/:id',auth,access,verifyId,async(req,res,next)=>{
    try{
      const photo=(await db.query("SELECT p.id,p.mime,p.content FROM work_calendar_photos p "+
        "JOIN work_calendar w ON w.id=p.calendar_id "+
        "WHERE p.id=$1 AND w.organization_id=$2",[req.params.id,req.calendarOrg])).rows[0];
      if(!photo)return problem(res,404,'Nie znaleziono zdjęcia.');
      res.set('Content-Disposition','inline; filename="zdjecie-'+photo.id+'.jpg"');
      res.set('Cache-Control','no-store');
      res.type('image/jpeg').send(photo.content);
    }catch(e){next(e);}
  });
}
module.exports={migrateWorkReports,setupWorkReports};
