'use strict';
/**
 * SPU 打通层测试：覆盖
 *   1) 迁移 v2 为 products 表补齐 18 个 SPU 字段列（含幂等）
 *   2) writeFields / getSpv 字段读写
 *   3) getSpv 完整 SPU 视图结构
 *   4) exportPayload 精简 JSON 与换行切分
 *   5) importFromModules 合并基础字段 + SPU 字段
 *   6) addCostLedger 按秒记账与累加
 *   7) 端到端 HTTP：SPU 视图 / JSON 导出 / 脚本编写 / 成本记账 / 模块导入
 */
const { prepareEnv, request, login } = require('./helpers');
prepareEnv();

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initSchema, db } = require('../server/db');
const auth = require('../server/services/auth');
const { seedProducts } = require('../server/seed');
const { createServer, route } = require('../server/app');
const products = require('../server/services/products');
const spu = require('../server/services/spu');

const SPU_COLUMNS = [
  'selling_points', 'pain_points', 'target_audience', 'scenario', 'material_refs',
  'script_15s', 'script_30s', 'script_60s', 'voiceover', 'content_tags',
  'content_status', 'kling_task_id', 'heygen_task_id',
  'customer_id', 'access_code', 'tier', 'order_status', 'cost_ledger'
];

test('迁移 v2：products 表补齐 18 个 SPU 字段列', () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('products')").all().map((r) => r.name);
  for (const c of SPU_COLUMNS) {
    assert.ok(cols.includes(c), `缺少 SPU 列：${c}`);
  }
});

test('迁移幂等：重复 initSchema 不报错且 SPU 列仍存在', () => {
  assert.doesNotThrow(() => initSchema());
  const cols = db.prepare("SELECT name FROM pragma_table_info('products')").all().map((r) => r.name);
  for (const c of SPU_COLUMNS) {
    assert.ok(cols.includes(c), `重复迁移后缺少 SPU 列：${c}`);
  }
});

test('writeFields 写入 getSpv 读回 SPU 字段', () => {
  spu.writeFields(tenantId, productId, {
    selling_points: '磁吸快拆，单手操作',
    pain_points: '开车无法稳拿手机',
    target_audience: '有车一族',
    scenario: '通勤/自驾场景',
    script_15s: '上车前 3 秒种草',
    script_30s: '痛点+演示+下单',
    script_60s: '深度测评版',
    voiceover: '磁性男声',
    content_status: 'draft',
    tier: '30',
    material_refs: [{ type: 'image', url: 'https://x/main.png', label: '主图' }]
  });
  const view = spu.getSpv(tenantId, productId);
  assert.equal(view.selling_points, '磁吸快拆，单手操作');
  assert.equal(view.pain_points, '开车无法稳拿手机');
  assert.equal(view.target_audience, '有车一族');
  assert.equal(view.scripts['15'], '上车前 3 秒种草');
  assert.equal(view.scripts['60'], '深度测评版');
  assert.equal(view.content_status, 'draft');
  assert.equal(view.tier, '30');
  assert.deepEqual(view.material_refs, [{ type: 'image', url: 'https://x/main.png', label: '主图' }]);
});

test('getSpv 视图结构完整（A 标识/B 选品/C 成本利润/D 卖点/E 内容/F 商业化）', () => {
  const view = spu.getSpv(tenantId, productId);
  // A 标识
  assert.ok('spu_id' in view && 'name' in view && 'sku' in view && 'category' in view);
  // B 选品 + C 成本利润
  assert.ok('cost_cny' in view && 'sale_usd' in view && 'margin_pct' in view && 'verdict' in view);
  // D 卖点素材
  assert.ok(Array.isArray(view.material_refs));
  // E 内容生产
  assert.ok('scripts' in view && 'voiceover' in view && 'content_status' in view);
  assert.ok('kling_task_id' in view && 'heygen_task_id' in view);
  // F 商业化
  assert.ok('customer_id' in view && 'access_code' in view && 'tier' in view && 'order_status' in view);
  // 成本账本汇总
  assert.ok(Array.isArray(view.cost_ledger) && 'total_cost_usd' in view);
});

test('exportPayload 输出精简 JSON 并按换行切分卖点/痛点', () => {
  spu.writeFields(tenantId, productId, {
    selling_points: '卖点A\n卖点B\n',
    pain_points: '痛点1',
    content_tags: '车载,礼赠'
  });
  const payload = spu.exportPayload(tenantId, productId);
  assert.deepEqual(payload.selling_points, ['卖点A', '卖点B']);
  assert.deepEqual(payload.pain_points, ['痛点1']);
  assert.equal(payload.content_tags, '车载,礼赠');
  assert.ok('scripts' in payload && 'generated_at' in payload && 'spu_id' in payload);
  // 精简 payload 不应外泄内部账本
  assert.ok(!('cost_ledger' in payload) && !('total_cost_usd' in payload));
});

