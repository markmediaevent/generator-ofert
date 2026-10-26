const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
require('./public/led-utils.js');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Strony weryfikujemy przed express.static — również pliki *.html nie mogą obchodzić ról.
const pageRoles = new Map([
  ['/app',['admin','realizator']],['/app.html',['admin','realizator']],
  ['/admin',['admin']],['/admin.html',['admin']],
  ['/admin-magazyn',['admin']],['/admin-magazyn.html',['admin']],
  ['/admin-wrzutka',['admin']],['/admin-wrzutka.html',['admin']],
  ['/live',['admin','realizator']],['/live.html',['admin','realizator']],
  ['/packlists',['admin','realizator','pracownik']],['/packlists.html',['admin','realizator','pracownik']],
  ['/packlist',['admin','realizator','pracownik']],['/packlist.html',['admin','realizator','pracownik']]
]);
function normalizedRole(role) { return role==='user'?'realizator':role; }
function homeForRole(role){return role==='admin'?'/admin':normalizedRole(role)==='pracownik'?'/packlists':'/app';}
app.use((req,res,next)=>{
  const allowed=pageRoles.get(req.path);
  if(!allowed)return next();
  const token=getToken(req);
  if(!token||!sessions.has(token))return res.redirect('/login');
  req.user=sessions.get(token);
  if(!allowed.includes(normalizedRole(req.user.role)))return res.redirect(homeForRole(req.user.role));
  next();
});

app.use((req,res,next)=>{
  if(req.path.endsWith('.html') || ['/app','/admin','/packlist','/packlists','/led-utils.js','/packlist-app.js'].includes(req.path))
    res.setHeader('Cache-Control','no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Render's persistent disk already stores equipment-db.json, users.json and drafts here.
const DATA_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'equipment-db.json');
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');
const PACKLISTS_DIR = path.join(DATA_DIR, 'packlists');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_DRAFTS_PATH = process.env.GITHUB_DRAFTS_PATH || 'drafts';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'markmedia123';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map();

// Wrzutka zapisuje materiały bezpośrednio na Google Drive i nie korzysta z bazy magazynu ani szkiców ofert.
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1R1v8RQVpYK6I6I4ePIQ76bVq7A-76xRA';
const GOOGLE_DRIVE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || '';
const GOOGLE_DRIVE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || '';
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '';
const WRZUTKA_MAX_FILE_BYTES = Math.max(1, Number(process.env.WRZUTKA_MAX_FILE_MB || 5120)) * 1024 * 1024;
let driveTokenCache = { token: '', expiresAt: 0 };

function driveConfigured() {
  return Boolean(GOOGLE_DRIVE_FOLDER_ID && GOOGLE_DRIVE_CLIENT_ID && GOOGLE_DRIVE_CLIENT_SECRET && GOOGLE_DRIVE_REFRESH_TOKEN);
}
function sanitizeUploadPart(value, fallback = 'plik') {
  const clean = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/]+/g, '-')
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/[^\p{L}\p{N}._()\- ]/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (clean || fallback).slice(0, 180);
}
function sanitizeDriveId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 180);
}
async function getDriveAccessToken(force = false) {
  if (!driveConfigured()) throw new Error('Google Drive nie jest jeszcze skonfigurowany na serwerze.');
  if (!force && driveTokenCache.token && Date.now() < driveTokenCache.expiresAt - 60_000) return driveTokenCache.token;
  const form = new URLSearchParams({
    client_id: GOOGLE_DRIVE_CLIENT_ID,
    client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
    refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Nie udało się uzyskać dostępu do Google Drive.');
  driveTokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000) };
  return driveTokenCache.token;
}
async function driveFetch(url, options = {}, retry = true) {
  const token = await getDriveAccessToken(false);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    driveTokenCache = { token: '', expiresAt: 0 };
    return driveFetch(url, options, false);
  }
  return response;
}
async function driveJson(url, options = {}) {
  const response = await driveFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || `Google Drive API: HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}
function driveFileUrl(id, fields) {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
}
async function getWrzutkaFolder(folderId) {
  const id = sanitizeDriveId(folderId);
  if (!id) return null;
  try {
    const folder = await driveJson(driveFileUrl(id, 'id,name,mimeType,parents,trashed,appProperties,description,createdTime,webViewLink'));
    if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') return null;
    if (!Array.isArray(folder.parents) || !folder.parents.includes(GOOGLE_DRIVE_FOLDER_ID)) return null;
    if (folder.appProperties?.markmediaWrzutka !== '1') return null;
    return folder;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
function parseSubmissionDescription(folder) {
  try {
    const meta = JSON.parse(folder.description || '{}');
    return {
      id: folder.id,
      submissionId: String(meta.submissionId || ''),
      name: String(meta.name || ''),
      contact: String(meta.contact || ''),
      note: String(meta.note || ''),
      createdAt: String(meta.createdAt || folder.createdTime || '')
    };
  } catch {
    return { id: folder.id, submissionId: '', name: folder.name || '', contact: '', note: '', createdAt: folder.createdTime || '' };
  }
}
async function listWrzutkaSubmissions() {
  const q = `'${GOOGLE_DRIVE_FOLDER_ID.replace(/'/g, "\\'")}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='markmediaWrzutka' and value='1' }`;
  const params = new URLSearchParams({
    q, pageSize: '1000', orderBy: 'createdTime desc', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    fields: 'files(id,name,description,createdTime,modifiedTime,webViewLink,appProperties)'
  });
  const folders = (await driveJson(`https://www.googleapis.com/drive/v3/files?${params}`)).files || [];
  return Promise.all(folders.map(async folder => {
    const fq = `'${folder.id.replace(/'/g, "\\'")}' in parents and trashed=false`;
    const fp = new URLSearchParams({
      q: fq, pageSize: '1000', orderBy: 'createdTime', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      fields: 'files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink)'
    });
    const files = (await driveJson(`https://www.googleapis.com/drive/v3/files?${fp}`)).files || [];
    const meta = parseSubmissionDescription(folder);
    return {
      ...meta,
      driveUrl: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      files: files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').map(f => ({
        name: f.id, originalName: f.name, size: Number(f.size || 0), mtime: f.modifiedTime || f.createdTime, mimeType: f.mimeType, driveUrl: f.webViewLink || ''
      }))
    };
  }));
}

