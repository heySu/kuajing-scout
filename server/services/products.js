'use strict';
/** 商品池：筛选、排序、CRUD、CSV 导入导出。所有查询强制带 tenant_id。 */
const { db } = require('../db');
const { validate } = require('../lib/validate');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { parseCsv, toCsv } = require('../lib/csv');
const { nowIso, today } = require('../lib/time');
const { getConfig } = require('./settings');
const { computeScore, trendStatsFromSeries } = require('./scoring');
const { seriesMap } = require('./snapshots');
const { assertQuota, limitsOf } = require('./plans');
const audit = require('./audit');

const SCENE = ['temu', 'tiktok'];
const COMPLIANCE = ['low', 'mid', 'high'];
const LOGISTICS = ['light', 'heavy'];

const FIELD_SCHEMA = {
  name: { type: 'string', required: true, maxLen: 120 },
  sku: { type: 'string', maxLen: 60, default: '' },
  category: { type: 'string', maxLen: 40, default: '未分类' },
  scene: { type: 'enum', enum: SCENE, default: 'temu' },
  cost_cny: { type: 'number', required: true, min: 0, max: 1e6 },
  sale_usd: { type: 'number', required: true, min: 0.01, max: 1e6 },
  weight_g: { type: 'number', min: 1, max: 100000, default: 200 },
  trend_score: { type: 'number', min: 0, max: 100, default: 50 },
  competition: { type: 'number', min: 0, max: 100, default: 50 },
  repurchase: { type: 'number', min: 0, max: 100, default: 50 },
  differentiation: { type: 'number', min: 0, max: 100, default: 30 },
  logistics: { type: 'enum', enum: LOGISTICS, default: 'light' },
  compliance: { type: 'enum', enum: COMPLIANCE, default: 'low' },
  compliance_reviewed: { type: 'bool', default: false },
  duty_rate: { type: 'number', min: 0, max: 1, default: null, nullable: true },
  target_margin: { type: 'number', min: 0.01, max: 0.95, default: null, nullable: true },
  notes: { type: 'string', maxLen: 2000, default: '' },
  tags: { type: 'string', maxLen: 200, default: '' }
};

const WRITABLE = Object.keys(FIELD_SCHEMA);

function normalize(p) {
  return {
    ...p,
    compliance_reviewed: !!p.compliance_reviewed,
    duty_rate: p.duty_rate === undefined || p.duty_rate === null ? null : Number(p.duty_rate),
    target_margin: p.target_margin === undefined || p.target_margin === null ? null : Number(p.target_margin)
  };
}

function jsonOr(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function decorate(p, cfg, series) {
  const stats = trendStatsFromSeries(series || [], today());
  const scored = computeScore(normalize(p), cfg, stats);
  // SPU 打通层：material_refs / cost_ledger 在库中存为 JSON 文本，输出时解析为对象
  const costLedger = jsonOr(p.cost_ledger, []);
  const totalCostUsd = Math.round(
    (Array.isArray(costLedger) ? costLedger : []).reduce((s, e) => s + (Number(e.cost_usd) || 0), 0) * 1e4
  ) / 1e4;
  const fx = Number(cfg && cfg.fx && cfg.fx.usdCny) || 7.2;
  const baseNetUsd = Number(scored.profit && scored.profit.net_profit_usd) || 0;
  const netInclUsd = Math.round((baseNetUsd - totalCostUsd) * 1e4) / 1e4;
  const netInclCny = Math.round(netInclUsd * fx * 100) / 100;
  return {
    ...scored,
    content_status: p.content_status || 'none',
    material_refs: jsonOr(p.material_refs, []),
    cost_ledger: costLedger,
    // 成片/外采成本及其对净利的侵蚀（与详情页 SPU 视图口径一致）
    total_cost_usd: totalCostUsd,
    net_profit_incl_cost_usd: netInclUsd,
    net_profit_incl_cost_cny: netInclCny,
    series: (series || []).slice(-30)
  };
}

function getRaw(tenantId, id) {
  const row = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!row) throw notFound('商品不存在');
  return row;
}

function getProduct(tenantId, id) {
  const p = getRaw(tenantId, id);
  const cfg = getConfig(tenantId);
  const map = seriesMap(tenantId, 30);
  return decorate(p, cfg, map.get(p.id));
}

const SORTS = {
  score: (a, b) => b.scout_score - a.scout_score,
  margin: (a, b) => b.margin_pct - a.margin_pct,
  net: (a, b) => b.profit.net_profit_usd - a.profit.net_profit_usd,
  trend: (a, b) => b.trend_score - a.trend_score,
  competition: (a, b) => a.competition - b.competition,
  confidence: (a, b) => b.confidence - a.confidence,
  updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'),
  // 成片成本 / 含成片后净利（SPU 打通层新增）
  cost: (a, b) => b.total_cost_usd - a.total_cost_usd,
  netincl: (a, b) => b.net_profit_incl_cost_usd - a.net_profit_incl_cost_usd
};

