'use strict';
/** 预警规则引擎：按天去重落库，供面板展示与 Webhook 推送。 */
const { db } = require('../db');
const { today, nowIso } = require('../lib/time');
const { notFound } = require('../lib/errors');

const RULE_META = {
  score_high: { label: '高分机会', level: 'info' },
  competition_high: { label: '竞争红海', level: 'warn' },
  compliance_high: { label: '合规敏感', level: 'critical' },
  trend_drop: { label: '热度下滑', level: 'warn' },
  loss: { label: '亏损定价', level: 'critical' },
  low_confidence: { label: '数据不足', level: 'info' }
};

function buildCandidates(tenantId, products, cfg) {
  const dayStr = today();
  const out = [];
  const a = cfg.alerts || {};
  for (const p of products) {
    if (p.scout_score >= (a.scoreThreshold ?? 78)) {
      out.push({ product: p, rule: 'score_high', level: 'info', message: `综合分 ${p.scout_score}，${p.verdict}；单件净利 $${p.profit.net_profit_usd}，毛利率 ${p.margin_pct}%` });
    }
    if (p.competition >= (a.competitionHigh ?? 80)) {
      out.push({ product: p, rule: 'competition_high', level: 'warn', message: `竞争度 ${p.competition}，已进入红海区，需靠套装/差异化避开比价` });
    }
    if (a.complianceHigh !== false && p.compliance === 'high' && !p.compliance_reviewed) {
      out.push({ product: p, rule: 'compliance_high', level: 'critical', message: '高合规风险且未完成复核，禁止主推与功效宣称' });
    }
    if (p.trend_momentum_pct <= -(a.trendDropPct ?? 15)) {
      out.push({ product: p, rule: 'trend_drop', level: 'warn', message: `近 30 天热度动量 ${p.trend_momentum_pct}%，注意需求转弱` });
    }
    if (p.profit.net_profit_usd <= 0) {
      out.push({ product: p, rule: 'loss', level: 'critical', message: `当前定价单件净利 $${p.profit.net_profit_usd}，保本价 $${p.profit.break_even_usd ?? '-'}` });
    } else if (p.confidence < 65) {
      out.push({ product: p, rule: 'low_confidence', level: 'info', message: `数据置信度 ${p.confidence}，建议补齐重量/关税/快照后再决策` });
    }
  }
  return out.map((c) => ({ ...c, day: dayStr, tenantId }));
}

function evaluate(tenantId, products, cfg) {
  const candidates = buildCandidates(tenantId, products, cfg);
  const ins = db.prepare(`INSERT INTO alerts (tenant_id, product_id, day, rule, level, message, status, created_at)
    VALUES (?,?,?,?,?,?, 'open', ?)
    ON CONFLICT(tenant_id, product_id, rule, day) DO NOTHING`);
  const created = [];
  for (const c of candidates) {
    const info = ins.run(tenantId, c.product.id, c.day, c.rule, c.level, c.message, nowIso());
    if (info.changes > 0) {
      created.push({
        product_id: c.product.id,
        product_name: c.product.name,
        rule: c.rule,
        rule_label: RULE_META[c.rule]?.label || c.rule,
        level: c.level,
        message: c.message,
        day: c.day
      });
    }
  }
  return created;
}

function list(tenantId, { status = 'open', limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = db.prepare(`SELECT a.*, p.name AS product_name, p.scene
    FROM alerts a JOIN products p ON p.id = a.product_id
    WHERE a.tenant_id = ? AND (? = 'all' OR a.status = ?)
    ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.id DESC
    LIMIT ?`).all(tenantId, status, status, lim);
  return rows.map((r) => ({ ...r, rule_label: RULE_META[r.rule]?.label || r.rule }));
}

function summary(tenantId) {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status='open' AND level='critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status='open' AND level='warn' THEN 1 ELSE 0 END) AS warn
    FROM alerts WHERE tenant_id = ?`).get(tenantId);
  return { open: row.open || 0, critical: row.critical || 0, warn: row.warn || 0 };
}

function ack(tenantId, id) {
  const info = db.prepare("UPDATE alerts SET status='acked' WHERE id = ? AND tenant_id = ? AND status='open'").run(id, tenantId);
  if (!info.changes) throw notFound('预警不存在或已处理');
  return { ok: true };
}

function ackAll(tenantId) {
  const info = db.prepare("UPDATE alerts SET status='acked' WHERE tenant_id = ? AND status='open'").run(tenantId);
  return { ok: true, acked: info.changes };
}

module.exports = { evaluate, list, summary, ack, ackAll, RULE_META, buildCandidates };
