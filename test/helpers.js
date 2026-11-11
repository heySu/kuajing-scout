'use strict';
/** 测试辅助：必须在 require 任何 server 模块之前调用 prepareEnv()。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function prepareEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-test-'));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 'test.db'),
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    RATE_LIMIT_DISABLED: '1',
    ENABLE_CRON: '0',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    LLM_API_KEY: '',
    IMPORT_ON_BOOT: '1',
    REPORT_WRITE_FILES: '0'
  });
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.DEMO_MODE;
  Object.assign(process.env, extra);
  return dir;
}

async function startApp() {
  const { initSchema, db } = require('../server/db');
  initSchema();
  const auth = require('../server/services/auth');
  const boot = await auth.ensureBootstrap();
  const { seedProducts } = require('../server/seed');
  seedProducts(boot.tenant.id);
  const { createServer, route } = require('../server/app');
  for (const mod of ['ops', 'auth', 'products', 'reports', 'alerts', 'settings']) {
    require('../server/api/' + mod)(route);
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    db,
    tenantId: boot.tenant.id,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 与 startApp 相同，但额外注册 spu / video（成片工厂）路由，供其 e2e 测试使用 */
async function startAppVideo() {
  const { initSchema, db } = require('../server/db');
  initSchema();
  const auth = require('../server/services/auth');
  const boot = await auth.ensureBootstrap();
  const { seedProducts } = require('../server/seed');
  seedProducts(boot.tenant.id);
  const { createServer, route } = require('../server/app');
  for (const mod of ['ops', 'auth', 'products', 'reports', 'alerts', 'settings', 'spu', 'video']) {
    require('../server/api/' + mod)(route);
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    db,
    tenantId: boot.tenant.id,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function request(base, method, urlPath, { cookie = '', csrf = '', body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + urlPath, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

async function login(base, email = 'demo@scout.local', password = 'demo12345') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  const cookie = (res.headers.getSetCookie?.() || [])[0]?.split(';')[0] || '';
  return { status: res.status, data, cookie, csrf: data.csrf };
}

module.exports = { prepareEnv, startApp, startAppVideo, request, login };
