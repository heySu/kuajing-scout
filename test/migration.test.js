'use strict';
/** 旧版 v0.1 单租户库升级到 v1 多租户库，数据必须保留。 */
const { prepareEnv } = require('./helpers');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dir = prepareEnv();
process.env.DB_PATH = path.join(dir, 'legacy.db');

const LEGACY_SQL = `
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, category TEXT NOT NULL, scene TEXT NOT NULL,
  cost_1688 REAL NOT NULL, sale_usd REAL NOT NULL,
  trend_score REAL NOT NULL DEFAULT 50, competition INTEGER NOT NULL DEFAULT 50,
  repurchase INTEGER NOT NULL DEFAULT 50, differentiation INTEGER NOT NULL DEFAULT 30,
  logistics TEXT NOT NULL DEFAULT 'light', compliance TEXT NOT NULL DEFAULT 'low',
  notes TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  model TEXT DEFAULT '', content TEXT NOT NULL, top_ids TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  day TEXT NOT NULL, trend_score REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_snap_day ON snapshots(day);
`;

const legacy = new DatabaseSync(path.join(dir, 'legacy.db'));
legacy.exec(LEGACY_SQL);
legacy.prepare(`INSERT INTO products (name, category, scene, cost_1688, sale_usd, trend_score, competition, repurchase, differentiation, logistics, compliance, notes, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('旧商品', '家居', 'temu', 3.2, 12.99, 77, 66, 55, 60, 'light', 'low', '迁移测试', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
legacy.prepare('INSERT INTO reports (day, source, model, content, top_ids, created_at) VALUES (?,?,?,?,?,?)')
  .run('2026-01-01', 'rule', '', '# 旧日报\n内容保留', '[1]', '2026-01-01T00:00:00.000Z');
const snap = legacy.prepare('INSERT INTO snapshots (product_id, day, trend_score, created_at) VALUES (?,?,?,?)');
snap.run(1, '2026-01-01', 70, '2026-01-01T00:00:00.000Z');
snap.run(1, '2026-01-01', 72, '2026-01-01T01:00:00.000Z'); // 同一天重复，应去重
snap.run(1, '2026-01-02', 75, '2026-01-02T00:00:00.000Z');
legacy.close();

const test = require('node:test');
const assert = require('node:assert/strict');
const { initSchema, db } = require('../server/db');

test('迁移保留商品/日报/快照并建立默认租户', () => {
  initSchema();
  const version = db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
  assert.equal(version, 1);

  const product = db.prepare('SELECT * FROM products').get();
  assert.equal(product.name, '旧商品');
  assert.equal(product.tenant_id, 1);
  assert.equal(product.cost_cny, 3.2);
  assert.equal(product.source, 'legacy');

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = 1').get();
  assert.equal(tenant.slug, 'default');

  const report = db.prepare('SELECT * FROM reports').get();
  assert.equal(report.day, '2026-01-01');
  assert.ok(report.content.includes('旧日报'));
  assert.equal(report.tenant_id, 1);
  assert.equal(report.prompt_version, 'legacy');

  const snaps = db.prepare('SELECT * FROM snapshots ORDER BY day').all();
  assert.equal(snaps.length, 2, '同一天重复快照应被去重');
  assert.equal(snaps[0].tenant_id, 1);

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(violations.length, 0);
});

test('迁移可重复执行（幂等）', () => {
  assert.doesNotThrow(() => initSchema());
  assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
});

test('旧库的 created_at/updated_at 与备注保留', () => {
  const p = db.prepare('SELECT notes, created_at FROM products').get();
  assert.equal(p.notes, '迁移测试');
  assert.equal(p.created_at, '2026-01-01T00:00:00.000Z');
});
