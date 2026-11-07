'use strict';
/** HTTP 服务：静态托管 + JSON API。node:http，零依赖。 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { seedIfEmpty } = require('./db');
const agent = require('./agent');

seedIfEmpty();

const PORT = Number(process.env.PORT || 3600);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

/** 极简路由：method + 精确路径 */
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', '/api/products', () => ({ products: agent.listProducts() }));
route('GET', '/api/top', (ctx) => ({ top: agent.topProducts(Number(ctx.query.get('n') || 3)) }));
route('GET', '/api/trend', (ctx) => {
  const id = Number(ctx.query.get('id'));
  if (!id) throw new HttpError(400, 'need_id');
  return { series: agent.trendSeries(id) };
});
route('GET', '/api/reports', () => ({ reports: agent.listReports() }));
route('GET', '/api/reports/:day', (ctx) => {
  const r = agent.getReport(ctx.params.day);
  if (!r) throw new HttpError(404, 'not_found', '当天无日报');
  return { report: r };
});
route('POST', '/api/report/generate', async () => {
  agent.recordSnapshot();
  const r = await agent.generateReport();
  return { report: r };
});
route('PATCH', '/api/products/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const body = ctx.body || {};
  const fields = ['trend_score', 'competition', 'repurchase', 'differentiation', 'sale_usd', 'cost_1688'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (body[f] !== undefined && Number.isFinite(Number(body[f]))) {
      sets.push(`${f} = ?`); vals.push(Number(body[f]));
    }
  }
  if (!sets.length) throw new HttpError(400, 'nothing_to_update');
  sets.push('updated_at = ?'); vals.push(new Date().toISOString()); vals.push(id);
  ctx.db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true };
});

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    try {
      const match = findRoute(req.method, url.pathname);
      if (!match) return json(res, 404, { error: 'not_found' });
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
      const data = await match.handler({ req, res, query: url.searchParams, params: match.params, body, db: require('./db').db });
      return json(res, 200, data);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error('[api]', e);
      return json(res, status, { error: e.code || 'internal', message: e.message });
    }
  }

  // 静态文件
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const abs = path.normalize(path.join(PUBLIC_DIR, file));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function findRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split('/').filter(Boolean);
    const up = pathname.split('/').filter(Boolean);
    if (pp.length !== up.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = up[i];
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// 定时任务：每 6 小时记录一次热度快照
setInterval(() => {
  try { agent.recordSnapshot(); console.log('[cron] snapshot recorded'); }
  catch (e) { console.error('[cron]', e.message); }
}, 6 * 3600 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log('跨境选品侦察兵 kuajing-scout');
  console.log(`  面板   http://127.0.0.1:${PORT}/`);
  console.log(`  API    http://127.0.0.1:${PORT}/api/products`);
  console.log(`  LLM    ${process.env.LLM_API_KEY ? '已配置 (' + (process.env.LLM_MODEL || 'gpt-4o-mini') + ')' : '未配置 · 日报走规则引擎（设 LLM_API_KEY 即启用）'}`);
});