function hashUserPassword(plaintext){
 const salt=crypto.randomBytes(16).toString('hex');
 const hash=crypto.scryptSync(String(plaintext),salt,64).toString('hex');
 return 'scrypt$'+salt+'$'+hash;
}
function validUserPassword(input,stored){
 if(typeof stored!=='string')return false;
 if(stored.startsWith('scrypt$')){
   const parts=stored.split('$');
   if(parts.length!==3||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{128}$/.test(parts[2]))return false;
   const actual=crypto.scryptSync(String(input),parts[1],64);
   return crypto.timingSafeEqual(actual,Buffer.from(parts[2],'hex'));
 }
 const a=Buffer.from(String(input)),b=Buffer.from(stored);
 return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function ensureUsers() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    const seed = [{ id: crypto.randomBytes(8).toString('hex'), username: ADMIN_USER, password: hashUserPassword(ADMIN_PASS), role: 'admin', createdAt: new Date().toISOString() }];
    fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2), 'utf8');
  }
}
function readUsers() {
  ensureUsers();
  try {
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!Array.isArray(users)) users = [];

    // Awaryjnie odtwórz administratora, gdy lista jest pusta lub nie ma żadnego admina.
    if (!users.some(u => (u.role || 'user') === 'admin')) {
      users.push({
        id: crypto.randomBytes(8).toString('hex'),
        username: ADMIN_USER,
        password: hashUserPassword(ADMIN_PASS),
        role: 'admin',
        createdAt: new Date().toISOString()
      });
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    }
    let migration=false;
    for(const account of users){
      if(typeof account.password==='string'&&!account.password.startsWith('scrypt$')){
        account.password=hashUserPassword(account.password);migration=true;
      }
    }
    if(migration)fs.writeFileSync(USERS_FILE,JSON.stringify(users,null,2),'utf8');
    return users;
  } catch (e) {
    const users = [{
      id: crypto.randomBytes(8).toString('hex'),
      username: ADMIN_USER,
      password: hashUserPassword(ADMIN_PASS),
      role: 'admin',
      createdAt: new Date().toISOString()
    }];
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return users;
  }
}
function writeUsers(users) {
  ensureUsers();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
function publicUser(user) {
  return { id: user.id, username: user.username, role: normalizedRole(user.role || 'realizator'), createdAt: user.createdAt || '' };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      sections: {
        led: { label: 'Ekran LED', groups: [] },
        audio: { label: 'Nagłośnienie', groups: [] },
        light: { label: 'Oświetlenie', groups: [] },
        video: { label: 'Wideo / streaming', groups: [] },
        internet: { label: 'Internet / Starlink', groups: [] },
        stage: { label: 'Scena', groups: [] },
        transport: { label: 'Transport / montaż', groups: [] }
      }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf8');
  }
}

function cleanEquipmentDescription(value) {
  // Usuwamy powtarzalne dopiski importu, nie opisy techniczne napisane ręcznie.
  return String(value ?? '')
    .replace(/Katalog cross-rental\s*;\s*cena B2B orientacyjna\s*,\s*do potwierdzenia z wypożyczalnią\.?/gi, '')
    .trim();
}
function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  for (const section of Object.values(db.sections || {})) {
    for (const group of section.groups || []) {
      for (const item of group.items || []) {
        item.desc = cleanEquipmentDescription(item.desc);
      }
    }
  }
  return db;
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}


