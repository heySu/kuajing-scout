'use strict';
/** 热度/价格快照：同一商品同一天只保留一行（后续写入覆盖），避免 v0.1 的重复插入。 */
const { db } = require('../db');
const { today, nowIso, addDays, daysBetween } = require('../lib/time');

function recordSnapshots(tenantId, dayStr = today(), source = 'cron') {
  const rows = db.prepare('SELECT id, trend_score, sale_usd FROM products WHERE tenant_id = ? AND status = ?')
    .all(tenantId, 'active');
  const stmt = db.prepare(`INSERT INTO snapshots (tenant_id, product_id, day, trend_score, price_usd, source, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(product_id, day) DO UPDATE SET
      trend_score = excluded.trend_score, price_usd = excluded.price_usd,
      source = excluded.source, created_at = excluded.created_at`);
  let n = 0;
  for (const p of rows) {
    stmt.run(tenantId, p.id, dayStr, p.trend_score, p.sale_usd, source, nowIso());
    n++;
  }
  return n;
}

function seriesFor(tenantId, productId, days = 30) {
  const from = addDays(today(), -(days - 1));
  return db.prepare(`SELECT day, trend_score, price_usd FROM snapshots
    WHERE tenant_id = ? AND product_id = ? AND day >= ? ORDER BY day ASC`)
    .all(tenantId, productId, from);
}

/** 一次性取出全租户近 N 天快照并按商品分组，避免逐商品查询 */
function seriesMap(tenantId, days = 30) {
  const from = addDays(today(), -(days - 1));
  const rows = db.prepare(`SELECT product_id, day, trend_score, price_usd FROM snapshots
    WHERE tenant_id = ? AND day >= ? ORDER BY product_id ASC, day ASC`)
    .all(tenantId, from);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push(r);
  }
  return map;
}

/** 数据源写入外部热度（如 Google Trends 信号折算），保留原始来源便于审计 */
function upsertExternal(tenantId, productId, dayStr, trendScore, source, priceUsd = null) {
  db.prepare(`INSERT INTO snapshots (tenant_id, product_id, day, trend_score, price_usd, source, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(product_id, day) DO UPDATE SET trend_score = excluded.trend_score,
      price_usd = COALESCE(excluded.price_usd, snapshots.price_usd), source = excluded.source, created_at = excluded.created_at`)
    .run(tenantId, productId, dayStr, trendScore, priceUsd, source, nowIso());
}

module.exports = { recordSnapshots, seriesFor, seriesMap, upsertExternal, daysBetween };
