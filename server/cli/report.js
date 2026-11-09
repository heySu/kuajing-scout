'use strict';
/**
 * 生成日报（适合外部 cron / 容器 initContainer 调用，不依赖常驻进程）：
 *   node server/cli/report.js [--tenant default] [--day 2026-11-09] [--no-llm]
 */
const { initSchema, close } = require('../db');
const { config, warnings } = require('../config');
const { db } = require('../db');
const agent = require('../services/agent');
const { today } = require('../lib/time');

function arg(name, dflt = '') {
  const idx = process.argv.indexOf('--' + name);
  return idx > -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--') ? process.argv[idx + 1] : dflt;
}

async function main() {
  for (const w of warnings) console.warn('[config] ' + w);
  initSchema();
  const slug = arg('tenant', 'default');
  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) ||
    db.prepare('SELECT * FROM tenants ORDER BY id ASC LIMIT 1').get();
  if (!tenant) throw new Error('没有可用租户，请先启动服务完成初始化');
  const day = arg('day', today());
  const useLLM = !process.argv.includes('--no-llm');
  const result = await agent.generateReport({
    tenantId: tenant.id, day, useLLM, writeFile: true, sendNotify: true,
    actor: { userId: null, ip: 'cli' }
  });
  console.log(JSON.stringify({
    tenant: tenant.slug,
    day: result.report.day,
    source: result.report.source,
    model: result.report.model,
    tokens: { in: result.report.tokensIn, out: result.report.tokensOut },
    cost_usd: result.report.costUsd,
    alerts: result.alerts.length,
    fallback: result.fallbackReason || null,
    notify: result.notify
  }, null, 2));
  close();
}

main().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