/* One-time additive import. Never overwrites existing items, prices, stocks or archived offers. */
function importCrossRentalCatalogOnce() {
  ensureDb();
  const marker=path.join(DATA_DIR,'.cross-rental-catalog-v1.done');
  if(fs.existsSync(marker))return;
  const file=path.join(__dirname,'data','cross-rental-catalog-2026.json');
  if(!fs.existsSync(file))return;
  const catalog=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(catalog.items)||!catalog.items.length)throw new Error('Cross-rental catalog empty');
  const db=readDb(), normalize=(v)=>String(v||'').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const existingNames=new Set(),existingIds=new Set();
  for(const section of Object.values(db.sections||{}))
    for(const group of section.groups||[])
      for(const item of group.items||[]){
        existingNames.add(normalize(item.name));existingIds.add(String(item.id));
      }
  const labels={
    led:'Ekrany LED / procesory',audio:'Nagłośnienie',light:'Oświetlenie',video:'Wideo / streaming',
    internet:'Internet / sieć',stage:'Scena / rigging',cables:'Okablowanie AV',
    power:'Zasilanie',furniture:'Meble / scenografia',intercom:'Interkom / komunikacja',
    accessories:'Akcesoria / logistyka'
  };
  let added=0,skipped=0;
  for(const source of catalog.items){
    if(!source?.id||!source?.name||!source?.sectionKey)continue;
    const key=normalize(source.name);
    if(!key||existingNames.has(key)||existingIds.has(String(source.id))){skipped++;continue;}
    const sk=String(source.sectionKey),groupName=String(source.groupName||'Pozostałe');
    if(!db.sections[sk])db.sections[sk]={label:labels[sk]||sk,groups:[]};
    const section=db.sections[sk];
    if(!Array.isArray(section.groups))section.groups=[];
    let group=section.groups.find(g=>normalize(g.name)===normalize(groupName));
    if(!group){
      group={id:'crg-'+crypto.createHash('sha1').update(sk+'/'+groupName).digest('hex').slice(0,12),
             name:groupName,items:[]};
      section.groups.push(group);
    }
    if(!Array.isArray(group.items))group.items=[];
    group.items.push({
      id:String(source.id),name:String(source.name),
      price:Math.max(0,Number(source.price||0)),crossRentalPrice:Math.max(0,Number(source.crossRentalPrice||0)),
      unit:String(source.unit||'szt. / dzień'),stock:0,
      ownership:'cross-rental',priceStatus:'szacunkowa',desc:cleanEquipmentDescription(source.desc)
    });
    existingNames.add(key);existingIds.add(String(source.id));added++;
  }
  if(added){
    const backup=path.join(DATA_DIR,'equipment-db.backup-pre-crossrental-v1.json');
    try{fs.copyFileSync(DB_FILE,backup,fs.constants.COPYFILE_EXCL);}
    catch(e){if(e.code!=='EEXIST')throw e;}
    const temp=DB_FILE+'.tmp-cross-'+process.pid;
    try{fs.writeFileSync(temp,JSON.stringify(db,null,2),'utf8');fs.renameSync(temp,DB_FILE);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  const markerTemp=marker+'.tmp-'+process.pid;
  try{
    fs.writeFileSync(markerTemp,JSON.stringify({added,skipped,importedAt:new Date().toISOString()})+'\n','utf8');
    fs.renameSync(markerTemp,marker);
  }finally{if(fs.existsSync(markerTemp))fs.unlinkSync(markerTemp);}
  console.log('Cross-rental reference catalog: added '+added+', skipped '+skipped+' existing.');
}

function sanitizeOfferNumber(value) {
  return String(value || 'draft')
    .trim()
    .replace(/[\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'draft';
}

function localDraftFile(offerNumber) {
  return path.join(DRAFTS_DIR, `${sanitizeOfferNumber(offerNumber)}.json`);
}

function githubEnabled() {
  return Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
}

async function githubRequest(method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'generator-ofert-pro-max',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 404) return null;
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = json?.message || `GitHub API error (${response.status})`;
    throw new Error(message);
  }
  return json;
}

async function getGithubDraftMeta(offerNumber) {
  const filePath = `${GITHUB_DRAFTS_PATH}/${sanitizeOfferNumber(offerNumber)}.json`;
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const meta = await githubRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  return { filePath, meta };
}

async function saveDraftToGithub(offerNumber, data) {
  const { filePath, meta } = await getGithubDraftMeta(offerNumber);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  // Repozytorium GitHub może być publiczne: nazwisk i notatek wewnętrznych ekipy
  // nie wysyłamy w kopii zapasowej oferty. Pełny szkic zostaje na dysku serwera.
  const externalCopy = JSON.parse(JSON.stringify(data));
  if (Array.isArray(externalCopy.items)) {
    externalCopy.items.forEach(item => {
      delete item.assignedNames;
      delete item.internalNotes;
    });
  }
  const content = Buffer.from(JSON.stringify(externalCopy, null, 2), 'utf8').toString('base64');
  const payload = {
    message: `save draft ${offerNumber}`,
    content,
    branch: GITHUB_BRANCH
  };
  if (meta?.sha) payload.sha = meta.sha;
  await githubRequest('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`, payload);
}

async function readDraftFromGithub(offerNumber) {
  const { meta } = await getGithubDraftMeta(offerNumber);
  if (!meta) return null;
  const raw = Buffer.from(meta.content, 'base64').toString('utf8');
  return JSON.parse(raw);
}


async function listGithubDrafts() {
  try {
    const encodedDir = GITHUB_DRAFTS_PATH.split('/').map(encodeURIComponent).join('/');
    const items = await githubRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedDir}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    if (!Array.isArray(items)) return [];
    const files = items.filter(item => item.type === 'file' && item.name.endsWith('.json'));
    const drafts = [];
    for (const file of files) {
      try {
        const contentMeta = await githubRequest('GET', file.url.replace('https://api.github.com', ''));
        const raw = Buffer.from(contentMeta.content, 'base64').toString('utf8');
        const data = JSON.parse(raw);
        drafts.push({
          offerNumber: data.offerNumber || file.name.replace(/\.json$/i, ''),
          clientName: data.clientName || '',
          eventName: data.eventName || '',
          location: data.location || '',
          dateFrom: data.dateFrom || '',
          dateTo: data.dateTo || '',
          updatedAt: file.sha,
          source: 'github'
        });
      } catch (e) {}
    }
    return drafts;
  } catch (e) {
    return [];
  }
}

function listLocalDrafts() {
  ensureDb();
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const file = path.join(DRAFTS_DIR, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
          offerNumber: raw.offerNumber || name.replace(/\.json$/i, ''),
          clientName: raw.clientName || '',
          eventName: raw.eventName || '',
          location: raw.location || '',
          dateFrom: raw.dateFrom || '',
          dateTo: raw.dateTo || '',
          updatedAt: fs.statSync(file).mtime.toISOString(),
          source: 'local'
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}


function getOfferSuffixForDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${month}/${year}`;
}

function parseOfferSequence(value, expectedSuffix) {
  const raw = String(value || '').trim();
  if (!raw.endsWith(`/${expectedSuffix}`)) return null;
  const seqPart = raw.slice(0, -(expectedSuffix.length + 1));
  const seq = Number(seqPart);
  return Number.isFinite(seq) && seq > 0 ? seq : null;
}

async function getNextOfferNumber() {
  const suffix = getOfferSuffixForDate(new Date());
  const local = listLocalDrafts();
  const github = githubEnabled() ? await listGithubDrafts() : [];
  const allNumbers = [...local, ...github].map(item => String(item.offerNumber || ''));
  const sequences = allNumbers
    .map(value => parseOfferSequence(value, suffix))
    .filter(Boolean);
  const next = sequences.length ? Math.max(...sequences) + 1 : 1;
  return `${String(next).padStart(3, '0')}/${suffix}`;
}

function createEmptyDbTemplate(baseDb = null) {
  const templateSource = baseDb?.sections || readDb().sections || {};
  const sections = {};
  Object.entries(templateSource).forEach(([sectionKey, section]) => {
    sections[sectionKey] = { label: section.label || sectionKey, groups: [] };
  });
  return { sections };
}

function dbRowsForExport(db) {
  const rows = [];
  Object.entries(db.sections || {}).forEach(([sectionKey, section]) => {
    (section.groups || []).forEach(group => {
      (group.items || []).forEach(item => {
        rows.push({
          sectionKey,
          sectionLabel: section.label || '',
          groupName: group.name || '',
          itemName: item.name || '',
          price: Number(item.price || 0),
          crossRentalPrice: item.crossRentalPrice ?? '',
          ownership: item.ownership || '',
          priceStatus: item.priceStatus || '',
          unit: item.unit || '',
          stock: Number(item.stock || 0),
          desc: item.desc || ''
        });
      });
    });
  });
  return rows;
}

function workbookForDbExport(db) {
  const rows = dbRowsForExport(db);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{
    sectionKey: 'audio',
    sectionLabel: 'Nagłośnienie',
    groupName: 'Przykładowa grupa',
    itemName: 'Przykładowa pozycja',
    price: 0,
    crossRentalPrice: '',
    ownership: 'cross-rental',
    priceStatus: 'szacunkowa',
    unit: 'szt.',
    stock: 0,
    desc: 'Wpisz własne dane lub usuń ten wiersz'
  }]);
  ws['!cols'] = [
    { wch: 18 }, { wch: 24 }, { wch: 24 }, { wch: 34 },
    { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 40 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Magazyn');
  const infoRows = [
    ['Instrukcja importu'],
    ['Kolumny wymagane:', 'sectionKey', 'sectionLabel', 'groupName', 'itemName', 'price', 'crossRentalPrice', 'ownership', 'priceStatus', 'unit', 'stock', 'desc'],
    ['Import aktualizuje istniejące pozycje i dodaje nowe.'],
    ['Dozwolone sectionKey istniejące w systemie:', Object.keys(db.sections || {}).join(', ')]
  ];
  const infoWs = XLSX.utils.aoa_to_sheet(infoRows);
  infoWs['!cols'] = [{ wch: 28 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, infoWs, 'Instrukcja');
  return wb;
}

function dbFromWorkbookBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Plik Excel nie zawiera żadnego arkusza.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const existingDb = readDb();
  const nextDb = createEmptyDbTemplate(existingDb);
  const groupMap = new Map();

  rows.forEach((row, index) => {
    const sectionKey = String(row.sectionKey || '').trim();
    const groupName = String(row.groupName || '').trim();
    const itemName = String(row.itemName || '').trim();
    if (!sectionKey && !groupName && !itemName) return;
    if (!sectionKey) throw new Error(`Wiersz ${index + 2}: brak sectionKey.`);
    if (!groupName) throw new Error(`Wiersz ${index + 2}: brak groupName.`);
    if (!itemName) throw new Error(`Wiersz ${index + 2}: brak itemName.`);

    if (!nextDb.sections[sectionKey]) {
      nextDb.sections[sectionKey] = {
        label: String(row.sectionLabel || sectionKey).trim() || sectionKey,
        groups: []
      };
    } else if (String(row.sectionLabel || '').trim()) {
      nextDb.sections[sectionKey].label = String(row.sectionLabel).trim();
    }

    const groupKey = `${sectionKey}__${groupName.toLowerCase()}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = { id: require('crypto').randomBytes(8).toString('hex'), name: groupName, items: [] };
      nextDb.sections[sectionKey].groups.push(group);
      groupMap.set(groupKey, group);
    }

    group.items.push({
      id: require('crypto').randomBytes(8).toString('hex'),
      name: itemName,
      price: Number(row.price || 0),
      crossRentalPrice: row.crossRentalPrice === '' ? null : Math.max(0, Number(row.crossRentalPrice || 0)),
      ownership: String(row.ownership || '').trim(),
      priceStatus: String(row.priceStatus || '').trim(),
      unit: String(row.unit || '').trim(),
      stock: Math.max(0, Number(row.stock || 0)),
      desc: String(row.desc || '').trim()
    });
  });

  return nextDb;
}


function mergeDbWithWorkbookBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Plik Excel nie zawiera żadnego arkusza.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const db = readDb();

  rows.forEach((row, index) => {
    const sectionKey = String(row.sectionKey || '').trim();
    const groupName = String(row.groupName || '').trim();
    const itemName = String(row.itemName || '').trim();
    if (!sectionKey && !groupName && !itemName) return;
    if (!sectionKey) throw new Error(`Wiersz ${index + 2}: brak sectionKey.`);
    if (!groupName) throw new Error(`Wiersz ${index + 2}: brak groupName.`);
    if (!itemName) throw new Error(`Wiersz ${index + 2}: brak itemName.`);

    if (!db.sections[sectionKey]) {
      db.sections[sectionKey] = {
        label: String(row.sectionLabel || sectionKey).trim() || sectionKey,
        groups: []
      };
    } else if (String(row.sectionLabel || '').trim()) {
      db.sections[sectionKey].label = String(row.sectionLabel).trim();
    }

    let group = (db.sections[sectionKey].groups || []).find(g => String(g.name || '').trim().toLowerCase() === groupName.toLowerCase());
    if (!group) {
      group = { id: crypto.randomBytes(8).toString('hex'), name: groupName, items: [] };
      db.sections[sectionKey].groups.push(group);
    }

    let item = (group.items || []).find(i => String(i.name || '').trim().toLowerCase() === itemName.toLowerCase());
    if (!item) {
      item = { id: crypto.randomBytes(8).toString('hex') };
      group.items.push(item);
    }

    item.name = itemName;
    item.price = Number(row.price || 0);
    if (row.crossRentalPrice !== undefined && row.crossRentalPrice !== '') item.crossRentalPrice = Math.max(0, Number(row.crossRentalPrice || 0));
    if (String(row.ownership || '').trim()) item.ownership = String(row.ownership).trim();
    if (String(row.priceStatus || '').trim()) item.priceStatus = String(row.priceStatus).trim();
    item.unit = String(row.unit || '').trim();
    item.stock = Math.max(0, Number(row.stock || 0));
    item.desc = String(row.desc || '').trim();
  });

  return db;
}
function createToken() { return crypto.randomBytes(24).toString('hex'); }
function getToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name === 'mm_session') return decodeURIComponent(valueParts.join('='));
  }
  return null;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  res.setHeader('Set-Cookie', `mm_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  res.setHeader('Set-Cookie', `mm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}
function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) return res.status(401).json({ ok: false, message: 'Brak autoryzacji' });
  req.user = sessions.get(token);
  next();
}
function requireRole(...allowedRoles) {
  return (req,res,next)=>requireAuth(req,res,()=>{
    if(!allowedRoles.includes(normalizedRole(req.user.role)))
      return res.status(403).json({ok:false,message:'Brak uprawnień do tej funkcji.'});
    next();
  });
}
const requireAdmin = requireRole('admin');
const requireRealizator = requireRole('admin','realizator');
function validNewRole(role){return ['admin','realizator','pracownik'].includes(role);}
function findGroup(db, sectionKey, groupId) {
  const section = db.sections?.[sectionKey];
  if (!section) return null;
  return section.groups.find(g => g.id === groupId) || null;
}

ensureDb();
importCrossRentalCatalogOnce();
ensureUsers();

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), app: 'Mark Media Oferty' }));
app.get('/api/test', (req, res) => res.json({ status: 'OK', message: 'API działa' }));


