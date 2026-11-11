'use strict';
/**
 * 版本化迁移。原则：
 *  1) 每次结构变更一个新版本，永不修改已发布版本；
 *  2) 旧版（v0.1）单租户库自动升级，保留原有商品/日报/快照；
 *  3) 整个迁移在一个事务内，失败可回滚。
 */
const { db } = require('./db');

const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-multitenant',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          plan TEXT NOT NULL DEFAULT 'free',
          status TEXT NOT NULL DEFAULT 'active',
          trial_ends_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'owner',
          status TEXT NOT NULL DEFAULT 'active',
          last_login_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tenant_id INTEGER NOT NULL,
          csrf TEXT NOT NULL,
          ip TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          scopes TEXT NOT NULL DEFAULT 'read',
          last_used_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_apikeys_tenant ON api_keys(tenant_id);

        CREATE TABLE IF NOT EXISTS settings (
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, key)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          user_id INTEGER,
          action TEXT NOT NULL,
          target TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          ip TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, created_at);

        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          quantity REAL NOT NULL DEFAULT 1,
          cost_usd REAL NOT NULL DEFAULT 0,
          meta TEXT NOT NULL DEFAULT '{}',
          day TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_tenant_day ON usage_events(tenant_id, kind, day);
      `);

      const hasProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
      const legacy = hasProducts && !/tenant_id/.test(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='products'").get().sql
      );

      // 老库升级时先建立默认租户，否则 products.tenant_id 外键无法满足
      if (legacy && db.prepare('SELECT COUNT(*) c FROM tenants').get().c === 0) {
        db.prepare(`INSERT INTO tenants (id, name, slug, plan, status, created_at)
          VALUES (1, '默认空间', 'default', 'pro', 'active', ?)`).run(new Date().toISOString());
      }

      if (legacy) migrateLegacy();

      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sku TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '未分类',
          scene TEXT NOT NULL DEFAULT 'temu',
          cost_cny REAL NOT NULL DEFAULT 0,
          sale_usd REAL NOT NULL DEFAULT 0,
          weight_g REAL NOT NULL DEFAULT 200,
          trend_score REAL NOT NULL DEFAULT 50,
          competition REAL NOT NULL DEFAULT 50,
          repurchase REAL NOT NULL DEFAULT 50,
          differentiation REAL NOT NULL DEFAULT 30,
          logistics TEXT NOT NULL DEFAULT 'light',
          compliance TEXT NOT NULL DEFAULT 'low',
          compliance_reviewed INTEGER NOT NULL DEFAULT 0,
          duty_rate REAL,
          target_margin REAL,
          notes TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_sku ON products(tenant_id, sku) WHERE sku <> '';

        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          trend_score REAL NOT NULL,
          price_usd REAL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL,
          UNIQUE (product_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_snap_tenant_day ON snapshots(tenant_id, day);

        CREATE TABLE IF NOT EXISTS reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          source TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          prompt_version TEXT NOT NULL DEFAULT '1',
          content TEXT NOT NULL,
          top_ids TEXT NOT NULL DEFAULT '[]',
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          UNIQUE (tenant_id, day)
        );

        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          rule TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          UNIQUE (tenant_id, product_id, rule, day)
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id, status, day);
      `);
    }
  },
  {
    version: 2,
    name: 'spu-fields',
    /** SPU 打通层：补上 scout 此前缺失的 D 卖点素材 / E 脚本成片 / F 商业化 字段。
     *  以 products 表为 SPU 主数据中枢，让选品→素材→脚本→成片→投放的数据互通。 */
    up() {
      const addCol = (col, def) => {
        const row = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('products') WHERE name = ?").get(col);
        if (!row.c) db.prepare(`ALTER TABLE products ADD COLUMN ${col} ${def}`).run();
      };
      // D 卖点素材
      addCol('selling_points', "TEXT NOT NULL DEFAULT ''");
      addCol('pain_points', "TEXT NOT NULL DEFAULT ''");
      addCol('target_audience', "TEXT NOT NULL DEFAULT ''");
      addCol('scenario', "TEXT NOT NULL DEFAULT ''");
      addCol('material_refs', "TEXT NOT NULL DEFAULT '[]'"); // JSON: [{name,url,type}]
      // E 内容生产
      addCol('script_15s', "TEXT NOT NULL DEFAULT ''");
      addCol('script_30s', "TEXT NOT NULL DEFAULT ''");
      addCol('script_60s', "TEXT NOT NULL DEFAULT ''");
      addCol('voiceover', "TEXT NOT NULL DEFAULT ''");
      addCol('content_tags', "TEXT NOT NULL DEFAULT ''");
      addCol('content_status', "TEXT NOT NULL DEFAULT 'none'"); // none/draft/reviewing/approved/delivered
      addCol('kling_task_id', "TEXT NOT NULL DEFAULT ''");
      addCol('heygen_task_id', "TEXT NOT NULL DEFAULT ''");
      // F 商业化
      addCol('customer_id', "TEXT NOT NULL DEFAULT ''");
      addCol('access_code', "TEXT NOT NULL DEFAULT ''");
      addCol('tier', "TEXT NOT NULL DEFAULT ''"); // 15/30/60
      addCol('order_status', "TEXT NOT NULL DEFAULT 'none'"); // none/paid/producing/delivered
      addCol('cost_ledger', "TEXT NOT NULL DEFAULT '[]'"); // JSON: [{kind,seconds,cost_usd,at}]
    }
  }
];

