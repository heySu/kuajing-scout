'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeProfit } = require('../server/services/profit');
const { DEFAULT_CONFIG } = require('../server/defaults');

const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const base = {
  scene: 'temu', cost_cny: 3.2, sale_usd: 9.99, weight_g: 180,
  duty_rate: null, target_margin: null, logistics: 'light'
};

test('成本瀑布各项之和等于总成本，净利 = 售价 - 总成本', () => {
  const m = computeProfit(base, cfg);
  const sum = Math.round(m.breakdown.reduce((s, b) => s + b.usd, 0) * 100) / 100;
  assert.ok(Math.abs(sum - m.total_cost_usd) <= 0.05, `breakdown ${sum} vs ${m.total_cost_usd}`);
  assert.ok(Math.abs(m.net_profit_usd - (m.sale_usd - m.total_cost_usd)) <= 0.02);
});

test('毛利率按售价计算，而不是按净收入', () => {
  const m = computeProfit(base, cfg);
  const expected = (m.net_profit_usd / m.sale_usd) * 100;
  assert.ok(Math.abs(m.margin_pct - expected) <= 0.1);
  assert.ok(m.margin_pct < 70, '不应出现 v0.1 那种虚高毛利');
});

test('保本价处净利约为 0', () => {
  const m = computeProfit(base, cfg);
  assert.ok(m.break_even_usd > 0 && m.break_even_usd < m.sale_usd);
  const atBe = computeProfit({ ...base, sale_usd: m.break_even_usd }, cfg);
  assert.ok(Math.abs(atBe.net_profit_usd) <= 0.05, `净利 ${atBe.net_profit_usd}`);
});

test('可承受拿货价对应目标毛利率', () => {
  const m = computeProfit(base, cfg);
  assert.ok(m.max_cost_cny > 0);
  const atMax = computeProfit({ ...base, cost_cny: m.max_cost_cny }, cfg);
  assert.ok(Math.abs(atMax.margin_pct - m.target_margin * 100) <= 0.2, `${atMax.margin_pct} vs ${m.target_margin * 100}`);
});

test('亏损定价被识别并给出警告', () => {
  const m = computeProfit({ ...base, cost_cny: 60 }, cfg);
  assert.ok(m.net_profit_usd < 0);
  assert.ok(m.warnings.some((w) => w.includes('亏损')));
  assert.ok(m.max_cost_cny < 60, '可承受成本应低于当前拿货价');
});

test('海运头程低于空运，重货差异明显', () => {
  const heavy = { ...base, weight_g: 5000 };
  const air = computeProfit(heavy, { ...cfg, logistics: { ...cfg.logistics, mode: 'air' } });
  const sea = computeProfit(heavy, { ...cfg, logistics: { ...cfg.logistics, mode: 'sea' } });
  assert.ok(sea.total_cost_usd < air.total_cost_usd);
});

test('单品关税率优先于默认值', () => {
  const low = computeProfit({ ...base, duty_rate: 0 }, cfg);
  const high = computeProfit({ ...base, duty_rate: 0.5 }, cfg);
  assert.ok(high.total_cost_usd > low.total_cost_usd);
  assert.equal(low.duty_rate, 0);
});

test('TikTok 与 Temu 的抽成/投流假设不同', () => {
  const temu = computeProfit({ ...base, scene: 'temu' }, cfg);
  const tiktok = computeProfit({ ...base, scene: 'tiktok' }, cfg);
  assert.notEqual(temu.total_cost_usd, tiktok.total_cost_usd);
});

test('售价为 0 时不产生 NaN', () => {
  const m = computeProfit({ ...base, sale_usd: 0 }, cfg);
  assert.equal(m.margin_pct, 0);
  assert.ok(Number.isFinite(m.total_cost_usd));
  assert.ok(Number.isFinite(m.break_even_usd));
  assert.equal(m.net_profit_usd < 0, true);
});

/* ---------- v1.1：2026 低值免税取消后的固定税费与本地履约口径 ---------- */

const withFixedTaxes = (patch = {}) => ({ ...cfg, duty: { ...cfg.duty, ...patch } });
const withLocal = (patch = {}) => ({
  ...cfg,
  logistics: { ...cfg.logistics, fulfillmentModel: 'local', local: { ...cfg.logistics.local, ...patch } }
});

