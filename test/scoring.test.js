'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeScore } = require('../server/services/scoring');
const { DEFAULT_CONFIG } = require('../server/defaults');

const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const product = {
  id: 1, name: '测试商品', scene: 'temu', cost_cny: 3.2, sale_usd: 9.99, weight_g: 180,
  trend_score: 80, competition: 50, repurchase: 60, differentiation: 60,
  logistics: 'light', compliance: 'low', compliance_reviewed: 0, duty_rate: null, target_margin: null, notes: 'x'
};

test('四个因子的权重归一化后加总为 1，贡献之和等于基础分', () => {
  const r = computeScore(product, cfg, {});
  const weightSum = r.factors.reduce((s, f) => s + f.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 0.001);
  const contribution = r.factors.reduce((s, f) => s + f.contribution, 0);
  assert.ok(Math.abs(contribution - r.base_score) < 0.05);
  assert.equal(r.factors.length, 4);
});

test('趋势动量为正则加分，为负则减分，且封顶 ±12', () => {
  const up = computeScore(product, cfg, { momentumPct: 30 });
  const down = computeScore(product, cfg, { momentumPct: -30 });
  assert.ok(up.trend_bonus > 0);
  assert.ok(down.trend_bonus < 0);
  assert.ok(Math.abs(up.trend_bonus) <= 12);
  assert.ok(up.scout_score > down.scout_score);
});

test('竞争度超过阈值后扣分，且扣分幅度与超出的分数成正比', () => {
  const calm = computeScore({ ...product, competition: 40 }, cfg, {});
  const hot = computeScore({ ...product, competition: 85 }, cfg, {});
  const veryHot = computeScore({ ...product, competition: 95 }, cfg, {});
  assert.ok(hot.scout_score < calm.scout_score);
  assert.ok(veryHot.scout_score < hot.scout_score);
  assert.ok(hot.penalties.some((p) => p.key === 'competition'));
});

test('高合规风险且未复核时结论锁定为「合规待审」', () => {
  const blocked = computeScore({ ...product, compliance: 'high', compliance_reviewed: 0 }, cfg, {});
  assert.equal(blocked.verdict_key, 'review');
  assert.equal(blocked.verdict, '合规待审');
  const reviewed = computeScore({ ...product, compliance: 'high', compliance_reviewed: 1 }, cfg, {});
  assert.notEqual(reviewed.verdict_key, 'review');
});

test('置信度由字段完整度与数据新鲜度共同决定', () => {
  const fresh = computeScore(product, cfg, { freshnessDays: 0 });
  const stale = computeScore(product, cfg, { freshnessDays: 30 });
  const missing = computeScore({ ...product, weight_g: 0, notes: '' }, cfg, { freshnessDays: 0 });
  assert.ok(fresh.confidence > stale.confidence);
  assert.ok(fresh.confidence > missing.confidence);
  assert.ok(fresh.confidence <= 100);
});

test('结论随分数变化，并给出可执行动作', () => {
  const high = computeScore({ ...product, trend_score: 100, differentiation: 95, repurchase: 90, cost_cny: 1 }, cfg, { momentumPct: 20 });
  assert.ok(['main', 'test'].includes(high.verdict_key));
  assert.ok(high.next_action.length > 6);
  const low = computeScore({ ...product, trend_score: 10, differentiation: 5, repurchase: 5, cost_cny: 40 }, cfg, {});
  assert.equal(low.verdict_key, 'drop');
});

test('评分始终落在 0-100，且返回完整利润明细', () => {
  const r = computeScore({ ...product, trend_score: 100, cost_cny: 0.1, competition: 0 }, cfg, { momentumPct: 100 });
  assert.ok(r.scout_score >= 0 && r.scout_score <= 100);
  assert.ok(r.profit.breakdown.length >= 8);
  assert.ok(r.profit.max_cost_cny >= 0);
});
