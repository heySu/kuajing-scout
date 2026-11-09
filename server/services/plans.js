'use strict';
/** 套餐配额：限额检查 + 用量统计，用于自助订阅与防滥用。 */
const { db } = require('../db');
const { PLANS } = require('../defaults');
const { quotaExceeded, badRequest } = require('../lib/errors');
const { getConfig } = require('./settings');
const { today, monthStart } = require('../lib/time');

function getPlan(tenantId) {
  const row = db.prepare('SELECT plan, status, trial_ends_at FROM tenants WHERE id = ?').get(tenantId);
  if (!row) throw badRequest('租户不存在');
  return { ...(PLANS[row.plan] || PLANS.free), status: row.status, trialEndsAt: row.trial_ends_at };
}

function limitsOf(tenantId) { return getPlan(tenantId).limits; }

function usageOf(tenantId) {
  const month = monthStart(today());
  const products = db.prepare("SELECT COUNT(*) c FROM products WHERE tenant_id = ? AND status = 'active'").get(tenantId).c;
  const seats = db.prepare("SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND status = 'active'").get(tenantId).c;
  const llmReports = db.prepare("SELECT COUNT(*) c FROM reports WHERE tenant_id = ? AND source = 'llm' AND day >= ?").get(tenantId, month).c;
  const exports = db.prepare("SELECT COALESCE(SUM(quantity),0) s FROM usage_events WHERE tenant_id = ? AND kind = 'export' AND day >= ?")
    .get(tenantId, month).s;
  const apiKeys = db.prepare('SELECT COUNT(*) c FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL').get(tenantId).c;
  const cfg = getConfig(tenantId);
  const webhooks = cfg.alerts?.webhook?.enabled ? 1 : 0;
  return { products, seats, llmReportsPerMonth: llmReports, exportsPerMonth: exports, apiKeys, webhooks, month };
}

/** 超限抛 402，前端可据此展示升级引导 */
function assertQuota(tenantId, key, amount = 1) {
  const limits = limitsOf(tenantId);
  const limit = limits[key];
  if (limit === undefined) throw new Error('未知配额项: ' + key);
  const used = usageOf(tenantId)[key];
  if (used + amount <= limit) return { used, limit };
  const names = {
    products: '商品池数量', seats: '成员席位', llmReportsPerMonth: '本月 AI 日报次数',
    exportsPerMonth: '本月导出次数', apiKeys: 'API Key 数量', webhooks: 'Webhook 渠道数'
  };
  throw quotaExceeded(`${names[key] || key}已达上限（${used}/${limit}）`, {
    quota: key, used, limit, plan: getPlan(tenantId).key, upgrade: 'https://example.com/pricing'
  });
}

function setPlan(tenantId, planKey) {
  if (!PLANS[planKey]) throw badRequest('未知套餐');
  db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run(planKey, tenantId);
  return getPlan(tenantId);
}

module.exports = { getPlan, limitsOf, usageOf, assertQuota, setPlan };
