'use strict';
/**
 * 收尾三项集成测试：
 *   - 含成片后净利（SPU 视图扣减成本账本）：Task 8
 *   - 真实长片分片（Kling 10s 上限自动拆分）：Task 9
 *   - profit / listing 一键回传 Scout（API Key + CORS 跨域）：Task 10
 *
 * 注意：必须在 require 任何 server 模块前设置 KLING_API_KEY / CORS_ALLOW_ORIGINS，
 * 否则 config.js 在加载时读不到。
 */
process.env.KLING_API_KEY = 'test-key-for-chunking';
process.env.CORS_ALLOW_ORIGINS = 'http://localhost:9999';

const { prepareEnv, request, login, startAppVideo } = require('./helpers');
prepareEnv();

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initSchema } = require('../server/db');
const auth = require('../server/services/auth');
const { seedProducts } = require('../server/seed');
const products = require('../server/services/products');
const video = require('../server/services/video');
const spu = require('../server/services/spu');
const settings = require('../server/services/settings');

let tenantId, app, cookie, csrf, e2eId, apiKey;

before(async () => {
  initSchema();
  const boot = await auth.ensureBootstrap();
  tenantId = boot.tenant.id;
  seedProducts(tenantId);
  app = await startAppVideo();
  const res = await login(app.base);
  assert.equal(res.status, 200);
  cookie = res.cookie;
  csrf = res.csrf;
  e2eId = products.create(tenantId, { name: '回传集成测试商品', cost_cny: 5, sale_usd: 12, scene: 'tiktok' }).id;
  const userId = app.db.prepare('SELECT id FROM users WHERE email = ?').get('demo@scout.local').id;
  apiKey = auth.createApiKey(tenantId, userId, 'test-reverse', 'write').plain;
});

after(async () => { if (app) await app.close(); });

/* ---------------- Task 8：含成片后净利 ---------------- */
test('getSpv 暴露含成片后净利字段（USD + CNY）', () => {
  const spv = spu.getSpv(tenantId, e2eId);
  assert.ok('net_profit_incl_cost_usd' in spv, '应有 net_profit_incl_cost_usd');
  assert.ok('net_profit_incl_cost_cny' in spv, '应有 net_profit_incl_cost_cny');
  assert.ok('net_profit_usd' in spv, '应有原始净利用作对比');
  assert.equal(typeof spv.net_profit_incl_cost_usd, 'number');
  // 无成本账本时，含成片净利 == 原始净利
  assert.equal(spv.net_profit_incl_cost_usd, spv.net_profit_usd);
});

test('成本账本扣减后，含成片后净利随账本下降', () => {
  const fx = Number(settings.getConfig(tenantId).fx?.usdCny) || 7.2;
  const before = spu.getSpv(tenantId, e2eId);
  spu.addCostLedger(tenantId, e2eId, { kind: 'kling', seconds: 30, cost_usd: 1.5 }, { userId: 1, ip: 't' });
  const after = spu.getSpv(tenantId, e2eId);
  assert.equal(after.total_cost_usd, 1.5);
  assert.equal(after.net_profit_incl_cost_usd, Math.round((before.net_profit_usd - 1.5) * 1e4) / 1e4);
  assert.equal(after.net_profit_incl_cost_cny, Math.round(after.net_profit_incl_cost_usd * fx * 100) / 100);
});

test('HTTP GET /api/products/:id/spu 返回含成片后净利', async () => {
  const res = await request(app.base, 'GET', `/api/products/${e2eId}/spu`, { cookie });
  assert.equal(res.status, 200);
  assert.ok('net_profit_incl_cost_usd' in res.data.spv);
  assert.ok('total_cost_usd' in res.data.spv);
});

/* ---------------- Task 9：真实长片分片 ---------------- */
test('planChunks 按 maxSeconds 拆分（含 10s 上限边界）', () => {
  assert.deepEqual(video.planChunks(10, 10), [10]);
  assert.deepEqual(video.planChunks(7, 10), [7]);
  assert.deepEqual(video.planChunks(15, 10), [10, 5]);
  assert.deepEqual(video.planChunks(30, 10), [10, 10, 10]);
  assert.deepEqual(video.planChunks(60, 10), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(video.planChunks(25, 10), [10, 10, 5]);
});

test('真实 Kling 模式下超长时长自动分片提交并逐段记账', async () => {
  const calls = [];
  const fakeCall = async (provider, t, id, dur, prompt) => {
    calls.push({ provider, dur, prompt });
    return `task-${provider}-${dur}-${Math.random().toString(36).slice(2, 6)}`;
  };
  const r = await video.submitVideo(tenantId, e2eId, { provider: 'kling', duration: 30 }, { userId: 1, ip: 't' }, { call: fakeCall });
  assert.equal(r.segments, 3, '30s 应拆成 3 段');
  assert.equal(r.seconds, 30);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.dur), [10, 10, 10]);

  const spv = spu.getSpv(tenantId, e2eId);
  // 任务 ID 以 JSON 数组存储
  assert.ok(Array.isArray(JSON.parse(spv.kling_task_id)), 'kling_task_id 应为 JSON 数组');
  // 每段均记入 cost_ledger（与测试前相比应新增 3 条 kling 条目）
  const klingEntries = spv.cost_ledger.filter((e) => e.kind === 'kling');
  const newKling = klingEntries.slice(-3);
  assert.equal(newKling.length, 3, '应新增 3 条 kling 账本');
  assert.deepEqual(newKling.map((e) => e.seconds), [10, 10, 10]);
  const total = newKling.reduce((s, e) => s + e.cost_usd, 0);
  assert.equal(total, Math.round(video.computeCost('kling', 30) * 1e4) / 1e4);
});