function list(tenantId, query = {}) {
  const cfg = getConfig(tenantId);
  const status = query.status === 'all' || query.status === 'archived' ? query.status : 'active';
  const where = ['tenant_id = ?'];
  const params = [tenantId];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (SCENE.includes(query.scene)) { where.push('scene = ?'); params.push(query.scene); }
  if (query.category) { where.push('category = ?'); params.push(String(query.category).slice(0, 40)); }
  const q = String(query.q || '').trim().slice(0, 80);
  if (q) {
    where.push('(name LIKE ? OR notes LIKE ? OR tags LIKE ? OR category LIKE ? OR sku LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')}`).all(...params);

  const map = seriesMap(tenantId, 30);
  let items = rows.map((p) => decorate(p, cfg, map.get(p.id)));

  // 评分相关筛选在内存完成（分数是计算值）
  if (query.verdict && query.verdict !== 'all') items = items.filter((p) => p.verdict_key === query.verdict);
  // 内容生产状态筛选（none/draft/reviewing/approved/delivered）
  if (query.content_status && query.content_status !== 'all') {
    items = items.filter((p) => (p.content_status || 'none') === query.content_status);
  }
  if (query.minScore !== undefined && query.minScore !== null && query.minScore !== '') {
    items = items.filter((p) => p.scout_score >= Number(query.minScore));
  }
  if (query.maxScore !== undefined && query.maxScore !== null && query.maxScore !== '') {
    items = items.filter((p) => p.scout_score <= Number(query.maxScore));
  }
  if (query.risk === '1' || query.risk === 'true') {
    items = items.filter((p) => p.compliance === 'high' || p.competition >= 80 || p.profit.warnings.length > 1);
  }

  const sortFn = SORTS[query.sort] || SORTS.score;
  const dir = query.order === 'asc' ? -1 : 1;
  items.sort((a, b) => dir * sortFn(a, b));

  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(query.page) || 1));
  const paged = items.slice((page - 1) * pageSize, page * pageSize);

  const pool = items; // 筛选后的池子，用于 KPI
  const all = rows.length ? decorateAll(rows, cfg, map) : [];
  const active = all.filter((p) => p.status === 'active');

  return {
    items: paged,
    page,
    pageSize,
    total,
    totalPages,
    summary: summarize(pool),
    pool: summarize(active),
    facets: {
      categories: countBy(all, 'category'),
      scenes: countBy(all, 'scene'),
      verdicts: countBy(all, 'verdict_key')
    },
    weights: cfg.weights
  };
}

function decorateAll(rows, cfg, map) { return rows.map((p) => decorate(p, cfg, map.get(p.id))); }

/** 全量评分（日报/预警/导出使用），不参与分页 */
function allScored(tenantId, { status = 'active' } = {}) {
  const cfg = getConfig(tenantId);
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM products WHERE tenant_id = ?').all(tenantId)
    : db.prepare('SELECT * FROM products WHERE tenant_id = ? AND status = ?').all(tenantId, status);
  return decorateAll(rows, cfg, seriesMap(tenantId, 30));
}

function countBy(items, key) {
  const m = new Map();
  for (const it of items) m.set(it[key], (m.get(it[key]) || 0) + 1);
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function summarize(items) {
  const n = items.length;
  const sum = (fn) => items.reduce((s, p) => s + fn(p), 0);
  const sorted = [...items].sort((a, b) => b.scout_score - a.scout_score);
  const eligible = sorted.filter((p) => p.verdict_key !== 'review');
  const topOne = eligible[0] || sorted[0] || null;
  return {
    count: n,
    avgScore: n ? Math.round((sum((p) => p.scout_score) / n) * 10) / 10 : 0,
    avgMargin: n ? Math.round((sum((p) => p.margin_pct) / n) * 10) / 10 : 0,
    hot: items.filter((p) => p.trend_score >= 80).length,
    loss: items.filter((p) => p.profit.net_profit_usd <= 0).length,
    risky: items.filter((p) => p.compliance === 'high' || p.competition >= 80).length,
    stale: items.filter((p) => (p.data_freshness_days ?? 99) > 7).length,
    top: topOne ? { id: topOne.id, name: topOne.name, score: topOne.scout_score, verdict: topOne.verdict } : null
  };
}

function top(tenantId, n = 3) {
  const res = list(tenantId, { pageSize: 100, sort: 'score' });
  return res.items.slice(0, Math.max(1, Math.min(10, n)));
}

function create(tenantId, input, actor = {}) {
  assertQuota(tenantId, 'products');
  const data = normalize(validate(input, FIELD_SCHEMA));
  const ts = nowIso();
  let info;
  try {
    info = db.prepare(`INSERT INTO products
      (tenant_id, name, sku, category, scene, cost_cny, sale_usd, weight_g, trend_score, competition,
       repurchase, differentiation, logistics, compliance, compliance_reviewed, duty_rate, target_margin,
       notes, tags, source, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tenantId, data.name, data.sku, data.category, data.scene, data.cost_cny, data.sale_usd, data.weight_g,
        data.trend_score, data.competition, data.repurchase, data.differentiation, data.logistics, data.compliance,
        data.compliance_reviewed ? 1 : 0,
        data.duty_rate, data.target_margin, data.notes, data.tags, 'manual', 'active', ts, ts);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) throw conflict('该 SKU 已存在，请使用不同的编码或直接编辑原商品');
    throw e;
  }
  const id = Number(info.lastInsertRowid);
  audit.log(tenantId, actor.userId, 'product.create', String(id), data.name, actor.ip);
  return getProduct(tenantId, id);
}

