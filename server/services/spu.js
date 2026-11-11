'use strict';
/**
 * SPU 打通层：把「选品 → 素材 → 脚本 → 成片 → 投放」的数据归集到同一个商品对象。
 *
 * 设计：以 products 表为 SPU 主数据中枢（已含 A 标识 / B 选品 / C 成本利润），本服务补齐
 *   D 卖点素材 / E 内容生产 / F 商业化，并提供与前端零依赖工具（profit / listing）的 JSON 互通。
 * products 表的新列由 migrations v2 建立；本文件不依赖 products.js 的写路径，只复用其 getProduct（含 decorate）。
 */
const { db } = require('../db');
const { badRequest, notFound } = require('../lib/errors');
const { nowIso } = require('../lib/time');
const { getProduct } = require('./products');
const settings = require('./settings');
const audit = require('./audit');

/** 取租户汇率（USD→CNY），缺省 7.2，与利润引擎口径一致 */
function fxRate(tenantId) {
  try {
    const cfg = settings.getConfig(tenantId);
    return Number(cfg && cfg.fx && cfg.fx.usdCny) || 7.2;
  } catch { return 7.2; }
}

/** 本服务直接读写的 SPU 字段（均在 products 表 v2 迁移中建立） */
const SPU_FIELDS = [
  'selling_points', 'pain_points', 'target_audience', 'scenario', 'material_refs',
  'script_15s', 'script_30s', 'script_60s', 'voiceover', 'content_tags',
  'content_status', 'kling_task_id', 'heygen_task_id',
  'customer_id', 'access_code', 'tier', 'order_status', 'cost_ledger'
];

/** 可被跨工具导入合并的基础字段（走 products.update 重算评分） */
const BASE_IMPORTABLE = ['name', 'category', 'scene', 'cost_cny', 'sale_usd', 'duty_rate', 'target_margin'];

function jsonOr(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function jsonStr(v) {
  return typeof v === 'string' ? v : JSON.stringify(v ?? []);
}

function getRow(tenantId, id) {
  const row = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!row) throw notFound('商品不存在');
  return row;
}

/** 仅更新 SPU 字段（不含基础字段），material_refs / cost_ledger 以 JSON 文本落库 */
function writeFields(tenantId, id, fields, actor = {}) {
  const allowed = SPU_FIELDS.filter((f) => f in fields);
  if (!allowed.length) throw badRequest('没有可更新的 SPU 字段');
  const sets = [];
  const vals = [];
  for (const f of allowed) {
    sets.push(`${f} = ?`);
    vals.push(f === 'material_refs' || f === 'cost_ledger' ? jsonStr(fields[f]) : fields[f]);
  }
  sets.push('updated_at = ?');
  vals.push(nowIso(), id, tenantId);
  db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
  if (actor.userId) audit.log(tenantId, actor.userId, 'product.spu.update', String(id), allowed.join(','), actor.ip);
  return getRow(tenantId, id);
}

