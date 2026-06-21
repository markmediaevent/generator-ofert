const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'equipment-db.json');
const DRAFTS_DIR = path.join(DATA_DIR, 'drafts');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_DRAFTS_PATH = process.env.GITHUB_DRAFTS_PATH || 'drafts';

const AUTH_DB_FILE = path.join(DATA_DIR, 'auth.sqlite');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'markmedia123';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
let authDb = null;

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

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
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
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
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
    unit: 'szt.',
    stock: 0,
    desc: 'Wpisz własne dane lub usuń ten wiersz'
  }]);
  ws['!cols'] = [
    { wch: 18 }, { wch: 24 }, { wch: 24 }, { wch: 34 },
    { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 40 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Magazyn');
  const infoRows = [
    ['Instrukcja importu'],
    ['Kolumny wymagane:', 'sectionKey', 'sectionLabel', 'groupName', 'itemName', 'price', 'unit', 'stock', 'desc'],
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
    item.unit = String(row.unit || '').trim();
    item.stock = Math.max(0, Number(row.stock || 0));
    item.desc = String(row.desc || '').trim();
  });

  return db;
}


let SQL = null;

async function openAuthDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!SQL) SQL = await initSqlJs();
  if (!authDb) {
    if (fs.existsSync(AUTH_DB_FILE)) {
      authDb = new SQL.Database(fs.readFileSync(AUTH_DB_FILE));
    } else {
      authDb = new SQL.Database();
    }
    authDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    saveAuthDb();
  }
  return authDb;
}

function saveAuthDb() {
  if (!authDb) return;
  fs.writeFileSync(AUTH_DB_FILE, Buffer.from(authDb.export()));
}

function dbRun(sql, params = []) {
  authDb.run(sql, params);
  saveAuthDb();
}

function dbGet(sql, params = []) {
  const stmt = authDb.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject();
    return null;
  } finally {
    stmt.free();
  }
}