/** v0.1 单租户库 → v1 多租户库（数据保留） */
function migrateLegacy() {
  db.exec(`
    ALTER TABLE products RENAME TO products_legacy;
    ALTER TABLE reports RENAME TO reports_legacy;
    ALTER TABLE snapshots RENAME TO snapshots_legacy;
  `);
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sku TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '未分类',
      scene TEXT NOT NULL DEFAULT 'temu',
      cost_cny REAL NOT NULL DEFAULT 0,
      sale_usd REAL NOT NULL DEFAULT 0,
      weight_g REAL NOT NULL DEFAULT 200,
      trend_score REAL NOT NULL DEFAULT 50,
      competition REAL NOT NULL DEFAULT 50,
      repurchase REAL NOT NULL DEFAULT 50,
      differentiation REAL NOT NULL DEFAULT 30,
      logistics TEXT NOT NULL DEFAULT 'light',
      compliance TEXT NOT NULL DEFAULT 'low',
      compliance_reviewed INTEGER NOT NULL DEFAULT 0,
      duty_rate REAL,
      target_margin REAL,
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'legacy',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO products (id, tenant_id, name, category, scene, cost_cny, sale_usd, weight_g,
      trend_score, competition, repurchase, differentiation, logistics, compliance, notes,
      source, status, created_at, updated_at)
    SELECT id, 1, name, category, scene, cost_1688, sale_usd,
      CASE WHEN logistics = 'heavy' THEN 1200 ELSE 200 END,
      trend_score, competition, repurchase, differentiation, logistics, compliance, COALESCE(notes, ''),
      'legacy', 'active', created_at, updated_at
    FROM products_legacy;
  `);
  db.exec(`
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT 'legacy',
      content TEXT NOT NULL,
      top_ids TEXT NOT NULL DEFAULT '[]',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, day)
    );
    INSERT OR IGNORE INTO reports (id, tenant_id, day, source, model, prompt_version, content, top_ids, created_at)
    SELECT id, 1, day, source, COALESCE(model, ''), 'legacy', content, top_ids, created_at FROM reports_legacy;
  `);
  db.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      trend_score REAL NOT NULL,
      price_usd REAL,
      source TEXT NOT NULL DEFAULT 'legacy',
      created_at TEXT NOT NULL,
      UNIQUE (product_id, day)
    );
    INSERT OR IGNORE INTO snapshots (tenant_id, product_id, day, trend_score, created_at)
    SELECT 1, product_id, day, trend_score, created_at FROM snapshots_legacy ORDER BY created_at ASC;
  `);
  db.exec('DROP TABLE snapshots_legacy; DROP TABLE reports_legacy; DROP TABLE products_legacy;');
}

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (!pending.length) return MIGRATIONS.length;

  // 迁移期间关闭外键：重命名/重建表会短暂产生悬空引用，迁移末尾统一检查
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const m of pending) {
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up();
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
          .run(m.version, m.name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`迁移 v${m.version} (${m.name}) 失败：${e.message}`);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    throw new Error('迁移后外键校验失败：' + JSON.stringify(violations.slice(0, 5)));
  }
  return MIGRATIONS.length;
}

module.exports = { runMigrations, MIGRATIONS };