// Publiczna wrzutka plików. Endpointy są poza /api, więc nie wymagają logowania.
app.post('/wrzutka-api/submission', async (req, res) => {
  if (!driveConfigured()) return res.status(503).json({ ok: false, message: 'Wrzutka Google Drive nie jest jeszcze skonfigurowana.' });
  try {
    const submissionId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(5).toString('hex')}`;
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const contact = String(req.body?.contact || '').trim().slice(0, 160);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const createdAt = new Date().toISOString();
    const dateLabel = createdAt.slice(0, 16).replace('T', ' ').replace(':', '-');
    const folderName = `${dateLabel} - ${sanitizeUploadPart(name || 'Wrzutka', 'Wrzutka').slice(0, 80)} - ${submissionId.slice(-6)}`;
    const folder = await driveJson('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink,createdTime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [GOOGLE_DRIVE_FOLDER_ID],
        description: JSON.stringify({ submissionId, name, contact, note, createdAt }),
        appProperties: { markmediaWrzutka: '1', submissionId }
      })
    });
    res.json({ ok: true, id: folder.id });
  } catch (error) {
    console.error('Wrzutka /submission:', error);
    res.status(500).json({ ok: false, message: 'Nie udało się utworzyć folderu wrzutki na Google Drive.' });
  }
});

app.post('/wrzutka-api/upload/:submissionId', async (req, res) => {
  if (!driveConfigured()) return res.status(503).json({ ok: false, message: 'Wrzutka Google Drive nie jest jeszcze skonfigurowana.' });
  const folderId = sanitizeDriveId(req.params.submissionId);
  const contentLength = Number(req.headers['content-length'] || req.query.size || 0);
  if (!contentLength) return res.status(411).json({ ok: false, message: 'Nie udało się ustalić rozmiaru pliku.' });
  if (contentLength > WRZUTKA_MAX_FILE_BYTES) return res.status(413).json({ ok: false, message: `Plik przekracza limit ${Math.round(WRZUTKA_MAX_FILE_BYTES / 1024 / 1024 / 1024 * 100) / 100} GB.` });

  try {
    const folder = await getWrzutkaFolder(folderId);
    if (!folder) return res.status(404).json({ ok: false, message: 'Nie znaleziono aktywnej wrzutki.' });
    const originalName = sanitizeUploadPart(req.query.filename, 'plik');
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200);
    const token = await getDriveAccessToken(false);
    const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType,createdTime,modifiedTime,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(contentLength)
      },
      body: JSON.stringify({ name: originalName, parents: [folderId], appProperties: { markmediaWrzutkaFile: '1' } })
    });
    if (!init.ok) {
      const data = await init.json().catch(() => ({}));
      throw new Error(data?.error?.message || `Google Drive API: HTTP ${init.status}`);
    }
    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('Google Drive nie zwrócił adresu sesji wysyłania.');
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType, 'Content-Length': String(contentLength) },
      body: req,
      duplex: 'half'
    });
    const file = await upload.json().catch(() => ({}));
    if (!upload.ok) throw new Error(file?.error?.message || `Google Drive upload: HTTP ${upload.status}`);
    res.json({ ok: true, file: { name: file.id, originalName: file.name || originalName, size: Number(file.size || contentLength), driveUrl: file.webViewLink || '' } });
  } catch (error) {
    console.error('Wrzutka /upload:', error);
    if (!res.headersSent) res.status(500).json({ ok: false, message: 'Nie udało się wysłać pliku na Google Drive. Spróbuj ponownie.' });
  }
});

app.use('/api', (req,res,next)=>{
  const publicApi=new Set(['/login','/health','/test']);
  if(publicApi.has(req.path))return next();
  return requireAuth(req,res,()=>{
    // Domyślnie tylko realizator i administrator mają dostęp do pozostałego API
    // (w tym ofert, cen, magazynu, szkiców, materiałów klientów).
    if(normalizedRole(req.user.role)==='pracownik' &&
       !(/^\/packlists(?:\/|$)/.test(req.path) || /^\/packlist-offers$/.test(req.path) || req.path==='/me' || req.path==='/logout'))
      return res.status(403).json({ok:false,message:'Konto pracownika ma dostęp tylko do pack list.'});
    next();
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const users = readUsers();
  const user = users.find(u => String(u.username) === String(username) && validUserPassword(password,u.password));
  if (!user) {
    return res.status(401).json({ ok: false, message: 'Nieprawidłowy login lub hasło' });
  }
  const token = createToken();
  sessions.set(token, { id: user.id, username: user.username, role: user.role || 'user', createdAt: Date.now() });
  setSessionCookie(res, token);
  res.json({ ok: true, token, username: user.username, role: normalizedRole(user.role || 'realizator') });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, username: req.user.username, role: normalizedRole(req.user.role) }));
app.post('/api/logout', requireAuth, (req, res) => {
  const token = getToken(req);
  sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: readUsers().map(publicUser) });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '').trim();
  if (!cleanUsername) return res.status(400).json({ ok: false, message: 'Podaj login.' });
  if (cleanPassword.length < 8) return res.status(400).json({ ok: false, message: 'Hasło musi mieć co najmniej 8 znaków.' });
  const users = readUsers();
  if (users.some(u => String(u.username).toLowerCase() === cleanUsername.toLowerCase())) {
    return res.status(400).json({ ok: false, message: 'Taki login już istnieje.' });
  }
  const userRole = role || 'pracownik';
  if(!validNewRole(userRole))return res.status(400).json({ok:false,message:'Rola musi być: administrator, realizator albo pracownik.'});
  const user = { id: crypto.randomBytes(8).toString('hex'), username: cleanUsername, password: hashUserPassword(cleanPassword), role: userRole, createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  res.json({ ok: true, user: publicUser(user), users: users.map(publicUser) });
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body || {};
  const users = readUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ ok: false, message: 'Nie znaleziono użytkownika.' });
  const cleanUsername = String(username || user.username).trim();
  if (!cleanUsername) return res.status(400).json({ ok: false, message: 'Podaj login.' });
  if (users.some(u => u.id !== id && String(u.username).toLowerCase() === cleanUsername.toLowerCase())) {
    return res.status(400).json({ ok: false, message: 'Taki login już istnieje.' });
  }
  const nextRole = role || normalizedRole(user.role) || 'realizator';
  if(!validNewRole(nextRole))return res.status(400).json({ok:false,message:'Nieprawidłowa rola użytkownika.'});
  const isLastAdmin = (user.role || 'user') === 'admin' &&
    users.filter(u => (u.role || 'user') === 'admin').length <= 1;
  if (isLastAdmin && nextRole !== 'admin') {
    return res.status(400).json({ ok: false, message: 'Nie można odebrać uprawnień ostatniemu administratorowi.' });
  }
  user.username = cleanUsername;
  if(String(password||'').trim()){if(String(password).trim().length<8)return res.status(400).json({ok:false,message:'Nowe hasło musi mieć minimum 8 znaków.'});user.password=hashUserPassword(String(password).trim());}
  user.role = nextRole;
  writeUsers(users);
  // Nie pozostawiaj aktywnych sesji po zmianie roli lub hasła.
  for(const [sessionToken,sessionUser] of sessions.entries()){
    if(sessionUser.id===user.id) sessions.delete(sessionToken);
  }
  res.json({ ok: true, user: publicUser(user), users: users.map(publicUser) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const users = readUsers();
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ ok: false, message: 'Nie znaleziono użytkownika.' });
  if (target.id === req.user.id) {
    return res.status(400).json({ ok: false, message: 'Nie możesz usunąć aktualnie zalogowanego konta.' });
  }
  const adminCount = users.filter(u => (u.role || 'user') === 'admin').length;
  if ((target.role || 'user') === 'admin' && adminCount <= 1) {
    return res.status(400).json({ ok: false, message: 'Nie można usunąć ostatniego administratora.' });
  }
  const next = users.filter(u => u.id !== id);
  writeUsers(next);
  res.json({ ok: true, users: next.map(publicUser) });
});

app.get('/api/equipment-db', (req, res) => res.json(readDb()));
app.get('/api/admin/equipment-db', requireAdmin, (req, res) => res.json(readDb()));

app.post('/api/admin/groups', requireAdmin, (req, res) => {
  const { sectionKey, name } = req.body || {};
  const db = readDb();
  if (!db.sections?.[sectionKey]) return res.status(400).json({ ok: false, message: 'Nieprawidłowa sekcja' });
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, message: 'Podaj nazwę grupy' });
  const group = { id: crypto.randomBytes(8).toString('hex'), name: String(name).trim(), items: [] };
  db.sections[sectionKey].groups.push(group);
  writeDb(db);
  res.json({ ok: true, group, db });
});

app.delete('/api/admin/groups/:sectionKey/:groupId', requireAdmin, (req, res) => {
  const { sectionKey, groupId } = req.params;
  const db = readDb();
  const section = db.sections?.[sectionKey];
  if (!section) return res.status(400).json({ ok: false, message: 'Nieprawidłowa sekcja' });
  section.groups = section.groups.filter(g => g.id !== groupId);
  writeDb(db);
  res.json({ ok: true, db });
});

app.post('/api/admin/items', requireAdmin, (req, res) => {
  const { sectionKey, groupId, name, price, crossRentalPrice, unit, stock, desc } = req.body || {};
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, message: 'Podaj nazwę pozycji' });
  const item = { id: crypto.randomBytes(8).toString('hex'), name: String(name).trim(), price: Number(price || 0), crossRentalPrice: crossRentalPrice == null || crossRentalPrice === '' ? null : Math.max(0, Number(crossRentalPrice)), unit: String(unit || 'pozycja').trim(), stock: Math.max(0, Number(stock || 0)), desc: cleanEquipmentDescription(desc) };
  group.items.push(item);
  writeDb(db);
  res.json({ ok: true, item, db });
});

app.put('/api/admin/items/:sectionKey/:groupId/:itemId', requireAdmin, (req, res) => {
  const { sectionKey, groupId, itemId } = req.params;
  const { name, price, crossRentalPrice, unit, stock, desc } = req.body || {};
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  const item = group.items.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ ok: false, message: 'Nie znaleziono pozycji' });
  item.name = String(name || item.name).trim();
  item.price = Number(price ?? item.price);
  if (crossRentalPrice !== undefined) item.crossRentalPrice = crossRentalPrice == null || crossRentalPrice === '' ? null : Math.max(0, Number(crossRentalPrice));
  item.unit = String(unit ?? item.unit).trim();
  item.stock = Math.max(0, Number(stock ?? item.stock ?? 0));
  item.desc = cleanEquipmentDescription(desc ?? item.desc);
  writeDb(db);
  res.json({ ok: true, item, db });
});

app.delete('/api/admin/items/:sectionKey/:groupId/:itemId', requireAdmin, (req, res) => {
  const { sectionKey, groupId, itemId } = req.params;
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  group.items = group.items.filter(i => i.id !== itemId);
  writeDb(db);
  res.json({ ok: true, db });
});




app.get('/api/admin/wrzutka', requireAdmin, async (req, res) => {
  if (!driveConfigured()) return res.status(503).json({ ok: false, message: 'Brak konfiguracji Google Drive na serwerze.' });
  try {
    const submissions = await listWrzutkaSubmissions();
    res.json({ ok: true, submissions, destination: { folderId: GOOGLE_DRIVE_FOLDER_ID, url: `https://drive.google.com/drive/folders/${GOOGLE_DRIVE_FOLDER_ID}` } });
  } catch (error) {
    console.error('Admin wrzutka list:', error);
    res.status(500).json({ ok: false, message: 'Nie udało się odczytać wrzutki z Google Drive.' });
  }
});

