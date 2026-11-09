'use strict';
/** 演示/首次启动数据：商品池 + 30 天热度快照。生产环境可通过 IMPORT_ON_BOOT=0 关闭。 */
const { db, tx } = require('./db');
const { nowIso, today, addDays } = require('./lib/time');

const PRODUCTS = [
  ['磁吸车载支架 MagSafe', 'CAR-MAG-01', '车载配件', 'temu', 2.99, 9.99, 180, 82, 78, 45, 55, 'light', 'low', '类目 BEST-SELLER 常客，套装可差异化'],
  ['LED 圣诞氛围灯串', 'LED-XMAS-02', '节日灯具', 'temu', 2.80, 12.99, 150, 95, 65, 40, 60, 'light', 'mid', '黑五+圣诞备货窗口，需 FCC 认证'],
  ['折叠收纳箱三件套', 'BOX-FOLD-03', '家居收纳', 'temu', 11.90, 24.99, 1200, 70, 85, 55, 65, 'heavy', 'low', '红海标品，必须组合套装避开比价'],
  ['场景收纳·首饰旅行包', 'JWL-TRAV-04', '家居收纳', 'tiktok', 9.50, 22.99, 220, 74, 40, 50, 80, 'light', 'low', '细分场景款，比价池小，restock 内容友好'],
  ['多功能切菜器套装', 'KIT-CHOP-05', '厨房工具', 'temu', 4.50, 11.99, 260, 76, 72, 60, 50, 'light', 'mid', '刚需复购，刀头需 FDA 食品级材质报告'],
  ['自清洁宠物梳毛刷', 'PET-BRUSH-06', '宠物用品', 'tiktok', 6.00, 14.99, 120, 80, 58, 85, 60, 'light', 'low', '宠物类目复购王，短视频演示效果好'],
  ['平背耳钉 316L 套装', 'JWL-EAR-07', '饰品', 'tiktok', 2.50, 8.99, 30, 88, 55, 65, 70, 'light', 'low', '2026 Google Trends breakout，选持专利工厂'],
  ['睡眠嘴贴 30 片装', 'HLT-MOUTH-08', '健康睡眠', 'temu', 1.80, 7.99, 40, 91, 48, 70, 75, 'light', 'high', '利润王；listing 禁写医疗功效'],
  ['真空压缩袋组合', 'HOME-VAC-09', '家居收纳', 'temu', 3.20, 12.99, 380, 68, 75, 45, 55, 'light', 'low', '季节性稳定，套装提升客单'],
  ['电动清洁刷 USB', 'CLN-BRUSH-10', '家居清洁', 'temu', 9.80, 19.99, 420, 72, 68, 55, 45, 'light', 'mid', '宁波/慈溪产业带，改款空间大'],
  ['硅胶厨具 10 件套', 'KIT-SIL-11', '厨房工具', 'tiktok', 5.80, 18.99, 650, 78, 52, 65, 72, 'light', 'low', '材质分级+套装组合，避开单品比价'],
  ['编织藤耳环', 'JWL-RATTAN-12', '饰品', 'tiktok', 1.20, 5.99, 20, 65, 62, 40, 60, 'light', 'low', '2025 饰品销冠，义乌/广西产业带'],
  ['折叠露营车 200L', 'OUT-CART-13', '户外装备', 'temu', 168.00, 89.99, 9500, 71, 60, 35, 30, 'heavy', 'mid', '重货标品：头程+关税吞噬利润，典型反面案例'],
  ['硅胶折叠水杯', 'KIT-CUP-14', '厨房工具', 'temu', 6.50, 7.99, 180, 58, 70, 40, 35, 'light', 'low', '低价内卷，毛利过薄'],
  ['宠物自动喂食器', 'PET-FEED-15', '宠物用品', 'temu', 42.00, 49.99, 900, 66, 55, 50, 60, 'light', 'mid', '带电产品需 UL/FCC，客单高但售后成本高']
];

// 趋势方向：正数上升 / 负数下降，用于让演示数据的动量有意义
const TREND_DIR = [0.4, 1.1, -0.2, 0.8, 0.1, 0.9, 1.4, 1.2, -0.3, 0.2, 0.5, -1.0, -0.4, -0.8, 0.3];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedProducts(tenantId) {
  const count = db.prepare('SELECT COUNT(*) c FROM products WHERE tenant_id = ?').get(tenantId).c;
  if (count > 0) return { created: 0, snapshots: 0 };

  const rand = mulberry32(20261109);
  let snapshots = 0;
  tx(() => {
    const ins = db.prepare(`INSERT INTO products
      (tenant_id, name, sku, category, scene, cost_cny, sale_usd, weight_g, trend_score, competition,
       repurchase, differentiation, logistics, compliance, compliance_reviewed, notes, tags, source, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const snap = db.prepare(`INSERT INTO snapshots (tenant_id, product_id, day, trend_score, price_usd, source, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(product_id, day) DO UPDATE SET trend_score = excluded.trend_score, created_at = excluded.created_at`);
    PRODUCTS.forEach((row, idx) => {
      const [name, sku, category, scene, cost, sale, weight, trend, comp, rep, diff, logi, compliance, notes] = row;
      const ts = nowIso();
      const info = ins.run(tenantId, name, sku, category, scene, cost, sale, weight, trend, comp, rep, diff,
        logi, compliance, 0, notes, '', 'seed', 'active', ts, ts);
      const id = Number(info.lastInsertRowid);
      const dir = TREND_DIR[idx] || 0;
      for (let d = 29; d >= 0; d--) {
        const dayStr = addDays(today(), -d);
        const drift = dir * d * 0.75;
        const noise = (rand() - 0.5) * 2.2;
        const value = Math.max(1, Math.min(100, trend - drift + noise));
        snap.run(tenantId, id, dayStr, Math.round(value * 10) / 10, sale, 'seed', ts);
        snapshots++;
      }
    });
  });
  return { created: PRODUCTS.length, snapshots };
}

module.exports = { seedProducts, PRODUCTS };
