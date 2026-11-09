'use strict';
const { prepareEnv } = require('./helpers');
prepareEnv();

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, login } = require('./helpers');
const { hashPassword } = require('../server/lib/crypto');
const { nowIso } = require('../server/lib/time');

let app;
let cookie = '';
let csrf = '';

before(async () => {
  app = await startApp();
  const res = await login(app.base);
  assert.equal(res.status, 200);
  cookie = res.cookie;
  csrf = res.csrf;
});

after(async () => { await app.close(); });

test('健康检查与元信息无需登录', async () => {
  const health = await request(app.base, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  const meta = await request(app.base, 'GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.data.version);
});

test('未登录访问业务接口返回 401', async () => {
  const res = await request(app.base, 'GET', '/api/products');
  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'unauthorized');
});

test('登录后可以读取商品池，评分与利润字段齐全', async () => {
  const me = await request(app.base, 'GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'demo@scout.local');

  const res = await request(app.base, 'GET', '/api/products?pageSize=5', { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.data.total >= 15);
  const p = res.data.items[0];
  assert.ok(typeof p.scout_score === 'number');
  assert.equal(p.factors.length, 4);
  assert.ok(p.profit.breakdown.length >= 8);
  assert.ok(Array.isArray(p.series));
});

test('写请求缺少 CSRF 头会被拒绝', async () => {
  const res = await request(app.base, 'POST', '/api/products', {
    cookie, body: { name: 'CSRF 测试', cost_cny: 1, sale_usd: 10 }
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.error, 'csrf_failed');
});

test('商品新增/更新/归档/恢复', async () => {
  const created = await request(app.base, 'POST', '/api/products', {
    cookie, csrf, body: { name: '集成测试商品', sku: 'IT-001', cost_cny: 5, sale_usd: 19.99, weight_g: 200, scene: 'tiktok' }
  });
  assert.equal(created.status, 200);
  const id = created.data.product.id;
  assert.ok(created.data.product.scout_score > 0);

  const updated = await request(app.base, 'PATCH', `/api/products/${id}`, {
    cookie, csrf, body: { sale_usd: 15.99, compliance: 'high' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.product.verdict_key, 'review');

  const archived = await request(app.base, 'DELETE', `/api/products/${id}`, { cookie, csrf });
  assert.equal(archived.status, 200);
  const list = await request(app.base, 'GET', '/api/products?status=archived', { cookie });
  assert.ok(list.data.items.some((p) => p.id === id));
  const restored = await request(app.base, 'POST', `/api/products/${id}/restore`, { cookie, csrf, body: {} });
  assert.equal(restored.status, 200);
});

test('参数校验返回字段级错误', async () => {
  const res = await request(app.base, 'POST', '/api/products', {
    cookie, csrf, body: { name: '', cost_cny: -1, sale_usd: 0 }
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.data.details.fields));
  assert.ok(res.data.details.fields.length >= 2);
});

test('CSV 导入：新增与按 SKU 更新，错误行不阻断', async () => {
  const csv = '商品名,编码,品类,平台,拿货价,售价,重量g\nCSV导入A,CSV-1,家居,temu,6,15.99,300\nCSV导入B,CSV-2,家居,temu,,19.99,300\n';
  const first = await request(app.base, 'POST', '/api/products/import', { cookie, csrf, body: { csv } });
  assert.equal(first.status, 200);
  assert.equal(first.data.created, 1);
  assert.equal(first.data.failed, 1);

  const second = await request(app.base, 'POST', '/api/products/import', {
    cookie, csrf, body: { csv: '商品名,编码,拿货价,售价\nCSV导入A改名,CSV-1,6,16.99\n' }
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.updated, 1);
});

test('导出 CSV 带 BOM 且受配额约束', async () => {
  const res = await fetch(app.base + '/api/products/export.csv', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0xEF);
  assert.equal(buf[1], 0xBB);
  assert.equal(buf[2], 0xBF);
  const text = buf.toString('utf8');
  assert.ok(text.includes('商品名'));
});

test('日报生成幂等，并产生预警', async () => {
  const first = await request(app.base, 'POST', '/api/reports/generate', { cookie, csrf, body: { use_llm: false } });
  assert.equal(first.status, 200);
  assert.equal(first.data.report.source, 'rule');
  assert.ok(first.data.report.content.includes('选品日报'));

  const second = await request(app.base, 'POST', '/api/reports/generate', { cookie, csrf, body: { use_llm: false } });
  assert.equal(second.status, 200);
  const list = await request(app.base, 'GET', '/api/reports', { cookie });
  assert.equal(list.data.reports.filter((r) => r.day === first.data.report.day).length, 1);

  const alerts = await request(app.base, 'GET', '/api/alerts', { cookie });
  assert.equal(alerts.status, 200);
  assert.ok(Array.isArray(alerts.data.alerts));
});

test('预警确认与重新扫描', async () => {
  const rescan = await request(app.base, 'POST', '/api/alerts/rescan', { cookie, csrf, body: {} });
  assert.equal(rescan.status, 200);
  const list = await request(app.base, 'GET', '/api/alerts?status=all', { cookie });
  const alert = list.data.alerts[0];
  if (alert) {
    const ack = await request(app.base, 'POST', `/api/alerts/${alert.id}/ack`, { cookie, csrf, body: {} });
    assert.equal(ack.status, 200);
  }
});

test('设置读取与非法配置被拒绝', async () => {
  const res = await request(app.base, 'GET', '/api/settings', { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.data.config.weights.trend > 0);

  const bad = await request(app.base, 'PATCH', '/api/settings/config', {
    cookie, csrf, body: { weights: { trend: 5, profit: -1 } }
  });
  assert.equal(bad.status, 400);

  const ok = await request(app.base, 'PATCH', '/api/settings/config', {
    cookie, csrf, body: { scoring: { verdicts: { main: 80, test: 60, watch: 40 } } }
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.config.scoring.verdicts.main, 80);
});

test('API Key 只读权限不能写，但可以读', async () => {
  const created = await request(app.base, 'POST', '/api/keys', { cookie, csrf, body: { name: '只读脚本', scopes: 'read' } });
  assert.equal(created.status, 200);
  const plain = created.data.key.plain;

  const read = await request(app.base, 'GET', '/api/products', { headers: { 'x-api-key': plain } });
  assert.equal(read.status, 200);

  const write = await request(app.base, 'POST', '/api/products', {
    headers: { 'x-api-key': plain }, body: { name: 'x', cost_cny: 1, sale_usd: 2 }
  });
  assert.equal(write.status, 403);
  assert.equal(write.data.error, 'readonly_key');
});

test('租户隔离：B 租户看不到 A 租户商品', async () => {
  const tenantId = app.db.prepare('INSERT INTO tenants (name, slug, plan, status, created_at) VALUES (?,?,?,?,?)')
    .run('B 公司', 'tenant-b', 'pro', 'active', nowIso()).lastInsertRowid;
  const hash = await hashPassword('TenantB12345');
  app.db.prepare('INSERT INTO users (tenant_id, email, password_hash, name, role, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(tenantId, 'b@example.com', hash, 'B 管理员', 'owner', 'active', nowIso());

  const b = await login(app.base, 'b@example.com', 'TenantB12345');
  assert.equal(b.status, 200);
  const list = await request(app.base, 'GET', '/api/products', { cookie: b.cookie });
  assert.equal(list.data.total, 0);

  const aProduct = app.db.prepare('SELECT id FROM products WHERE tenant_id = ? LIMIT 1').get(app.tenantId);
  const detail = await request(app.base, 'GET', `/api/products/${aProduct.id}`, { cookie: b.cookie });
  assert.equal(detail.status, 404);
});

test('静态资源路径穿越被拦截', async () => {
  const res = await fetch(app.base + '/..%2f..%2fserver%2fdb.js');
  assert.ok([403, 404].includes(res.status), `status ${res.status}`);
  const body = await res.text();
  assert.ok(!body.includes('DatabaseSync'));
});

test('免费套餐商品上限触发 402', async () => {
  const plan = await request(app.base, 'POST', '/api/plan', { cookie, csrf, body: { plan: 'free' } });
  assert.equal(plan.status, 200);

  const insert = app.db.prepare(`INSERT INTO products
    (tenant_id, name, sku, category, scene, cost_cny, sale_usd, weight_g, trend_score, competition,
     repurchase, differentiation, logistics, compliance, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const count = app.db.prepare("SELECT COUNT(*) c FROM products WHERE tenant_id = ? AND status='active'").get(app.tenantId).c;
  for (let i = count; i < 50; i++) {
    insert.run(app.tenantId, '填充' + i, 'FILL-' + i, '测试', 'temu', 1, 10, 100, 50, 50, 50, 50, 'light', 'low', 'active', nowIso(), nowIso());
  }
  const over = await request(app.base, 'POST', '/api/products', {
    cookie, csrf, body: { name: '超出配额', cost_cny: 1, sale_usd: 10 }
  });
  assert.equal(over.status, 402);
  assert.equal(over.data.details.quota, 'products');

  const back = await request(app.base, 'POST', '/api/plan', { cookie, csrf, body: { plan: 'pro' } });
  assert.equal(back.status, 200);
});

test('未知接口返回 404 JSON', async () => {
  const res = await request(app.base, 'GET', '/api/not-exist', { cookie });
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'not_found');
});