test('getStatus 支持多段任务聚合（JSON 数组 task_id）', async () => {
  let polls = 0;
  const fakePoll = async () => { polls++; return { status: 'succeeded', url: 'https://cdn.test/v.mp4' }; };
  const st = await video.getStatus(tenantId, e2eId, 'kling', { pollKling: fakePoll });
  assert.ok(Array.isArray(st.task_id), '状态接口应回传数组 task_id');
  assert.ok(st.segments >= 3);
  assert.equal(polls, st.segments, '每段都应被轮询一次');
  assert.equal(st.status, 'succeeded');
});

/* ---------------- Task 10：profit / listing 一键回传（API Key + CORS） ---------------- */
test('API Key 跨域回传 profit 成本到 Scout（POST /spu-import）', async () => {
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/spu-import`, {
    headers: { 'x-api-key': apiKey },
    body: { payload: { type: 'profit-module', cost_cny: 6.5, sale_usd: 13.5 } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok((res.data.imported || []).includes('cost_cny'), '应导入 cost_cny');
  assert.ok((res.data.imported || []).includes('sale_usd'), '应导入 sale_usd');
  // 反向确认：详情已更新
  const detail = await request(app.base, 'GET', `/api/products/${e2eId}`, { cookie });
  assert.equal(detail.data.product.cost_cny, 6.5);
});

test('API Key 跨域回传成本账本（POST /cost-ledger）', async () => {
  const before = spu.getSpv(tenantId, e2eId).total_cost_usd;
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/cost-ledger`, {
    headers: { 'x-api-key': apiKey },
    body: { kind: 'heygen', seconds: 15, cost_usd: 0.6 }
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.total_cost_usd, Math.round((before + 0.6) * 1e4) / 1e4);
});

test('缺少 API Key 时回传被拒（401）', async () => {
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/cost-ledger`, {
    body: { kind: 'heygen', seconds: 15, cost_usd: 0.6 }
  });
  assert.equal(res.status, 401);
});

test('CORS 预检（OPTIONS）对白名单来源返回 204 + 允许头', async () => {
  const res = await fetch(app.base + `/api/products/${e2eId}/spu-import`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:9999', 'Access-Control-Request-Headers': 'x-api-key' }
  });
  assert.equal(res.status, 204, '白名单来源预检应通过');
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:9999');
  assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
  assert.ok((res.headers.get('access-control-allow-headers') || '').toLowerCase().includes('x-api-key'));
});

test('CORS 预检对未授权来源返回非 200（拒绝跨域）', async () => {
  const res = await fetch(app.base + `/api/products/${e2eId}/spu-import`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example.com' }
  });
  assert.notEqual(res.status, 204);
});

test('API Key + 跨域 Origin 实际 POST 返回 CORS 响应头', async () => {
  const res = await fetch(app.base + `/api/products/${e2eId}/spu-import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Origin: 'http://localhost:9999'
    },
    body: JSON.stringify({ payload: { type: 'listing-module', material_refs: [{ name: '主图A', url: 'https://x/y.png' }] } })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:9999');
  const j = await res.json();
  assert.ok((j.imported || []).includes('material_refs'), '应导入 material_refs');
});

/* ---------------- 新增：列表同步成片成本 / 内容状态 + 供应商自检 ---------------- */
test('商品列表项带 total_cost_usd / net_profit_incl_cost_usd / content_status', () => {
  const res = products.list(tenantId, { pageSize: 100, status: 'all' });
  const it = res.items.find((x) => x.id === e2eId);
  assert.ok(it, '列表中应含 e2e 商品');
  assert.ok('total_cost_usd' in it);
  assert.ok('net_profit_incl_cost_usd' in it);
  assert.ok('net_profit_incl_cost_cny' in it);
  assert.ok('content_status' in it);
  assert.equal(it.total_cost_usd, spu.getSpv(tenantId, e2eId).total_cost_usd, '列表成本应与 SPU 账本一致');
});

test('列表支持 content_status 筛选与 netincl 排序', () => {
  spu.writeFields(tenantId, e2eId, { content_status: 'approved' }, {});
  try {
    const only = products.list(tenantId, { pageSize: 100, status: 'all', content_status: 'approved' });
    assert.ok(only.items.length >= 1);
    assert.ok(only.items.every((x) => (x.content_status || 'none') === 'approved'));

    const sorted = products.list(tenantId, { pageSize: 100, status: 'all', sort: 'netincl', order: 'asc' });
    const arr = sorted.items.map((x) => x.net_profit_incl_cost_usd);
    for (let i = 1; i < arr.length; i++) assert.ok(arr[i] >= arr[i - 1], 'asc 应非递减');
  } finally {
    spu.writeFields(tenantId, e2eId, { content_status: 'none' }, {});
  }
});

test('listProviders 暴露 maxSeconds 与 configured', () => {
  const k = video.listProviders().find((p) => p.name === 'kling');
  assert.equal(k.configured, true, '本测试文件已设置 KLING_API_KEY');
  assert.ok(k.maxSeconds >= 1, '可灵应暴露单段时长上限');
});

test('GET /api/video/selfcheck 返回供应商配置诊断', async () => {
  const res = await request(app.base, 'GET', '/api/video/selfcheck', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.providers.length, 2);
  const k = res.data.providers.find((p) => p.name === 'kling');
  assert.equal(k.configured, true);
  assert.equal(k.mode, 'live');
  assert.ok(k.note.includes('真实模式'));
});
