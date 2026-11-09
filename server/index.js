'use strict';
/**
 * 启动入口：配置校验 → 数据库迁移 → 租户/账号初始化 → 路由注册 → 定时任务 → 优雅退出。
 */
const { config, warnings, errors } = require('./config');

if (errors.length) {
  console.error('\n启动失败，请修正以下配置：');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('\n参考 .env.example 或 docs/DEPLOY.md\n');
  process.exit(1);
}

const { db, initSchema, close } = require('./db');
const { createServer, route } = require('./app');
const log = require('./lib/logger');
const { today, timeInZone } = require('./lib/time');
const auth = require('./services/auth');
const { seedProducts } = require('./seed');
const agent = require('./services/agent');
const { recordSnapshots } = require('./services/snapshots');

for (const w of warnings) console.warn('[config] ' + w);

initSchema();

// 注册路由（顺序有意义：静态路径先于 :id）
require('./api/ops')(route);
require('./api/auth')(route);
require('./api/products')(route);
require('./api/reports')(route);
require('./api/alerts')(route);
require('./api/settings')(route);

const server = createServer();

function activeTenants() {
  return db.prepare("SELECT id FROM tenants WHERE status = 'active'").all();
}

async function bootstrap() {
  const boot = await auth.ensureBootstrap();
  const shouldSeed = !config.isProd || config.demoMode || process.env.IMPORT_ON_BOOT === '1';
  if (shouldSeed) {
    const seeded = seedProducts(boot.tenant.id);
    if (seeded.created) log.info('已写入演示商品池', seeded);
    if (!config.isProd || config.demoMode) {
      const r = await agent.ensureInitialReport(boot.tenant.id);
      if (r.created) log.info('已生成示例日报', r);
    }
  }
  if (!config.isProd || config.demoMode) {
    for (const t of activeTenants()) {
      try { recordSnapshots(t.id, today(), 'boot'); } catch (e) { log.warn('启动快照失败', { error: e.message }); }
    }
  }
  return boot;
}

let lastReportDay = null;
let lastSnapshotAt = Date.now();

async function tick() {
  if (!config.enableCron) return;
  const t = timeInZone();
  const day = today();
  const { hour, minute } = config.reportCron;
  const inWindow = t.hour === hour && t.minute >= minute && t.minute < minute + 5;
  if (inWindow && lastReportDay !== day) {
    lastReportDay = day;
    for (const tenant of activeTenants()) {
      try {
        const r = await agent.generateReport({
          tenantId: tenant.id, day, useLLM: true, writeFile: true, sendNotify: true,
          actor: { userId: null, ip: 'cron' }
        });
        log.info('定时日报完成', { tenantId: tenant.id, source: r.report.source, alerts: r.alerts.length, fallback: r.fallbackReason || null });
      } catch (e) {
        log.error('定时日报失败', { tenantId: tenant.id, error: e.message });
      }
    }
  }
  if (Date.now() - lastSnapshotAt >= config.snapshotIntervalHours * 3600_000) {
    lastSnapshotAt = Date.now();
    for (const tenant of activeTenants()) {
      try { recordSnapshots(tenant.id, day, 'cron'); } catch (e) { log.warn('快照失败', { error: e.message }); }
    }
  }
}

async function main() {
  const boot = await bootstrap();
  auth.cleanupSessions();

  server.listen(config.port, config.host, () => {
    log.info('服务已启动', {
      addr: `http://${config.host}:${config.port}`,
      env: config.env,
      timezone: config.timezone,
      llm: config.llm.apiKey ? config.llm.model : '未配置（规则引擎）',
      demoMode: config.demoMode
    });
    console.log('');
    console.log('  跨境选品侦察兵 · kuajing-scout v' + config.version);
    console.log(`  面板    http://${config.host}:${config.port}/`);
    console.log(`  健康    http://${config.host}:${config.port}/api/health`);
    console.log(`  时区    ${config.timezone}（日报按该时区切天）`);
    console.log(`  AI 日报 ${config.llm.apiKey ? '已启用 · ' + config.llm.model : '未配置 LLM_API_KEY，走规则引擎'}`);
    if (boot.demoCredentials) {
      console.log(`  演示账号 ${boot.demoCredentials.email} / ${boot.demoCredentials.password}`);
    }
    console.log('');
  });

  const timer = setInterval(() => { tick().catch((e) => log.error('cron tick failed', { error: e.message })); }, 60_000);
  timer.unref();
  lastSnapshotAt = Date.now();

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] 正在关闭…`);
    clearInterval(timer);
    server.close(async () => {
      try { close(); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', { error: e?.message, stack: e?.stack }));
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', { error: e?.message, stack: e?.stack });
    shutdown('uncaughtException');
  });
}

main().catch((e) => {
  log.error('启动失败', { error: e.message, stack: e.stack });
  process.exit(1);
});

module.exports = { server };