function update(tenantId, id, input, actor = {}) {
  const existing = getRaw(tenantId, id);
  const patch = validate(input, FIELD_SCHEMA, { partial: true });
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) throw badRequest('没有可更新的字段');
  sets.push('updated_at = ?');
  vals.push(nowIso(), id, tenantId);
  try {
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) throw conflict('该 SKU 已被其他商品占用');
    throw e;
  }
  audit.log(tenantId, actor.userId, 'product.update', String(id), Object.keys(patch).join(','), actor.ip);
  return getProduct(tenantId, id);
}

function setStatus(tenantId, id, status, actor = {}) {
  if (!['active', 'archived'].includes(status)) throw badRequest('状态不合法');
  const existing = getRaw(tenantId, id);
  if (status === 'active' && existing.status === 'archived') assertQuota(tenantId, 'products');
  db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
    .run(status, nowIso(), id, tenantId);
  audit.log(tenantId, actor.userId, `product.${status === 'archived' ? 'archive' : 'restore'}`, String(id), existing.name, actor.ip);
  return { ok: true, status };
}

/** CSV 表头别名（中英文都接受，降低卖家上手成本） */
const ALIASES = {
  name: ['name', '商品名', '商品', '品名'],
  sku: ['sku', '编码', '货号'],
  category: ['category', '品类', '类目'],
  scene: ['scene', '平台', '渠道'],
  cost_cny: ['cost_cny', 'cost', '拿货价', '成本', '1688价格', '采购价'],
  sale_usd: ['sale_usd', 'price', '售价', '售价usd', '销售价'],
  weight_g: ['weight_g', 'weight', '重量', '重量g', '克重'],
  trend_score: ['trend_score', 'trend', '趋势分', '热度'],
  competition: ['competition', '竞争度', '竞争'],
  repurchase: ['repurchase', '复购', '复购率'],
  differentiation: ['differentiation', '差异化', '差异化空间'],
  logistics: ['logistics', '物流', '是否重货'],
  compliance: ['compliance', '合规', '合规风险'],
  duty_rate: ['duty_rate', '关税率', '关税'],
  target_margin: ['target_margin', '目标毛利率', '目标毛利'],
  notes: ['notes', '备注', '说明'],
  tags: ['tags', '标签']
};

function mapHeaders(headers) {
  const map = {};
  for (const h of headers) {
    const key = String(h).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.some((a) => a.toLowerCase() === key)) { map[h] = field; break; }
    }
  }
  return map;
}