app.get('/api/admin/wrzutka/:submissionId/download/:fileName', requireAdmin, async (req, res) => {
  try {
    const folderId = sanitizeDriveId(req.params.submissionId);
    const fileId = sanitizeDriveId(req.params.fileName);
    const folder = await getWrzutkaFolder(folderId);
    if (!folder) return res.status(404).json({ ok: false, message: 'Nie znaleziono zgłoszenia.' });
    const file = await driveJson(driveFileUrl(fileId, 'id,name,mimeType,size,parents,trashed'));
    if (file.trashed || !Array.isArray(file.parents) || !file.parents.includes(folderId)) return res.status(404).json({ ok: false, message: 'Nie znaleziono pliku.' });
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    if (!response.ok) return res.status(response.status).json({ ok: false, message: 'Nie udało się pobrać pliku z Google Drive.' });
    res.setHeader('Content-Type', file.mimeType || response.headers.get('content-type') || 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    const safeName = String(file.name || 'plik').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    for await (const chunk of response.body) res.write(Buffer.from(chunk));
    res.end();
  } catch (error) {
    console.error('Admin wrzutka download:', error);
    if (!res.headersSent) res.status(500).json({ ok: false, message: 'Nie udało się pobrać pliku z Google Drive.' });
  }
});

app.delete('/api/admin/wrzutka/:submissionId', requireAdmin, async (req, res) => {
  try {
    const folderId = sanitizeDriveId(req.params.submissionId);
    const folder = await getWrzutkaFolder(folderId);
    if (!folder) return res.status(404).json({ ok: false, message: 'Nie znaleziono zgłoszenia.' });
    await driveJson(driveFileUrl(folderId, 'id,trashed'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true })
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Admin wrzutka delete:', error);
    res.status(500).json({ ok: false, message: 'Nie udało się przenieść zgłoszenia do kosza Google Drive.' });
  }
});

app.get('/api/offers/next-number', async (req, res) => {
  try {
    const offerNumber = await getNextOfferNumber();
    res.json({ ok: true, offerNumber });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Nie udało się wygenerować numeru oferty' });
  }
});

app.get('/api/admin/equipment-db/export', requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const workbook = workbookForDbExport(db);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="magazyn-markmedia-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Nie udało się wyeksportować magazynu do Excel' });
  }
});

app.post('/api/admin/equipment-db/import', requireAdmin, (req, res) => {
  try {
    const { fileName, fileBase64 } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, message: 'Nie przesłano pliku Excel.' });
    const cleanBase64 = String(fileBase64).includes(',') ? String(fileBase64).split(',').pop() : String(fileBase64);
    const buffer = Buffer.from(cleanBase64, 'base64');
    const importedDb = mergeDbWithWorkbookBuffer(buffer);
    writeDb(importedDb);
    res.json({
      ok: true,
      message: `Zaimportowano magazyn z pliku ${fileName || 'Excel'}.`,
      db: importedDb
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'Nie udało się zaimportować pliku Excel.' });
  }
});

