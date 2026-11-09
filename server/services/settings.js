'use strict';
/** 租户级配置：默认值深合并 + 强校验 + 落库（settings 表 key='config'）。 */
const { db } = require('../db');
const { DEFAULT_CONFIG, migrateLegacyConfig } = require('../defaults');
const { badRequest } = require('../lib/errors');
const { nowIso } = require('../lib/time');

const KEY = 'config';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch);
  if (typeof base !== 'object' || base === null) return clone(patch);
  if (typeof patch !== 'object' || patch === null) return clone(patch);
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

function readStored(tenantId) {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, KEY);
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

function getConfig(tenantId) {
  return deepMerge(DEFAULT_CONFIG, migrateLegacyConfig(readStored(tenantId)));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 校验完整配置对象，返回按字段组织的错误数组 */
function validateConfig(cfg) {
  const errs = [];
  const add = (field, message) => errs.push({ field, message });
  const rate = (field, v, max = 0.9) => { if (!isNum(v) || v < 0 || v > max) add(field, `必须是 0-${max} 的小数`); };

  const w = cfg.weights || {};
  const wSum = ['trend', 'profit', 'differentiation', 'repurchase']
    .reduce((s, k) => { const v = w[k]; if (!isNum(v) || v < 0 || v > 1) add(`weights.${k}`, '必须是 0-1 的小数'); return s + (isNum(v) ? v : 0); }, 0);
  if (wSum <= 0) add('weights', '权重之和必须大于 0');

  rate('fees.temu.commission', cfg.fees?.temu?.commission);
  rate('fees.temu.ad', cfg.fees?.temu?.ad);
  rate('fees.temu.returns', cfg.fees?.temu?.returns);
  rate('fees.temu.payment', cfg.fees?.temu?.payment);
  rate('fees.tiktok.commission', cfg.fees?.tiktok?.commission);
  rate('fees.tiktok.ad', cfg.fees?.tiktok?.ad);
  rate('fees.tiktok.returns', cfg.fees?.tiktok?.returns);
  rate('fees.tiktok.payment', cfg.fees?.tiktok?.payment);

  for (const k of ['airUsdPerKg', 'seaUsdPerKg', 'packagingUsd', 'qcUsd']) {
    const v = cfg.logistics?.[k];
    if (!isNum(v) || v < 0 || v > 500) add(`logistics.${k}`, '必须是 0-500 的数字');
  }
  if (!['air', 'sea'].includes(cfg.logistics?.mode)) add('logistics.mode', '必须是 air 或 sea');

  if (!isNum(cfg.fx?.usdCny) || cfg.fx.usdCny < 1 || cfg.fx.usdCny > 20) add('fx.usdCny', '汇率需在 1-20 之间');
  rate('fx.buffer', cfg.fx?.buffer, 0.2);

  rate('duty.defaultRate', cfg.duty?.defaultRate, 1);
  if (!isNum(cfg.duty?.deMinimisUsd) || cfg.duty.deMinimisUsd < 0) add('duty.deMinimisUsd', '必须是非负数字');
  for (const k of ['perItemDutyUsd', 'customsPerOrderUsd']) {
    const v = cfg.duty?.[k];
    if (!isNum(v) || v < 0 || v > 100) add(`duty.${k}`, '必须是 0-100 的美元金额');
  }
  if (!['direct', 'local'].includes(cfg.logistics?.fulfillmentModel)) {
    add('logistics.fulfillmentModel', '必须是 direct 或 local');
  }
  for (const k of ['inboundUsdPerUnit', 'storageUsdPerUnit', 'lastMileUsdPerUnit']) {
    const v = cfg.logistics?.local?.[k];
    if (!isNum(v) || v < 0 || v > 500) add(`logistics.local.${k}`, '必须是 0-500 的数字');
  }
  rate('logistics.local.deadStockPct', cfg.logistics?.local?.deadStockPct, 0.9);

  const s = cfg.scoring || {};
  rate('scoring.profitTargetMargin', s.profitTargetMargin, 1);
  if (!isNum(s.competitionThreshold) || s.competitionThreshold < 0 || s.competitionThreshold > 100) add('scoring.competitionThreshold', '必须在 0-100');
  if (!isNum(s.competitionPenalty) || s.competitionPenalty < 0 || s.competitionPenalty > 2) add('scoring.competitionPenalty', '必须在 0-2');
  for (const k of ['low', 'mid', 'high']) {
    const v = s.compliancePenalty?.[k];
    if (!isNum(v) || v < 0 || v > 30) add(`scoring.compliancePenalty.${k}`, '必须在 0-30');
  }
  for (const k of ['main', 'test', 'watch']) {
    const v = s.verdicts?.[k];
    if (!isNum(v) || v < 0 || v > 100) add(`scoring.verdicts.${k}`, '必须在 0-100');
  }
  if (s.verdicts && !(s.verdicts.main > s.verdicts.test && s.verdicts.test > s.verdicts.watch)) {
    add('scoring.verdicts', '阈值需满足 主推 > 测款 > 观望');
  }

  const a = cfg.alerts || {};
  if (!isNum(a.scoreThreshold) || a.scoreThreshold < 0 || a.scoreThreshold > 100) add('alerts.scoreThreshold', '必须在 0-100');
  if (!isNum(a.trendDropPct) || a.trendDropPct < 0 || a.trendDropPct > 100) add('alerts.trendDropPct', '必须在 0-100');
  if (!isNum(a.competitionHigh) || a.competitionHigh < 0 || a.competitionHigh > 100) add('alerts.competitionHigh', '必须在 0-100');
  if (typeof a.complianceHigh !== 'boolean') add('alerts.complianceHigh', '必须是布尔值');
  if (a.webhook) {
    if (!['wecom', 'feishu', 'slack', 'serverchan', 'generic'].includes(a.webhook.type)) add('alerts.webhook.type', '不支持的渠道类型');
    if (!/^https?:\/\//.test(String(a.webhook.url || ''))) add('alerts.webhook.url', '必须是 http(s) 地址');
    if (typeof a.webhook.enabled !== 'boolean') add('alerts.webhook.enabled', '必须是布尔值');
  }

  const n = cfg.report?.topN;
  if (!Number.isInteger(n) || n < 1 || n > 10) add('report.topN', '必须是 1-10 的整数');

  return errs;
}

function updateConfig(tenantId, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('配置必须是对象');
  const current = getConfig(tenantId);
  const next = deepMerge(current, patch);
  const errs = validateConfig(next);
  if (errs.length) throw badRequest('配置校验失败', { fields: errs });
  db.prepare(`INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(tenantId, KEY, JSON.stringify(next), nowIso());
  return next;
}

function resetConfig(tenantId) {
  db.prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?').run(tenantId, KEY);
  return getConfig(tenantId);
}

module.exports = { getConfig, updateConfig, resetConfig, validateConfig, deepMerge, migrateLegacyConfig };
