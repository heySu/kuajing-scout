'use strict';
/** 数据层：建表 + 种子数据。node:sqlite，零外部依赖。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'scout.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- 商品名
  category TEXT NOT NULL,           -- 品类
  scene TEXT NOT NULL,              -- 平台: temu / tiktok
  cost_1688 REAL NOT NULL,          -- 1688 拿货价(元)
  sale_usd REAL NOT NULL,           -- 平台售价($)
  trend_score REAL NOT NULL DEFAULT 50,  -- 热度分 0-100（趋势搜索/榜单综合）
  competition INTEGER NOT NULL DEFAULT 50, -- 竞争度 0-100，越高越卷
  repurchase INTEGER NOT NULL DEFAULT 50,  -- 复购属性 0-100
  differentiation INTEGER NOT NULL DEFAULT 30, -- 差异化空间 0-100（套装/定制/独家款）
  logistics TEXT NOT NULL DEFAULT 'light', -- light / heavy（是否重货）
  compliance TEXT NOT NULL DEFAULT 'low',  -- low / mid / high 合规风险
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,         -- YYYY-MM-DD
  source TEXT NOT NULL,             -- llm / rule
  model TEXT DEFAULT '',
  content TEXT NOT NULL,            -- markdown 日报
  top_ids TEXT NOT NULL,            -- JSON 数组：当日 top 商品 id
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  day TEXT NOT NULL,
  trend_score REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_day ON snapshots(day);
`);

function now() { return new Date().toISOString(); }
function day() { return new Date().toISOString().slice(0, 10); }

/** 汇率与平台扣点（集中定义，改这里全站生效） */
const CONFIG = {
  usdCny: Number(process.env.USD_CNY || 7.2),
  temuFeeRate: 0.18,     // Temu 全托管供货扣点近似（核价后平台抽成+履约）
  tiktokFeeRate: 0.24,   // TikTok: 平台6% + 达人佣金18%
  firstMileRatio: 0.18,  // 头程物流占售价比重（轻小件经验值）
  opexTemu: 0.10,        // Temu 运营成本占比（核价损耗/售后等）
  opexTiktok: 0.30       // TikTok 运营成本占比（投流+达人样品，经验上限值）
};

/** 种子商品池：来自 2026-11 热销调研（Temu 美国站 + TikTok 趋势） */
const SEED = [
  ['磁吸车载支架 MagSafe', '车载配件', 'temu', 2.99, 9.99, 82, 78, 45, 55, 'light', 'low', '类目 BEST-SELLER 常客，套装可差异化'],
  ['LED 圣诞氛围灯串', '节日灯具', 'temu', 2.80, 12.99, 95, 65, 40, 60, 'light', 'mid', '黑五+圣诞备货窗口，需 FCC 认证'],
  ['折叠收纳箱三件套', '家居收纳', 'temu', 11.90, 24.99, 70, 85, 55, 65, 'heavy', 'low', '红海标品，必须组合套装避开比价'],
  ['场景收纳·首饰旅行包', '家居收纳', 'tiktok', 9.50, 22.99, 74, 40, 50, 80, 'light', 'low', '细分场景款，比价池小，restock 内容友好'],
  ['多功能切菜器套装', '厨房工具', 'temu', 4.50, 11.99, 76, 72, 60, 50, 'light', 'mid', '刚需复购，刀头需 FDA 食品级材质报告'],
  ['自清洁宠物梳毛刷', '宠物用品', 'tiktok', 6.00, 14.99, 80, 58, 85, 60, 'light', 'low', '宠物类目复购王，短视频演示效果好'],
  ['平背耳钉 316L 套装', '饰品', 'tiktok', 2.50, 8.99, 88, 55, 65, 70, 'light', 'low', '2026 Google Trends breakout，选持专利工厂'],
  ['睡眠嘴贴 30 片装', '健康睡眠', 'temu', 1.80, 7.99, 91, 48, 70, 75, 'light', 'high', '利润王；listing 禁写医疗功效'],
  ['真空压缩袋组合', '家居收纳', 'temu', 3.20, 12.99, 68, 75, 45, 55, 'light', 'low', '季节性稳定，套装提升客单'],
  ['电动清洁刷 USB', '家居清洁', 'temu', 9.80, 19.99, 72, 68, 55, 45, 'light', 'mid', '宁波/慈溪产业带，改款空间大'],
  ['硅胶厨具 10 件套', '厨房工具', 'tiktok', 5.80, 18.99, 78, 52, 65, 72, 'light', 'low', '材质分级+套装组合，避开单品比价'],
  ['编织藤耳环', '饰品', 'tiktok', 1.20, 5.99, 65, 62, 40, 60, 'light', 'low', '2025 饰品销冠，义乌/广西产业带']
];

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (n > 0) return false;
  const ins = db.prepare(`INSERT INTO products
    (name, category, scene, cost_1688, sale_usd, trend_score, competition, repurchase, differentiation, logistics, compliance, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of SEED) ins.run(...s, now(), now());
  // 回填 7 天热度快照（带随机漂移，让趋势图有真实感）
  const rand = (seed => () => (seed = (seed * 9301 + 49297) % 233280) / 233280)(42);
  const snap = db.prepare('INSERT INTO snapshots (product_id, day, trend_score, created_at) VALUES (?,?,?,?)');
  const rows = db.prepare('SELECT id, trend_score FROM products').all();
  for (let d = 6; d >= 0; d--) {
    const dt = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    for (const r of rows) {
      const drift = (rand() - 0.45) * 6;
      snap.run(r.id, dt, Math.max(1, Math.min(100, r.trend_score - drift * (d / 2))), now());
    }
  }
  return true;
}

module.exports = { db, CONFIG, seedIfEmpty, now, day };