app.post('/api/drafts/save', async (req, res) => {
  try {
    const { offerNumber, data } = req.body || {};
    if (!offerNumber || !data) return res.status(400).json({ ok: false, message: 'Brak numeru oferty lub danych szkicu' });
    ensureDb();
    fs.writeFileSync(localDraftFile(offerNumber), JSON.stringify(data, null, 2), 'utf8');
    if (githubEnabled()) {
      try {
        await saveDraftToGithub(offerNumber, data);
        return res.json({ ok: true, github: true, message: 'Szkic zapisany na GitHub' });
      } catch (error) {
        console.error('GitHub draft backup failed:', error.message);
        return res.json({
          ok: true, github: false,
          warning: 'github_backup_failed',
          message: 'Szkic zapisany na serwerze. Kopia na GitHub nie została zapisana — sprawdź konfigurację dostępu do GitHuba.'
        });
      }
    }
    return res.json({ ok: true, github: false, message: 'Szkic zapisany lokalnie na serwerze' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Nie udało się zapisać szkicu' });
  }
});




function packlistFile(offerNumber) {
  return path.join(PACKLISTS_DIR, sanitizeOfferNumber(offerNumber) + '.json');
}
function ensurePacklistsDir() {
  fs.mkdirSync(PACKLISTS_DIR, { recursive: true });
}

// Kontrola pakowania jest niezależna od oferty i archiwum. Nie modyfikujemy szkiców.
const PACKLIST_MAX_EXTRAS = 1200;
function safePackKey(key){
  const value=String(key ?? '');
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value))throw new Error('Niepoprawny identyfikator pozycji.');
  return value;
}
function packText(value,length){return String(value ?? '').trim().slice(0,length);}
function readPacklistState(offerNumber){
  const file=packlistFile(offerNumber);
  const raw=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  return {
    checked:raw.checked && typeof raw.checked==='object' && !Array.isArray(raw.checked)?raw.checked:{},
    checkedBy:raw.checkedBy && typeof raw.checkedBy==='object' && !Array.isArray(raw.checkedBy)?raw.checkedBy:{},
    notes:raw.notes && typeof raw.notes==='object' && !Array.isArray(raw.notes)?raw.notes:{},
    extraItems:Array.isArray(raw.extraItems)?raw.extraItems:[],
    crewAssignments:Array.isArray(raw.crewAssignments)?raw.crewAssignments:[],
    ledConfigs:raw.ledConfigs && typeof raw.ledConfigs==='object' && !Array.isArray(raw.ledConfigs)?raw.ledConfigs:{},
    ledLogistics:raw.ledLogistics && typeof raw.ledLogistics==='object' && !Array.isArray(raw.ledLogistics)?raw.ledLogistics:{},
    revision:Number(raw.revision)||0,
    updatedAt:raw.updatedAt||''
  };
}
function writePacklistState(offerNumber,state){
  ensurePacklistsDir();
  const file=packlistFile(offerNumber);
  const temporary=file+'.tmp-'+crypto.randomBytes(6).toString('hex');
  const next={...state,revision:(Number(state.revision)||0)+1,updatedAt:new Date().toISOString()};
  try{
    fs.writeFileSync(temporary,JSON.stringify(next,null,2),'utf8');
    fs.renameSync(temporary,file);
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return next;
}
function crewForViewer(state,user){
  if(normalizedRole(user.role)!=='pracownik')return state;
  return {...state,crewAssignments:state.crewAssignments.filter(row=>row.userId===user.id)};
}
function crewDate(value){
  if(value==='')return '';
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('Podaj datę i godzinę.');
  const date=new Date(value+'Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,16)!==value)throw new Error('Niepoprawna data.');
  return value;
}
app.get('/api/packlists/:offerNumber/crew-users',requireRealizator,(req,res)=>{
  res.json({ok:true,users:readUsers().map(u=>({id:u.id,username:u.username,role:normalizedRole(u.role)}))});
});
function normalizePackExtra(payload,id){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Niepoprawne dane pozycji.');
  const name=packText(payload.name,180);
  if(!name)throw new Error('Podaj nazwę pozycji.');
  const qty=Number(payload.qty);
  if(!Number.isFinite(qty)||qty<=0||qty>100000)throw new Error('Podaj poprawną ilość.');
  const kind=['equipment','task','crew'].includes(payload.kind)?payload.kind:'equipment';
  return {
    id,kind,name,qty,unit:packText(payload.unit,35)|| (kind==='task'?'zad.':'szt.'),
    groupName:packText(payload.groupName,100)||'Dodatkowe / ręczne',
    source:packText(payload.source,120), details:packText(payload.details,400)
  };
}
function normalizePackLedConfig(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Brak konfiguracji ekranu.');
  const model=packText(payload.model,40);
  if(!['','yes-tech-p39','gloshine-p4','dicolor-p4'].includes(model))throw new Error('Nieznany model kabinetu.');
  const width=Number(String(payload.width??0).replace(',','.')),height=Number(String(payload.height??0).replace(',','.'));
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<0||height<0||width>500||height>500)throw new Error('Niepoprawny wymiar ekranu.');
  return {model,width,height,orientation:payload.orientation==='horizontal'?'horizontal':'vertical'};
}
function normalizeLedLogistics(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Niepoprawny plan pakowania LED.');
  const clean={};
  for(const [k,min,max] of [['caseSize',1,50],['dataChainSize',1,100],['powerChainSize',1,100],['spares',0,1000]]){
    const v=Number(input[k]);
    if(!Number.isInteger(v)||v<min||v>max)throw new Error('Niepoprawna liczba: '+k);
    clean[k]=v;
  }
  for(const [key,fallback,min,max] of [['pixelWidth',0,0,16384],['pixelHeight',0,0,16384],['portCapacity',650000,1,10000000],['portCount',4,1,128]]){
    const value=Number(input[key]??fallback);
    if(!Number.isInteger(value)||value<min||value>max)throw new Error('Niepoprawny parametr '+key);
    clean[key]=value;
  }
  if(input.backup!==undefined&&typeof input.backup!=='boolean')throw new Error('Niepoprawny backup.');
  clean.backup=input.backup===true;
  clean.portCabinets=String(input.portCabinets||'').trim();
  if(clean.portCabinets.length>5000||!/^[0-9,;\s]*$/.test(clean.portCabinets))throw new Error('Niepoprawny podział portów.');
  return clean;
}
function clearGeneratedChecks(state,id){
  for(const key of Object.keys(state.checked)){
    if(key.startsWith('autogen:'+id+':')){delete state.checked[key];delete state.checkedBy[key];}
  }
}
function safePackOffer(raw,number){
  // BIAŁA LISTA: workerzy nigdy nie dostają stawek, kosztów, rabatów i danych kontaktowych z oferty.
  const safe={
    offerNumber:String(raw.offerNumber||number||'').slice(0,90),
    eventName:String(raw.eventName||'').slice(0,200),
    clientName:String(raw.clientName||'').slice(0,200),
    location:String(raw.location||'').slice(0,160),
    eventDate:String(raw.eventDate||'').slice(0,30),
    offerStatus:String(raw.offerStatus||'').slice(0,45)
  };
  safe.items=(Array.isArray(raw.items)?raw.items:[]).slice(0,2500).map((i,index)=>({
    uid:/^[a-zA-Z0-9._:-]{1,120}$/.test(String(i.uid||''))?i.uid:'legacy-'+index,
    category:String(i.category||'').slice(0,70),
    categoryLabel:String(i.categoryLabel||'').slice(0,100),
    groupName:String(i.groupName||'').slice(0,100),
    name:String(i.name||'').slice(0,200),
    qty:Number(i.qty)||0,days:Number(i.days)||1,unitLabel:String(i.unitLabel||'').slice(0,35),
    source:String(i.source||'').slice(0,60),pricingMode:i.pricingMode==='per_m2'?'per_m2':'',
    ownership:String(i.ownership||'').slice(0,30),
    stockAtQuote:i.stockAtQuote==null?null:Number(i.stockAtQuote),
    assignedNames:String(i.assignedNames||'').slice(0,500),
    ledModel:String(i.ledModel||'').slice(0,35),
    ledScreenWidth:Number(i.ledScreenWidth)||0,ledScreenHeight:Number(i.ledScreenHeight)||0,
    ledOrientation:i.ledOrientation==='horizontal'?'horizontal':'vertical',
    desc:String(i.desc||'').slice(0,320)
  }));
  return safe;
}
async function getDraftRecord(number){
  const file=localDraftFile(number);
  if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
  return githubEnabled()?await readDraftFromGithub(number):null;
}
// Weryfikacja przydziału obejmuje każdy odczyt i zapis, także bezpośrednie linki.
function requirePackAssignment(req,res,next){
  res.setHeader('Cache-Control','no-store');
  if(normalizedRole(req.user.role)!=='pracownik')return next();
  try{
    const assigned=readPacklistState(req.params.offerNumber).crewAssignments.some(row=>row.userId===req.user.id);
    if(!assigned)return res.status(403).json({ok:false,message:'Ta pack lista nie jest do Ciebie przypisana.'});
    next();
  }catch(error){res.status(500).json({ok:false,message:'Nie można sprawdzić przydziału.'});}
}
app.use('/api/packlists/:offerNumber',requireAuth,requirePackAssignment);
app.get('/api/packlist-offers', requireAuth, async(req,res)=>{
  try{
    res.setHeader('Cache-Control','no-store');
    const local=listLocalDrafts(),external=githubEnabled()?await listGithubDrafts():[];
    const merged=new Map();
    for(const item of [...external,...local]){
      const key=sanitizeOfferNumber(item.offerNumber);
      if(item.source==='local'||!merged.has(key))merged.set(key,item);
    }
    const offers=Array.from(merged.values()).map(item=>({
      offerNumber:String(item.offerNumber||'').slice(0,90),
      eventName:String(item.eventName||'').slice(0,200),
      location:String(item.location||'').slice(0,160),
      clientName:String(item.clientName||'').slice(0,200),
      updatedAt:String(item.updatedAt||'').slice(0,36),
      assignedToMe:readPacklistState(item.offerNumber).crewAssignments.some(row=>row.userId===req.user.id)
    })).filter(item=>normalizedRole(req.user.role)!=='pracownik'||item.assignedToMe).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    res.json({ok:true,offers});
  }catch(error){res.status(500).json({ok:false,message:'Nie udało się pobrać listy realizacji.'});}
});
app.get('/api/packlists/:offerNumber/brief', requireAuth, async(req,res)=>{
  try{
    const data=await getDraftRecord(req.params.offerNumber);
    if(!data)return res.status(404).json({ok:false,message:'Brak zapisanej oferty dla tego wydarzenia.'});
    res.json({ok:true,data:safePackOffer(data,req.params.offerNumber)});
  }catch(error){res.status(500).json({ok:false,message:'Nie udało się pobrać zestawienia realizacji.'});}
});
app.get('/api/packlists/:offerNumber', requireAuth, (req,res)=>{
  try{res.json({ok:true,data:crewForViewer(readPacklistState(req.params.offerNumber),req.user)});}
  catch(error){res.status(500).json({ok:false,message:'Nie udało się wczytać pack listy.'});}
});
// Operacje punktowe nie nadpisują zmian w innych wierszach, również gdy pracuje kilku techników.
app.patch('/api/packlists/:offerNumber', requireAuth, (req,res)=>{
  try{
    const payload=req.body||{}, action=String(payload.action||'');
    const state=readPacklistState(req.params.offerNumber);
    let item=null;
    switch(action){
      case 'setCrewAssignment': {
        if(!['admin','realizator'].includes(normalizedRole(req.user.role)))return res.status(403).json({ok:false,message:'Brak uprawnień do obsady.'});
        const user=readUsers().find(u=>u.id===payload.userId);
        if(!user){
          if(payload.selected===false&&state.crewAssignments.some(row=>row.userId===payload.userId)){
            const old=state.crewAssignments.find(row=>row.userId===payload.userId);
            if(payload.expectedUpdatedAt!==old.updatedAt)return res.status(409).json({ok:false,message:'Odśwież obsadę.'});
            state.crewAssignments=state.crewAssignments.filter(row=>row.userId!==payload.userId);break;
          }
          throw new Error('Konto pracownika nie istnieje.');
        }
        const existing=state.crewAssignments.find(row=>row.userId===user.id);
        if(payload.expectedUpdatedAt!==(existing?.updatedAt||''))return res.status(409).json({ok:false,message:'Obsada została zmieniona. Odśwież listę.'});
        if(typeof payload.selected!=='boolean')throw new Error('Niepoprawny przydział.');
        const departure=crewDate(payload.departure),returnAt=crewDate(payload.returnAt);
        if(departure&&returnAt&&returnAt<departure)throw new Error('Powrót nie może być wcześniejszy niż wyjazd.');
        state.crewAssignments=state.crewAssignments.filter(row=>row.userId!==user.id);
        if(payload.selected)state.crewAssignments.push({userId:user.id,username:user.username,departure,returnAt,updatedAt:new Date().toISOString(),updatedBy:req.user.id});
        break;
      }
      case 'addItem': {
        if(state.extraItems.length>=PACKLIST_MAX_EXTRAS)throw new Error('Osiągnięto limit ręcznych pozycji.');
        const id='extra-'+crypto.randomBytes(8).toString('hex');
        item=normalizePackExtra(payload.item,id);
        state.extraItems.push(item);break;
      }
      case 'updateItem': {
        const id=safePackKey(payload.id);
        const idx=state.extraItems.findIndex(row=>row.id===id);
        if(idx<0)throw new Error('Nie znaleziono pozycji do edycji.');
        item=normalizePackExtra(payload.item,id);
        state.extraItems[idx]=item;break;
      }
      case 'removeItem': {
        const id=safePackKey(payload.id);
        if(!state.extraItems.some(row=>row.id===id))throw new Error('Nie znaleziono pozycji do usunięcia.');
        state.extraItems=state.extraItems.filter(row=>row.id!==id);
        delete state.checked[id];delete state.notes[id];delete state.checkedBy[id];break;
      }
      case 'setChecked': {
        const id=safePackKey(payload.id);
        if(payload.value===true){
          state.checked[id]=true;
          state.checkedBy[id]={username:packText(req.user?.username||'',100),at:new Date().toISOString()};
        }else{delete state.checked[id];delete state.checkedBy[id];}
        break;
      }
      case 'setNote': {
        const id=safePackKey(payload.id);
        if(typeof payload.value!=='string')throw new Error('Niepoprawna notatka.');
        state.notes[id]=payload.value.slice(0,500);break;
      }
      case 'setLedConfig': {
        const id=safePackKey(payload.id);
        state.ledConfigs[id]=normalizePackLedConfig(payload.config);
        clearGeneratedChecks(state,id);
        break;
      }
      case 'setLedLogistics': {
        const id=safePackKey(payload.id);
        state.ledLogistics[id]=normalizeLedLogistics(payload.config);
        const signal=globalThis.MM_LED.signalPlan(globalThis.MM_LED.calculate(state.ledConfigs[id]),state.ledLogistics[id]);
        if(signal?.ready&&!signal.valid)throw new Error(signal.message);
        clearGeneratedChecks(state,id);
        break;
      }
      case 'setLedSetup': {
        const id=safePackKey(payload.id);
        state.ledConfigs[id]=normalizePackLedConfig(payload.config);
        state.ledLogistics[id]=normalizeLedLogistics(payload.logistics);
        const signal=globalThis.MM_LED.signalPlan(globalThis.MM_LED.calculate(state.ledConfigs[id]),state.ledLogistics[id]);
        if(signal?.ready&&!signal.valid)throw new Error(signal.message);
        clearGeneratedChecks(state,id);
        break;
      }
      case 'resetChecks':
        state.checked={};state.checkedBy={};break;
      default:
        return res.status(400).json({ok:false,message:'Nieznana operacja pack listy.'});
    }
    const data=writePacklistState(req.params.offerNumber,state);
    res.json({ok:true,data:crewForViewer(data,req.user),item});
  }catch(error){res.status(400).json({ok:false,message:error.message||'Nie udało się zapisać pack listy.'});}
});
// Stary klient używał PUT: zachowujemy kompatybilność bez kasowania nowych pozycji ręcznych.
app.put('/api/packlists/:offerNumber', requireAuth, (req,res)=>{
  try{
    const input=req.body||{};
    if(!input.checked||typeof input.checked!=='object'||Array.isArray(input.checked))return res.status(400).json({ok:false,message:'Niepoprawny status.'});
    const state=readPacklistState(req.params.offerNumber);
    state.checked={};state.checkedBy={};
    for(const [id,flag] of Object.entries(input.checked).slice(0,3000)){
      if(/^[a-zA-Z0-9._:-]{1,128}$/.test(id)&&flag===true)state.checked[id]=true;
    }
    state.notes={};
    for(const [id,value] of Object.entries(input.notes||{}).slice(0,3000)){
      if(/^[a-zA-Z0-9._:-]{1,128}$/.test(id)&&typeof value==='string')state.notes[id]=value.slice(0,500);
    }
    res.json({ok:true,data:crewForViewer(writePacklistState(req.params.offerNumber,state),req.user)});
  }catch(error){res.status(500).json({ok:false,message:'Nie udało się zapisać pack listy.'});}
});

app.get('/api/drafts', async (req, res) => {
  try {
    const local = listLocalDrafts();
    const github = githubEnabled() ? await listGithubDrafts() : [];
    const merged = new Map();
    [...local, ...github].forEach(item => {
      const key = sanitizeOfferNumber(item.offerNumber || 'draft');
      const current = merged.get(key);
      if (!current || String(item.updatedAt || '') > String(current.updatedAt || '')) merged.set(key, item);
    });
    const drafts = Array.from(merged.values()).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ ok: true, drafts });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Nie udało się pobrać listy szkiców' });
  }
});

