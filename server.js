const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

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

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'markmedia123';
const sessions = new Map();

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


function getOfferPrefixForDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `OFERTA/MMedia/${month}/${year}`;
}

async function getNextOfferNumber() {
  const prefix = getOfferPrefixForDate(new Date());
  const local = listLocalDrafts();
  const github = githubEnabled() ? await listGithubDrafts() : [];
  const allNumbers = [...local, ...github].map(item => String(item.offerNumber || ''));
  const matching = allNumbers
    .filter(value => value === prefix || value.startsWith(prefix + '/'))
    .map(value => {
      if (value === prefix) return 1;
      const suffix = value.slice(prefix.length + 1);
      const parsed = Number(suffix);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })
    .filter(Boolean);
  if (!matching.length) return prefix;
  const next = Math.max(...matching) + 1;
  return `${prefix}/${String(next).padStart(2, '0')}`;
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
    ['Import nadpisuje całą bazę magazynu.'],
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

function createToken() { return crypto.randomBytes(24).toString('hex'); }
function getToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) return res.status(401).json({ ok: false, message: 'Brak autoryzacji' });
  req.user = sessions.get(token);
  next();
}
function findGroup(db, sectionKey, groupId) {
  const section = db.sections?.[sectionKey];
  if (!section) return null;
  return section.groups.find(g => g.id === groupId) || null;
}

ensureDb();

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), app: 'Generator Ofert PRO MAX WOW' }));
app.get('/api/test', (req, res) => res.json({ status: 'OK', message: 'API działa' }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ ok: false, message: 'Nieprawidłowy login lub hasło' });
  }
  const token = createToken();
  sessions.set(token, { username, createdAt: Date.now() });
  res.json({ ok: true, token, username });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true, username: req.user.username }));
app.post('/api/logout', requireAuth, (req, res) => {
  const token = getToken(req);
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/equipment-db', (req, res) => res.json(readDb()));
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



app.get('/api/offers/next-number', async (req, res) => {
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
    const importedDb = dbFromWorkbookBuffer(buffer);
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
      await saveDraftToGithub(offerNumber, data);
      return res.json({ ok: true, github: true, message: 'Szkic zapisany na GitHub' });
    }
    return res.json({ ok: true, github: false, message: 'Szkic zapisany lokalnie na serwerze' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Nie udało się zapisać szkicu' });
  }
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
app.listen(PORT, () => {
  console.log(`Generator Ofert PRO MAX WOW działa na porcie ${PORT}`);
});