/** 完整 SPU 视图：合并商品主数据 + 计算层 + 内容生产 + 商业化 + 成本账本汇总 */
function getSpv(tenantId, id) {
  const p = getProduct(tenantId, id); // 已 decorate，JSON 字段已解析
  const material_refs = Array.isArray(p.material_refs) ? p.material_refs : [];
  const cost_ledger = Array.isArray(p.cost_ledger) ? p.cost_ledger : [];
  const totalCostUsd = cost_ledger.reduce((s, e) => s + (Number(e.cost_usd) || 0), 0);
  const totalCostUsdR = Math.round(totalCostUsd * 1e4) / 1e4;
  // 含成片（外采）成本后的净利：利润引擎净利（USD）扣减成本账本（USD）
  const baseNetUsd = Number(p.profit && p.profit.net_profit_usd) || 0;
  const netInclUsd = Math.round((baseNetUsd - totalCostUsdR) * 1e4) / 1e4;
  const fx = fxRate(tenantId);
  const netInclCny = Math.round(netInclUsd * fx * 100) / 100;
  return {
    spu_id: String(p.id),
    product_id: p.id,
    // A 标识
    name: p.name, sku: p.sku, category: p.category, scene: p.scene,
    // B 选品 + C 成本利润
    cost_cny: p.cost_cny, sale_usd: p.sale_usd, margin_pct: p.margin_pct,
    verdict: p.verdict, scout_score: p.scout_score,
    net_profit_usd: p.profit ? Math.round(baseNetUsd * 1e4) / 1e4 : 0,
    // D 卖点素材
    selling_points: p.selling_points || '',
    pain_points: p.pain_points || '',
    target_audience: p.target_audience || '',
    scenario: p.scenario || '',
    material_refs,
    // E 内容生产
    scripts: { '15': p.script_15s || '', '30': p.script_30s || '', '60': p.script_60s || '' },
    voiceover: p.voiceover || '',
    content_tags: p.content_tags || '',
    content_status: p.content_status || 'none',
    kling_task_id: p.kling_task_id || '',
    heygen_task_id: p.heygen_task_id || '',
    // F 商业化
    customer_id: p.customer_id || '',
    access_code: p.access_code || '',
    tier: p.tier || '',
    order_status: p.order_status || 'none',
    cost_ledger,
    total_cost_usd: totalCostUsdR,
    // 成本账本（成片/外采）对净利的侵蚀
    net_profit_incl_cost_usd: netInclUsd,
    net_profit_incl_cost_cny: netInclCny
  };
}

/** 供下游脚本 / 成片工具消费的精简 payload（去掉内部账本等实现细节） */
function exportPayload(tenantId, id) {
  const spv = getSpv(tenantId, id);
  const splitLines = (s) => (s ? String(s).split('\n').map((x) => x.trim()).filter(Boolean) : []);
  return {
    spu_id: spv.spu_id,
    name: spv.name,
    category: spv.category,
    scene: spv.scene,
    cost_cny: spv.cost_cny,
    sale_usd: spv.sale_usd,
    margin_pct: spv.margin_pct,
    verdict: spv.verdict,
    selling_points: splitLines(spv.selling_points),
    pain_points: splitLines(spv.pain_points),
    target_audience: spv.target_audience,
    scenario: spv.scenario,
    material_refs: spv.material_refs,
    scripts: spv.scripts,
    voiceover: spv.voiceover,
    content_tags: spv.content_tags,
    content_status: spv.content_status,
    generated_at: nowIso()
  };
}

/** 从 profit / listing 等前端工具导出的 SPU JSON 合并回商品（打通的关键动作） */
function importFromModules(tenantId, id, payload, actor = {}) {
  if (!payload || typeof payload !== 'object') throw badRequest('请提供模块导出的 SPU JSON');
  const products = require('./products');

  // 1) 基础字段走 products.update（会重算评分/利润）
  const base = {};
  for (const k of BASE_IMPORTABLE) {
    if (payload[k] !== undefined && payload[k] !== '') base[k] = payload[k];
  }
  if (Object.keys(base).length) products.update(tenantId, id, base, actor);

  // 2) SPU 字段直接写
  const spuFields = {};
  for (const k of SPU_FIELDS) {
    if (payload[k] !== undefined) spuFields[k] = payload[k];
  }
  const imported = Object.keys(base).concat(Object.keys(spuFields));
  if (Object.keys(spuFields).length) writeFields(tenantId, id, spuFields, actor);
  return { imported };
}

/** 按秒记账（对接可灵 / LLM 等按量计费，用于核算三档报价真实毛利） */
function addCostLedger(tenantId, id, entry, actor = {}) {
  const row = getRow(tenantId, id);
  const ledger = jsonOr(row.cost_ledger, []);
  ledger.push({
    kind: String(entry.kind || 'api').slice(0, 40),
    seconds: Number(entry.seconds) || 0,
    cost_usd: Math.round((Number(entry.cost_usd) || 0) * 1e4) / 1e4,
    at: nowIso()
  });
  writeFields(tenantId, id, { cost_ledger: ledger }, actor);
  return ledger;
}

module.exports = { SPU_FIELDS, getSpv, exportPayload, importFromModules, writeFields, addCostLedger };