function importCsv(tenantId, csvText, actor = {}) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw badRequest('CSV 内容为空');
  const { headers, records } = parseCsv(csvText);
  if (!headers.length) throw badRequest('CSV 缺少表头');
  if (records.length === 0) throw badRequest('CSV 没有数据行');
  if (records.length > 1000) throw badRequest('单次最多导入 1000 行，请拆分文件');

  const headerMap = mapHeaders(headers);
  const mapped = new Set(Object.values(headerMap));
  if (!mapped.has('name') || !mapped.has('cost_cny') || !mapped.has('sale_usd')) {
    throw badRequest('CSV 必须包含：商品名/拿货价/售价 三列');
  }

  const limits = limitsOf(tenantId);
  const current = db.prepare("SELECT COUNT(*) c FROM products WHERE tenant_id = ? AND status='active'").get(tenantId).c;
  const existingSku = new Set(db.prepare("SELECT sku FROM products WHERE tenant_id = ? AND sku <> ''").all(tenantId).map((r) => r.sku));
  const willCreate = records.filter((r) => {
    const sku = String(r[Object.keys(headerMap).find((h) => headerMap[h] === 'sku')] || '').trim();
    return !(sku && existingSku.has(sku));
  }).length;
  if (current + willCreate > limits.products) {
    throw badRequest(`导入后将超出套餐商品上限（${current}+${willCreate}/${limits.products}），请升级套餐或先归档商品`);
  }

  const result = { created: 0, updated: 0, failed: 0, errors: [] };
  const insert = db.prepare(`INSERT INTO products
    (tenant_id, name, sku, category, scene, cost_cny, sale_usd, weight_g, trend_score, competition,
     repurchase, differentiation, logistics, compliance, duty_rate, target_margin, notes, tags, source, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateStmt = db.prepare(`UPDATE products SET name=?, category=?, scene=?, cost_cny=?, sale_usd=?, weight_g=?,
    trend_score=?, competition=?, repurchase=?, differentiation=?, logistics=?, compliance=?, duty_rate=?,
    target_margin=?, notes=?, tags=?, source='csv', updated_at=? WHERE id=? AND tenant_id=?`);

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const obj = {};
    for (const [header, field] of Object.entries(headerMap)) {
      const v = raw[header];
      if (v !== undefined && v !== '') obj[field] = v;
    }
    try {
      if (obj.sku) obj.sku = String(obj.sku).trim();
      const data = normalize(validate(obj, FIELD_SCHEMA));
      const ts = nowIso();
      const existing = data.sku
        ? db.prepare('SELECT id FROM products WHERE tenant_id = ? AND sku = ?').get(tenantId, data.sku)
        : null;
      if (existing) {
        updateStmt.run(data.name, data.category, data.scene, data.cost_cny, data.sale_usd, data.weight_g,
          data.trend_score, data.competition, data.repurchase, data.differentiation, data.logistics,
          data.compliance, data.duty_rate, data.target_margin, data.notes, data.tags, ts, existing.id, tenantId);
        result.updated++;
      } else {
        insert.run(tenantId, data.name, data.sku, data.category, data.scene, data.cost_cny, data.sale_usd,
          data.weight_g, data.trend_score, data.competition, data.repurchase, data.differentiation,
          data.logistics, data.compliance, data.duty_rate, data.target_margin, data.notes, data.tags,
          'csv', 'active', ts, ts);
        result.created++;
      }
    } catch (e) {
      result.failed++;
      if (result.errors.length < 20) {
        result.errors.push({ row: i + 2, message: e.details?.fields?.[0]?.message || e.message });
      }
    }
  }
  audit.log(tenantId, actor.userId, 'product.import', 'csv', `created=${result.created},updated=${result.updated},failed=${result.failed}`, actor.ip);
  return result;
}

const EXPORT_COLUMNS = [
  ['name', '商品名'], ['sku', '编码'], ['category', '品类'], ['scene', '平台'],
  ['cost_cny', '拿货价CNY'], ['sale_usd', '售价USD'], ['weight_g', '重量g'],
  ['trend_score', '趋势分'], ['competition', '竞争度'], ['repurchase', '复购'],
  ['differentiation', '差异化'], ['compliance', '合规风险'], ['logistics', '物流'],
  ['scout_score', '综合分'], ['verdict', '结论'], ['margin_pct', '毛利率%'],
  ['profit_usd', '单件净利USD'], ['break_even_usd', '保本价USD'], ['max_cost_cny', '可承受成本CNY'],
  ['confidence', '数据置信度'], ['notes', '备注']
];

function exportCsv(tenantId, { status = 'active' } = {}) {
  const cfg = getConfig(tenantId);
  const rows = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND status = ? ORDER BY id ASC')
    .all(tenantId, status === 'archived' ? 'archived' : 'active');
  const map = seriesMap(tenantId, 30);
  const decorated = rows.map((p) => decorate(p, cfg, map.get(p.id)));
  const flat = decorated.map((p) => ({
    ...p,
    margin_pct: p.profit.margin_pct,
    profit_usd: p.profit.net_profit_usd,
    break_even_usd: p.profit.break_even_usd,
    max_cost_cny: p.profit.max_cost_cny
  }));
  const cols = EXPORT_COLUMNS.map(([key, label]) => ({ key, label }));
  const outRows = flat.map((p) => Object.fromEntries(cols.map((c) => [c.label, p[c.key]])));
  return toCsv(outRows, cols.map((c) => c.label));
}

function exportColumns() { return EXPORT_COLUMNS.map(([key, label]) => ({ key, label })); }

module.exports = {
  FIELD_SCHEMA, SCENE, COMPLIANCE, LOGISTICS, list, top, getProduct, create, update, setStatus,
  importCsv, exportCsv, exportColumns, getRaw, countBy, allScored
};