test('默认免税额度为 0，不再提示过时的 800 美元免税', () => {
  assert.equal(cfg.duty.deMinimisUsd, 0);
  const m = computeProfit(base, cfg);
  assert.ok(!m.warnings.some((w) => w.includes('低于目的国免税额度')));
  assert.ok(m.warnings.some((w) => w.includes('固定清关税费')));
});

test('每票固定税费计入成本与保本价，且与货值无关', () => {
  const c = withFixedTaxes({ perItemDutyUsd: 3.3, customsPerOrderUsd: 2 });
  const plain = computeProfit(base, cfg);
  const fixed = computeProfit(base, c);
  assert.ok(Math.abs((fixed.total_cost_usd - plain.total_cost_usd) - 5.3) < 0.02);
  assert.equal(fixed.fixed_taxes_usd, 5.3);
  assert.ok(fixed.break_even_usd > plain.break_even_usd);
  assert.ok(fixed.max_cost_cny < plain.max_cost_cny);
  const cheap = computeProfit({ ...base, sale_usd: 3 }, c);
  assert.equal(cheap.fixed_taxes_usd, 5.3);
  assert.ok(cheap.warnings.some((w) => w.includes('固定成本压平')));
});

test('固定税费下成本瀑布仍闭合，保本价处净利约 0', () => {
  const c = withFixedTaxes({ perItemDutyUsd: 3.3, customsPerOrderUsd: 2 });
  const m = computeProfit(base, c);
  const sum = Math.round(m.breakdown.reduce((s, b) => s + b.usd, 0) * 100) / 100;
  assert.ok(Math.abs(sum - m.total_cost_usd) <= 0.05);
  const atBe = computeProfit({ ...base, sale_usd: m.break_even_usd }, c);
  assert.ok(Math.abs(atBe.net_profit_usd) <= 0.05);
});

test('本地仓履约模式计入四项成本，直发模式不计入', () => {
  const c = withLocal({ inboundUsdPerUnit: 0.8, storageUsdPerUnit: 0.35, lastMileUsdPerUnit: 4.2, deadStockPct: 0.03 });
  const local = computeProfit(base, c);
  const direct = computeProfit(base, cfg);
  assert.equal(local.fulfillment_model, 'local');
  assert.equal(direct.fulfillment_model, 'direct');
  assert.equal(direct.local_cost_usd, 0);
  assert.ok(local.local_cost_usd > 5);
  const sum = Math.round(local.breakdown.reduce((s, b) => s + b.usd, 0) * 100) / 100;
  assert.ok(Math.abs(sum - local.total_cost_usd) <= 0.05);
  assert.ok(['inbound', 'storage', 'lastMile', 'deadStock'].every((k) => local.breakdown.some((b) => b.key === k)));
  assert.ok(local.break_even_usd > direct.break_even_usd);
});

test('本地仓模式下可承受拿货价反解仍精确', () => {
  const c = withLocal({ inboundUsdPerUnit: 0.8, storageUsdPerUnit: 0.35, lastMileUsdPerUnit: 4.2, deadStockPct: 0.03 });
  const m = computeProfit({ ...base, sale_usd: 29.99 }, c);
  assert.ok(m.max_cost_cny > 0);
  const atMax = computeProfit({ ...base, sale_usd: 29.99, cost_cny: m.max_cost_cny }, c);
  assert.ok(Math.abs(atMax.margin_pct - m.target_margin * 100) <= 0.2);
});

test('Temu 全托管口径不再扣投流与退货', () => {
  assert.equal(cfg.fees.temu.ad, 0);
  assert.equal(cfg.fees.temu.returns, 0);
  const m = computeProfit(base, cfg);
  assert.equal(m.breakdown.find((b) => b.key === 'ad').usd, 0);
  assert.equal(m.breakdown.find((b) => b.key === 'returns').usd, 0);
});

test('旧版 800 美元默认配置读时迁移，显式配置不被覆盖', () => {
  const { migrateLegacyConfig } = require('../server/defaults');
  const legacy = migrateLegacyConfig({ duty: { defaultRate: 0.25, deMinimisUsd: 800 } });
  assert.equal(legacy.duty.deMinimisUsd, undefined);
  const explicit = migrateLegacyConfig({ duty: { deMinimisUsd: 800, perItemDutyUsd: 3.3 } });
  assert.equal(explicit.duty.deMinimisUsd, 800);
});
