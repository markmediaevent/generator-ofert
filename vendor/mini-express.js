'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function compileRoute(pattern) {
  const keys = [];
  const parts = pattern.split('/').filter(Boolean).map(part => {
    if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp('^/' + parts.join('/') + '/?$'), keys };
}

function enhanceResponse(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
  };
  res.send = value => {
    if (Buffer.isBuffer(value)) return res.end(value);
    if (typeof value === 'object' && value !== null) return res.json(value);
    if (!res.headersSent) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(String(value ?? ''));
  };
  res.sendFile = filePath => {
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.statusCode = 404; return res.end('Not found'); }
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json; charset=utf-8' };
      if (!res.headersSent) res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    });
  };
  return res;
}

function express() {
  const middlewares = [];
  const routes = [];
  const app = function(req, res) {
    enhanceResponse(res);
    const parsed = new URL(req.url, 'http://localhost');
    req.path = parsed.pathname;
    req.query = Object.fromEntries(parsed.searchParams.entries());
    let index = 0;
    const stack = [...middlewares, async function routeHandler(req, res) {
      const method = req.method.toUpperCase();
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.compiled.regex.exec(req.path);
        if (!match) continue;
        req.params = {};
        route.compiled.keys.forEach((key, i) => req.params[key] = decodeURIComponent(match[i + 1]));
        let ri = 0;
        const runRoute = () => {
          const handler = route.handlers[ri++];
          if (!handler) return;
          try {
            const out = handler(req, res, runRoute);
            if (out && typeof out.catch === 'function') out.catch(err => fail(err, res));
          } catch (err) { fail(err, res); }
        };
        runRoute();
        return;
      }
      if (!res.writableEnded) { res.statusCode = 404; res.end('Not found'); }
    }];
    function next() {
      const mw = stack[index++];
      if (!mw) return;
      try {
        const out = mw(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(err => fail(err, res));
      } catch (err) { fail(err, res); }
    }
    next();
  };
  app.use = mw => { middlewares.push(mw); return app; };
  for (const method of ['get','post','put','delete']) {
    app[method] = (routePath, ...handlers) => { routes.push({ method: method.toUpperCase(), compiled: compileRoute(routePath), handlers }); return app; };
  }
  app.listen = (port, cb) => http.createServer(app).listen(port, cb);
  return app;
}

function fail(err, res) {
  console.error(err);
  if (!res.writableEnded) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok:false, message:'Wewnętrzny błąd serwera' }));
  }
}

express.json = ({ limit = '2mb' } = {}) => {
  const max = parseSize(limit);
  return (req, res, next) => {
    if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) { req.body = {}; return next(); }
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > max) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      if (size > max) return res.status(413).json({ ok:false, message:'Żądanie jest zbyt duże' });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { req.body = {}; return next(); }
      try { req.body = JSON.parse(raw); next(); }
      catch { res.status(400).json({ ok:false, message:'Nieprawidłowy JSON' }); }
    });
    req.on('error', () => { if (!res.writableEnded) res.status(400).json({ ok:false, message:'Błąd odczytu żądania' }); });
  };
};

express.static = root => (req, res, next) => {
  if (!['GET','HEAD'].includes(req.method)) return next();
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  const filePath = path.resolve(root, rel || 'index.html');
  const safeRoot = path.resolve(root) + path.sep;
  if (!(filePath + path.sep).startsWith(safeRoot) && filePath !== path.resolve(root)) return next();
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return next();
    res.sendFile(filePath);
  });
};

function parseSize(value) {
  const m = String(value).match(/^(\d+(?:\.\d+)?)(kb|mb|gb)?$/i);
  if (!m) return 2 * 1024 * 1024;
  const n = Number(m[1]); const unit = (m[2] || 'b').toLowerCase();
  return Math.floor(n * ({ b:1, kb:1024, mb:1024**2, gb:1024**3 }[unit] || 1));
}
module.exports = express;