test('importFromModules 合并基础字段（走 products.update）与 SPU 字段', () => {
  const payload = {
    type: 'profit-module',
    name: '改价商品',
    cost_cny: 3.5,
    sale_usd: 13.99,
    selling_points: '新卖点',
    content_status: 'reviewing',
    access_code: 'ABC123'
  };
  const { imported } = spu.importFromModules(tenantId, productId, payload, { userId: 1, ip: 'test' });
  assert.ok(imported.includes('cost_cny'), '基础字段 cost_cny 应合并');
  assert.ok(imported.includes('sale_usd'), '基础字段 sale_usd 应合并');
  assert.ok(imported.includes('selling_points'), 'SPU 字段 selling_points 应合并');
  assert.ok(imported.includes('access_code'), 'SPU 字段 access_code 应合并');

  const view = spu.getSpv(tenantId, productId);
  assert.equal(view.cost_cny, 3.5);
  assert.equal(view.sale_usd, 13.99);
  assert.equal(view.selling_points, '新卖点');
  assert.equal(view.content_status, 'reviewing');
  assert.equal(view.access_code, 'ABC123');
  assert.equal(view.name, '改价商品');
});

test('addCostLedger 按秒记账并累加总成本', () => {
  const ledger1 = spu.addCostLedger(tenantId, productId, { kind: 'kling', seconds: 30, cost_usd: 1.2 });
  assert.equal(ledger1.length, 1);
  const ledger2 = spu.addCostLedger(tenantId, productId, { kind: 'heygen', seconds: 60, cost_usd: 3.5 });
  assert.equal(ledger2.length, 2);

  const view = spu.getSpv(tenantId, productId);
  assert.equal(view.total_cost_usd, 4.7);
  assert.equal(view.cost_ledger[0].kind, 'kling');
  assert.equal(view.cost_ledger[0].seconds, 30);
  assert.equal(view.cost_ledger[1].kind, 'heygen');
  assert.equal(view.cost_ledger[1].cost_usd, 3.5);
});

// ---- 引导 + 端到端 HTTP 验证（独立干净商品，避免依赖上文累计状态）----
let tenantId, productId, app, cookie, csrf, e2eId;

before(async () => {
  initSchema();
  const boot = await auth.ensureBootstrap();
  tenantId = boot.tenant.id;
  seedProducts(tenantId);
  productId = db.prepare('SELECT id FROM products WHERE tenant_id = ? LIMIT 1').get(tenantId).id;
  app = await startAppSpv();
  const res = await login(app.base);
  assert.equal(res.status, 200);
  cookie = res.cookie;
  csrf = res.csrf;
  const fresh = products.create(tenantId, { name: 'SPU E2E 商品', cost_cny: 2, sale_usd: 9.99, scene: 'tiktok' });
  e2eId = fresh.id;
});

after(async () => { if (app) await app.close(); });

async function startAppSpv() {
  for (const m of ['ops', 'auth', 'products', 'reports', 'alerts', 'settings', 'spu']) {
    require('../server/api/' + m)(route);
  }
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('HTTP GET /api/products/:id/spu 返回完整 SPU 视图', async () => {
  const res = await request(app.base, 'GET', `/api/products/${e2eId}/spu`, { cookie });
  assert.equal(res.status, 200);
  const spv = res.data.spv;
  assert.equal(spv.product_id, e2eId);
  assert.ok('selling_points' in spv);
  assert.ok('scripts' in spv);
  assert.ok('cost_ledger' in spv);
  assert.ok('total_cost_usd' in spv);
});

test('HTTP GET /api/products/:id/spu.json 下载精简 JSON', async () => {
  const res = await fetch(app.base + `/api/products/${e2eId}/spu.json`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
  const data = await res.json();
  assert.ok('selling_points' in data);
  assert.ok('generated_at' in data);
  assert.equal(data.spu_id, String(e2eId));
});

test('HTTP GET 商品详情含 SPU 字段（前端面板数据源）', async () => {
  const res = await request(app.base, 'GET', `/api/products/${e2eId}`, { cookie });
  assert.equal(res.status, 200);
  const p = res.data.product;
  assert.equal(p.id, e2eId);
  // 标准详情接口需透出 SPU 打通层字段，前端内容生产面板才能回显
  assert.ok('selling_points' in p);
  assert.ok('script_15s' in p);
  assert.ok('content_status' in p);
  assert.ok('material_refs' in p);
  assert.ok('cost_ledger' in p);
});

test('HTTP PATCH /api/products/:id/script 写入脚本与内容状态', async () => {
  const res = await request(app.base, 'PATCH', `/api/products/${e2eId}/script`, {
    cookie, csrf,
    body: { script_15s: '15秒钩子开场', content_status: 'approved' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.spv.scripts['15'], '15秒钩子开场');
  assert.equal(res.data.spv.content_status, 'approved');
});

test('HTTP POST /api/products/:id/cost-ledger 记账并返回账本', async () => {
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/cost-ledger`, {
    cookie, csrf, body: { kind: 'kling', seconds: 15, cost_usd: 0.6 }
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.cost_ledger));
  assert.equal(res.data.cost_ledger[0].kind, 'kling');
  assert.equal(res.data.total_cost_usd, 0.6);
});

test('HTTP POST /api/products/:id/spu-import 合并 profit 模块 JSON', async () => {
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/spu-import`, {
    cookie, csrf,
    body: { payload: { type: 'profit-module', cost_cny: 4.2, sale_usd: 15.5 } }
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.imported.includes('cost_cny'));
  assert.equal(res.data.spv.cost_cny, 4.2);
  assert.equal(res.data.spv.sale_usd, 15.5);
});