app.get('/api/drafts/:offerNumber', async (req, res) => {
  try {
    const { offerNumber } = req.params;
    const file = localDraftFile(offerNumber);
    // Local writes can be newer than GitHub when backup fails.
    if (fs.existsSync(file)) {
      return res.json({ ok: true, github: false, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
    if (githubEnabled()) {
      const draft = await readDraftFromGithub(offerNumber);
      if (draft) return res.json({ ok: true, github: true, data: draft });
    }
    return res.status(404).json({ ok: false, message: 'Nie znaleziono szkicu oferty' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Nie udało się wczytać szkicu' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/login', (req, res) => {
  const token = getToken(req);
  if (token && sessions.has(token)) {
    const user = sessions.get(token);
    return res.redirect(homeForRole(user.role));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/packlist', requireAuth, (req,res,next)=>{req.params.offerNumber=req.query.offer;requirePackAssignment(req,res,next);}, (req, res) => res.sendFile(path.join(__dirname, 'public', 'packlist.html')));
app.get('/packlists',(req,res)=>res.sendFile(path.join(__dirname,'public','packlists.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/wrzutka', (req, res) => res.sendFile(path.join(__dirname, 'public', 'wrzutka.html')));
app.get('/admin-wrzutka', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-wrzutka.html')));
app.get('/polityka-prywatnosci', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'polityka-prywatnosci.html'))
);

app.get('/regulamin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'regulamin.html'))
);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mark Media Oferty działa na porcie ${PORT}`);
});