function dbAll(sql, params = []) {
  const stmt = authDb.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.password_hash) return false;
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function ensureAuthDb() {
  await openAuthDb();
  const row = dbGet('SELECT COUNT(*) AS count FROM users');
  if (!Number(row?.count || 0)) {
    const now = new Date().toISOString();
    const { salt, hash } = hashPassword(ADMIN_PASS);
    dbRun('INSERT INTO users (username, password_hash, salt, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [ADMIN_USER, hash, salt, 'admin', now, now]);
  }
  dbRun('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}

function createToken() { return crypto.randomBytes(32).toString('hex'); }
function getToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
function getUserByToken(token) {
  if (!token) return null;
  const row = dbGet(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ? AND users.active = 1
  `, [token, Date.now()]);
  return row || null;
}
function requireAuth(req, res, next) {
  const token = getToken(req);
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, message: 'Brak autoryzacji' });
  req.user = publicUser(user);
  req.authToken = token;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, message: 'Brak uprawnień administratora' });
  next();
}

function findGroup(db, sectionKey, groupId) {
  const section = db.sections?.[sectionKey];
  if (!section) return null;
  return section.groups.find(g => g.id === groupId) || null;
}

ensureDb();

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), app: 'Mark Media Oferty' }));
app.get('/api/test', (req, res) => res.json({ status: 'OK', message: 'API działa' }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = dbGet('SELECT * FROM users WHERE username = ?', [String(username || '').trim()]);
  if (!user || !user.active || !verifyPassword(password, user)) {
    return res.status(401).json({ ok: false, message: 'Nieprawidłowy login lub hasło' });
  }
  const token = createToken();
  const now = Date.now();
  dbRun('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [token, user.id, now, now + SESSION_TTL_MS]);
  res.json({ ok: true, token, user: publicUser(user), username: user.username, role: user.role });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, user: req.user, username: req.user.username, role: req.user.role }));
app.post('/api/logout', requireAuth, (req, res) => {
  dbRun('DELETE FROM sessions WHERE token = ?', [req.authToken]);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = dbAll('SELECT id, username, role, active, created_at, updated_at FROM users ORDER BY id ASC').map(publicUser);
  res.json({ ok: true, users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body || {};
    const cleanUsername = String(username || '').trim();
    const cleanRole = role === 'admin' ? 'admin' : 'user';
    if (cleanUsername.length < 3) return res.status(400).json({ ok: false, message: 'Login musi mieć minimum 3 znaki' });
    if (String(password || '').length < 6) return res.status(400).json({ ok: false, message: 'Hasło musi mieć minimum 6 znaków' });
    const now = new Date().toISOString();
    const { salt, hash } = hashPassword(password);
    dbRun('INSERT INTO users (username, password_hash, salt, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', [cleanUsername, hash, salt, cleanRole, now, now]);
    const user = dbGet('SELECT id, username, role, active, created_at, updated_at FROM users WHERE username = ?', [cleanUsername]);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message && error.message.includes('UNIQUE') ? 'Taki login już istnieje' : 'Nie udało się utworzyć użytkownika' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { password, role, active } = req.body || {};
  const user = dbGet('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ ok: false, message: 'Nie znaleziono użytkownika' });
  const nextRole = role === 'admin' ? 'admin' : (role === 'user' ? 'user' : user.role);
  const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : user.active;
  const now = new Date().toISOString();
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ ok: false, message: 'Hasło musi mieć minimum 6 znaków' });
    const { salt, hash } = hashPassword(password);
    dbRun('UPDATE users SET password_hash = ?, salt = ?, role = ?, active = ?, updated_at = ? WHERE id = ?', [hash, salt, nextRole, nextActive, now, id]);
    dbRun('DELETE FROM sessions WHERE user_id = ?', [id]);
  } else {
    dbRun('UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?', [nextRole, nextActive, now, id]);
    if (!nextActive) dbRun('DELETE FROM sessions WHERE user_id = ?', [id]);
  }
  const updated = dbGet('SELECT id, username, role, active, created_at, updated_at FROM users WHERE id = ?', [id]);
  res.json({ ok: true, user: publicUser(updated) });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.user.id === id) return res.status(400).json({ ok: false, message: 'Nie możesz usunąć własnego konta' });
  dbRun('DELETE FROM sessions WHERE user_id = ?', [id]);
  const beforeDelete = dbGet('SELECT id FROM users WHERE id = ?', [id]);
  dbRun('DELETE FROM users WHERE id = ?', [id]);
  if (!beforeDelete) return res.status(404).json({ ok: false, message: 'Nie znaleziono użytkownika' });
  res.json({ ok: true });
});

app.get('/api/equipment-db', requireAuth, (req, res) => res.json(readDb()));
app.get('/api/admin/equipment-db', requireAuth, (req, res) => res.json(readDb()));

app.post('/api/admin/groups', requireAuth, (req, res) => {
  const { sectionKey, name } = req.body || {};
  const db = readDb();
  if (!db.sections?.[sectionKey]) return res.status(400).json({ ok: false, message: 'Nieprawidłowa sekcja' });
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, message: 'Podaj nazwę grupy' });
  const group = { id: crypto.randomBytes(8).toString('hex'), name: String(name).trim(), items: [] };
  db.sections[sectionKey].groups.push(group);
  writeDb(db);
  res.json({ ok: true, group, db });
});

app.delete('/api/admin/groups/:sectionKey/:groupId', requireAuth, (req, res) => {
  const { sectionKey, groupId } = req.params;
  const db = readDb();
  const section = db.sections?.[sectionKey];
  if (!section) return res.status(400).json({ ok: false, message: 'Nieprawidłowa sekcja' });
  section.groups = section.groups.filter(g => g.id !== groupId);
  writeDb(db);
  res.json({ ok: true, db });
});

app.post('/api/admin/items', requireAuth, (req, res) => {
  const { sectionKey, groupId, name, price, unit, stock, desc } = req.body || {};
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, message: 'Podaj nazwę pozycji' });
  const item = { id: crypto.randomBytes(8).toString('hex'), name: String(name).trim(), price: Number(price || 0), unit: String(unit || 'pozycja').trim(), stock: Math.max(0, Number(stock || 0)), desc: String(desc || '').trim() };
  group.items.push(item);
  writeDb(db);
  res.json({ ok: true, item, db });
});

app.put('/api/admin/items/:sectionKey/:groupId/:itemId', requireAuth, (req, res) => {
  const { sectionKey, groupId, itemId } = req.params;
  const { name, price, unit, stock, desc } = req.body || {};
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  const item = group.items.find(i => i.id === itemId);
  if (!item) return res.status(404).json({ ok: false, message: 'Nie znaleziono pozycji' });
  item.name = String(name || item.name).trim();
  item.price = Number(price ?? item.price);
  item.unit = String(unit ?? item.unit).trim();
  item.stock = Math.max(0, Number(stock ?? item.stock ?? 0));
  item.desc = String(desc ?? item.desc).trim();
  writeDb(db);
  res.json({ ok: true, item, db });
});

app.delete('/api/admin/items/:sectionKey/:groupId/:itemId', requireAuth, (req, res) => {
  const { sectionKey, groupId, itemId } = req.params;
  const db = readDb();
  const group = findGroup(db, sectionKey, groupId);
  if (!group) return res.status(400).json({ ok: false, message: 'Nie znaleziono grupy' });
  group.items = group.items.filter(i => i.id !== itemId);
  writeDb(db);
  res.json({ ok: true, db });
});



app.get('/api/offers/next-number', requireAuth, async (req, res) => {
  try {
    const offerNumber = await getNextOfferNumber();
    res.json({ ok: true, offerNumber });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Nie udało się wygenerować numeru oferty' });
  }
});

app.get('/api/admin/equipment-db/export', requireAuth, (req, res) => {
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

app.post('/api/admin/equipment-db/import', requireAuth, (req, res) => {
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

app.post('/api/drafts/save', requireAuth, async (req, res) => {
  try {
    const { offerNumber, data } = req.body || {};
    if (!offerNumber || !data) return res.status(400).json({ ok: false, message: 'Brak numeru oferty lub danych szkicu' });
    ensureDb();
    fs.writeFileSync(localDraftFile(offerNumber), JSON.stringify(data, null, 2), 'utf8');
    if (githubEnabled()) {
      await saveDraftToGithub(offerNumber, data);
      return res.json({ ok: true, github: true, message: 'Szkic zapisany na GitHub' });
    }
    return res.json({ ok: true, github: false, message: 'Szkic zapisany lokalnie na serwerze' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Nie udało się zapisać szkicu' });
  }
});



app.get('/api/drafts', requireAuth, async (req, res) => {
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

app.get('/api/drafts/:offerNumber', requireAuth, async (req, res) => {
  try {
    const { offerNumber } = req.params;
    if (githubEnabled()) {
      const draft = await readDraftFromGithub(offerNumber);
      if (draft) return res.json({ ok: true, github: true, data: draft });
    }
    const file = localDraftFile(offerNumber);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, message: 'Nie znaleziono szkicu oferty' });
    return res.json({ ok: true, github: false, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Nie udało się wczytać szkicu' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));

const PORT = process.env.PORT || 10000;
ensureAuthDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Mark Media Oferty działa na porcie ${PORT}`);
  });
}).catch((error) => {
  console.error('Nie udało się uruchomić bazy logowania SQLite:', error);
  process.exit(1);
});
