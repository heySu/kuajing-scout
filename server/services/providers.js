'use strict';
/**
 * 数据源接入层（商用最关键的一块）。
 * 竞品的数据壁垒来自自建采集/第三方数据授权，本项目的策略是：
 *   1) 手动维护 + CSV 批量导入（已支持）；
 *   2) 外部推送 API（卖家自有爬虫/数据服务商 → POST /api/signals）；
 *   3) Google Trends RSS 实验性接入（仅公共趋势信号，需外网）；
 *   4) 预留 HTTP JSON 拉取适配器。
 * 无论走哪条路，都写入 snapshots.source，保证「数据从哪来」可审计。
 */
const { config } = require('../config');
const { db } = require('../db');
const { badRequest, HttpError } = require('../lib/errors');
const { today, nowIso } = require('../lib/time');
const { upsertExternal } = require('./snapshots');
const log = require('../lib/logger');

const PROVIDERS = {
  manual: { key: 'manual', name: '手动维护', requiresNetwork: false, description: '在面板中录入/编辑，适合小批量精挑细选' },
  csv: { key: 'csv', name: 'CSV 导入', requiresNetwork: false, description: '从卖家精灵/Keepa/自有 Excel 导出后导入' },
  push: { key: 'push', name: '外部推送 API', requiresNetwork: false, description: '自有爬虫或数据服务商调用 POST /api/signals 写入热度与价格' },
  'google-trends': { key: 'google-trends', name: 'Google Trends RSS（实验性）', requiresNetwork: true, description: '公共趋势榜，仅作需求信号参考，不直接替代站内销量数据' }
};

function state(tenantId) {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, 'provider_state');
  return row ? JSON.parse(row.value) : null;
}

function saveState(tenantId, patch) {
  const next = { ...(state(tenantId) || {}), ...patch };
  db.prepare(`INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(tenantId, 'provider_state', JSON.stringify(next), nowIso());
  return next;
}

function status(tenantId) {
  return {
    active: config.dataProvider,
    providers: Object.values(PROVIDERS),
    llmConfigured: Boolean(config.llm.apiKey),
    state: state(tenantId)
  };
}

/** 解析 Google Trends RSS（不引 XML 库，容错解析 item） */
function parseTrendsRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const traffic = (block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/i) || [])[1] || '';
    if (!title) continue;
    items.push({
      title: decodeEntities(title.trim()),
      traffic: traffic.replace(/[^\d]/g, '')
    });
  }
  return items;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

/** 趋势量级 → 0-100 热度分（对数刻度，避免极端值压扁） */
function trafficToScore(traffic) {
  const n = Number(traffic) || 0;
  if (n <= 0) return null;
  return Math.round(Math.min(100, (Math.log10(n) / Math.log10(2000000)) * 100) * 10) / 10;
}

async function syncGoogleTrends(tenantId, { geo = 'US', apply = false } = {}) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  let xml;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'kuajing-scout/' + config.version },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    xml = await resp.text();
  } catch (e) {
    saveState(tenantId, { lastError: e.message, lastAttemptAt: nowIso() });
    throw new HttpError(502, 'provider_unavailable', 'Google Trends 暂不可用：' + e.message);
  }
  const signals = parseTrendsRss(xml).slice(0, 40).map((s) => ({ ...s, score: trafficToScore(s.traffic) }));

  // 用商品的 tags / sku 中的英文关键词做匹配，匹配不到就只展示信号，绝不臆造分数
  const products = db.prepare("SELECT id, name, tags, sku FROM products WHERE tenant_id = ? AND status='active'").all(tenantId);
  const matches = [];
  for (const p of products) {
    const keys = `${p.tags || ''},${p.sku || ''}`.toLowerCase().split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length >= 3);
    if (!keys.length) continue;
    const hit = signals.find((s) => keys.some((k) => s.title.toLowerCase().includes(k)));
    if (!hit) continue;
    matches.push({ product_id: p.id, name: p.name, signal: hit.title, score: hit.score });
    if (apply && hit.score) upsertExternal(tenantId, p.id, today(), hit.score, 'google-trends');
  }
  const st = saveState(tenantId, {
    lastSyncAt: nowIso(), lastError: null,
    lastResult: { provider: 'google-trends', geo, signals: signals.length, matched: matches.length, applied: apply }
  });
  log.info('google-trends 同步完成', { tenantId, signals: signals.length, matched: matches.length });
  return { provider: 'google-trends', geo, signals, matches, applied: apply, state: st };
}

/**
 * 外部推送：卖家自有采集器/数据服务商写入快照。
 * @param {Array<{sku?:string, product_id?:number, trend_score?:number, price_usd?:number, day?:string}>} items
 */
function ingestSignals(tenantId, items) {
  if (!Array.isArray(items) || !items.length) throw badRequest('items 必须是非空数组');
  if (items.length > 500) throw badRequest('单次最多 500 条');
  const dayStr = today();
  let applied = 0;
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const product = it.product_id
        ? db.prepare("SELECT id, trend_score FROM products WHERE id = ? AND tenant_id = ? AND status='active'").get(Number(it.product_id), tenantId)
        : it.sku
          ? db.prepare("SELECT id, trend_score FROM products WHERE sku = ? AND tenant_id = ? AND status='active'").get(String(it.sku), tenantId)
          : null;
      if (!product) throw new Error('未找到对应商品');
      const trend = it.trend_score === undefined ? null : Number(it.trend_score);
      if (trend !== null && (!Number.isFinite(trend) || trend < 0 || trend > 100)) throw new Error('trend_score 需在 0-100');
      const price = it.price_usd === undefined ? null : Number(it.price_usd);
      if (price !== null && (!Number.isFinite(price) || price <= 0)) throw new Error('price_usd 必须为正数');
      if (trend === null && price === null) throw new Error('至少提供 trend_score 或 price_usd');
      if (trend !== null) {
        upsertExternal(tenantId, product.id, dayStr, trend, 'push', price);
        db.prepare('UPDATE products SET trend_score = ? WHERE id = ? AND tenant_id = ?').run(trend, product.id, tenantId);
      } else {
        upsertExternal(tenantId, product.id, dayStr, product.trend_score, 'push', price);
      }
      applied++;
    } catch (e) {
      if (errors.length < 20) errors.push({ index: i, message: e.message });
    }
  }
  saveState(tenantId, { lastPushAt: nowIso(), lastResult: { provider: 'push', received: items.length, applied } });
  return { received: items.length, applied, failed: items.length - applied, errors };
}

module.exports = { PROVIDERS, status, syncGoogleTrends, ingestSignals, parseTrendsRss, trafficToScore };
