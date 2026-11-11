'use strict';
/**
 * 成片工厂（可灵 / HeyGen）测试：覆盖
 *   1) 供应商状态与沙盒模式判定
 *   2) computeCost = 单价 × 秒数
 *   3) submitVideo 沙盒模式：写任务 ID 并按秒记入 cost_ledger
 *   4) getStatus 沙盒任务恒 succeeded
 *   5) 参数校验（provider / duration）
 *   6) 端到端 HTTP：POST /video 记账、GET /video/providers
 */
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

let tenantId, productId, app, cookie, csrf, e2eId;

before(async () => {
  initSchema();
  const boot = await auth.ensureBootstrap();
  tenantId = boot.tenant.id;
  seedProducts(tenantId);
  productId = db_pick();
  app = await startAppVideo();
  const res = await login(app.base);
  assert.equal(res.status, 200);
  cookie = res.cookie;
  csrf = res.csrf;
  e2eId = products.create(tenantId, { name: '成片 E2E 商品', cost_cny: 2, sale_usd: 9.99, scene: 'tiktok' }).id;
});

after(async () => { if (app) await app.close(); });

function db_pick() {
  const db = require('../server/db').db;
  return db.prepare('SELECT id FROM products WHERE tenant_id = ? LIMIT 1').get(tenantId).id;
}

test('listProviders 返回 kling/heygen，无密钥时均为沙盒模式', () => {
  const ps = video.listProviders();
  assert.equal(ps.length, 2);
  const names = ps.map((p) => p.name).sort();
  assert.deepEqual(names, ['heygen', 'kling']);
  for (const p of ps) {
    assert.equal(p.mode, 'sandbox', p.name + ' 应处于沙盒模式');
    assert.ok(p.perSecondUsd > 0, p.name + ' 单价应 > 0');
  }
});

test('computeCost = 单价 × 秒数', () => {
  const k = video.listProviders().find((p) => p.name === 'kling');
  const expect = Math.round(k.perSecondUsd * 30 * 1e4) / 1e4;
  assert.equal(video.computeCost('kling', 30), expect);
  assert.equal(video.computeCost('kling', 60), Math.round(k.perSecondUsd * 60 * 1e4) / 1e4);
});

test('submitVideo 沙盒模式：写 kling_task_id 并按秒记入 cost_ledger', async () => {
  const before = spu.getSpv(tenantId, productId).cost_ledger.length;
  const r = await video.submitVideo(tenantId, productId, { provider: 'kling', duration: 30 }, { userId: 1, ip: 't' });
  assert.equal(r.sandbox, true);
  assert.ok(r.task_id.startsWith('sandbox-kling-'), '沙盒 taskId 前缀');
  assert.equal(r.seconds, 30);
  assert.ok(r.cost_usd > 0);
  const spv = spu.getSpv(tenantId, productId);
  assert.equal(spv.kling_task_id, r.task_id);
  assert.equal(spv.cost_ledger.length, before + 1);
  const entry = spv.cost_ledger.find((e) => e.kind === 'kling');
  assert.ok(entry, 'cost_ledger 含 kling 条目');
  assert.equal(entry.seconds, 30);
  assert.equal(entry.cost_usd, r.cost_usd);
});

test('getStatus 对沙盒任务返回 succeeded', async () => {
  const s = await video.getStatus(tenantId, productId, 'kling');
  assert.equal(s.status, 'succeeded');
  assert.equal(s.sandbox, true);
  assert.ok(s.task_id.startsWith('sandbox-kling-'));
});

test('submitVideo 沙盒模式 heygen 同样记账并写 heygen_task_id', async () => {
  const r = await video.submitVideo(tenantId, productId, { provider: 'heygen', duration: 15 }, { userId: 1, ip: 't' });
  const spv = spu.getSpv(tenantId, productId);
  assert.equal(spv.heygen_task_id, r.task_id);
  assert.ok(spv.cost_ledger.find((e) => e.kind === 'heygen'), 'cost_ledger 含 heygen 条目');
});

test('submitVideo 拒绝非法 provider 与 duration', async () => {
  await assert.rejects(() => video.submitVideo(tenantId, productId, { provider: 'foo', duration: 30 }));
  await assert.rejects(() => video.submitVideo(tenantId, productId, { provider: 'kling', duration: 45 }));
});

test('getStatus 无任务时返回 none', async () => {
  const clean = products.create(tenantId, { name: '无任务商品', cost_cny: 1, sale_usd: 5, scene: 'tiktok' }).id;
  const s = await video.getStatus(tenantId, clean, 'kling');
  assert.equal(s.status, 'none');
  assert.equal(s.task_id, '');
});

test('HTTP POST /api/products/:id/video 沙盒记账', async () => {
  const res = await request(app.base, 'POST', `/api/products/${e2eId}/video`, {
    cookie, csrf, body: { provider: 'kling', duration: '30' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.video.sandbox, true);
  assert.ok(res.data.video.task_id.startsWith('sandbox-kling-'));
  assert.ok(res.data.spv.cost_ledger.find((e) => e.kind === 'kling'), 'SPU 视图账本含 kling');
});

test('HTTP GET /api/video/providers 返回供应商状态', async () => {
  const res = await request(app.base, 'GET', '/api/video/providers', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.providers.length, 2);
});
