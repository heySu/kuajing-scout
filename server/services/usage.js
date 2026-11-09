'use strict';
/** 用量与成本记账（LLM token、导出次数），支撑配额、账单与毛利分析。 */
const { db } = require('../db');
const { today, monthStart, nowIso } = require('../lib/time');

function record(tenantId, kind, { quantity = 1, costUsd = 0, meta = {} } = {}) {
  db.prepare(`INSERT INTO usage_events (tenant_id, kind, quantity, cost_usd, meta, day, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, kind, quantity, costUsd, JSON.stringify(meta), today(), nowIso());
}

function monthly(tenantId, kind) {
  const month = monthStart(today());
  return db.prepare(`SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(cost_usd),0) cost
    FROM usage_events WHERE tenant_id = ? AND kind = ? AND day >= ?`).get(tenantId, kind, month);
}

function summary(tenantId) {
  const month = monthStart(today());
  const rows = db.prepare(`SELECT kind, SUM(quantity) qty, SUM(cost_usd) cost FROM usage_events
    WHERE tenant_id = ? AND day >= ? GROUP BY kind`).all(tenantId, month);
  const out = { month, byKind: {}, totalCostUsd: 0 };
  for (const r of rows) {
    out.byKind[r.kind] = { quantity: r.qty, costUsd: Math.round(r.cost * 10000) / 10000 };
    out.totalCostUsd += r.cost;
  }
  out.totalCostUsd = Math.round(out.totalCostUsd * 10000) / 10000;
  return out;
}

module.exports = { record, monthly, summary };
