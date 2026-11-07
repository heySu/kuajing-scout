'use strict';
/** 评分引擎 + 选品日报 Agent。LLM 可选（OpenAI 兼容接口），无 Key 时走规则引擎。 */
const fs = require('node:fs');
const path = require('node:path');
const { db, CONFIG, now, day } = require('./db');

/* ---------------- 评分引擎 ---------------- */

/** 综合分：趋势 40% + 利润 25% + 差异化 20% + 复购 15%，竞争度与合规作为惩罚项 */
function scoreProduct(p) {
  const revenueCny = p.sale_usd * CONFIG.usdCny * (1 - CONFIG.firstMileRatio);
  const feeRate = p.scene === 'tiktok' ? CONFIG.tiktokFeeRate : CONFIG.temuFeeRate;
  const opex = p.scene === 'tiktok' ? CONFIG.opexTiktok : CONFIG.opexTemu;
  const netCny = revenueCny * (1 - feeRate) * (1 - opex);
  const profitCny = netCny - p.cost_1688;
  const margin = profitCny / netCny;                       // 毛利率 0-1
  const profitScore = Math.max(0, Math.min(100, margin * 160)); // 62.5% 利率封顶 100

  const trend = p.trend_score;
  const diff = p.differentiation;
  const rep = p.repurchase;

  let total = trend * 0.4 + profitScore * 0.25 + diff * 0.2 + rep * 0.15;
  // 惩罚项：竞争红海 & 合规风险
  total -= Math.max(0, p.competition - 60) * 0.25;
  const compliancePenalty = { low: 0, mid: 3, high: 6 }[p.compliance] || 0;
  total -= compliancePenalty;
  total = Math.round(Math.max(0, Math.min(100, total)) * 10) / 10;

  const logisticsFee = p.logistics === 'heavy' ? '重货：头程占比建议上调至 25%' : '轻小件';
  return {
    ...p,
    profit_usd: Math.round((profitCny / CONFIG.usdCny) * 100) / 100,
    margin_pct: Math.round(margin * 1000) / 10,
    scout_score: total,
    verdict: total >= 75 ? '重点主推' : total >= 60 ? '可以测款' : '观望/放弃',
    logistics_note: logisticsFee
  };
}

function listProducts() {
  return db.prepare('SELECT * FROM products ORDER BY updated_at DESC').all().map(scoreProduct);
}

function topProducts(n = 3) {
  return listProducts()
    .sort((a, b) => b.scout_score - a.scout_score)
    .slice(0, n);
}

function trendSeries(productId) {
  return db.prepare(
    'SELECT day, trend_score FROM snapshots WHERE product_id = ? ORDER BY day ASC'
  ).all(productId);
}

function recordSnapshot() {
  const ins = db.prepare('INSERT INTO snapshots (product_id, day, trend_score, created_at) VALUES (?,?,?,?)');
  for (const p of db.prepare('SELECT id, trend_score FROM products').all()) {
    ins.run(p.id, day(), p.trend_score, now());
  }
}

/* ---------------- 日报 Agent ---------------- */

const SYSTEM_PROMPT = `你是一位跨境电商选品顾问。基于给定的商品池评分数据，写一份简明扼要的中文选品日报：
1. 今日主推（前3名）：各一段，说明为什么值得做、切入打法（套装/差异化/模式选择）
2. 风险提示：点名竞争度过高或合规风险的商品
3. 一句话总结明日动作
要求：直接给结论，不写废话，不堆形容词，总长不超过 500 字。输出 markdown。`;

async function callLLM(products) {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!apiKey) return null;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '商品池评分数据(JSON)：\n' + JSON.stringify(products.map(p => ({
        name: p.name, category: p.category, scene: p.scene, cost_1688: p.cost_1688,
        sale_usd: p.sale_usd, margin_pct: p.margin_pct, trend: p.trend_score,
        competition: p.competition, differentiation: p.differentiation,
        compliance: p.compliance, scout_score: p.scout_score, verdict: p.verdict
      })), null, 1) }
    ],
    temperature: 0.4
  });

  const resp = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body,
    signal: AbortSignal.timeout(60000)
  });
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

/** 无 LLM 时的规则版日报 */
function ruleReport(products, top3) {
  const lines = [];
  lines.push(`# 跨境选品日报 ${day()}`);
  lines.push('');
  lines.push('> 本日报由规则引擎生成（未配置 LLM_API_KEY）。评分 = 趋势40% + 利润25% + 差异化20% + 复购15%，竞争与合规作惩罚项。');
  lines.push('');
  lines.push('## 今日主推');
  for (const p of top3) {
    lines.push(`- **${p.name}**（${p.scene} · 综合分 ${p.scout_score}）：毛利率 ${p.margin_pct}%，单件净利 $${p.profit_usd}。${p.notes} 打法建议：${p.differentiation >= 65 ? '做套装/独家款拉高客单，避开同款比价' : '小单测款（30-50件），数据好再追加'}。`);
  }
  const risky = products.filter(p => p.competition >= 75 || p.compliance === 'high');
  if (risky.length) {
    lines.push('');
    lines.push('## 风险提示');
    for (const p of risky) {
      const why = p.competition >= 75 ? '竞争红海（' + p.competition + '）' : '合规敏感（' + p.compliance + '）';
      lines.push(`- ${p.name}：${why}，${p.compliance === 'high' ? 'listing 严禁医疗/功效宣称' : '必须做出可识别差异再上'}。`);
    }
  }
  lines.push('');
  lines.push('## 明日动作');
  lines.push(`把「${top3[0].name}」做成首推：先在 1688 拿样 1-3 件验货，同步准备 ${top3[0].scene === 'tiktok' ? '达人寄样名单（周联系 50-100 个腰尾部家居/好物达人）' : '套装组合方案与首报价（期望价 × 1.15 上浮）'}。`);
  return lines.join('\n');
}

/** 生成并落库日报，返回 {day, source, model, content} */
async function generateReport({ persist = true, writeFile = true } = {}) {
  const products = listProducts();
  const top3 = products.sort((a, b) => b.scout_score - a.scout_score).slice(0, 3);

  let content = null, source = 'rule', model = '';
  try {
    content = await callLLM(products);
    if (content) { source = 'llm'; model = process.env.LLM_MODEL || 'gpt-4o-mini'; }
  } catch (e) {
    console.error('[agent] LLM 调用失败，降级规则引擎:', e.message);
  }
  if (!content) content = ruleReport(products, top3);

  if (persist) {
    db.prepare(`INSERT INTO reports (day, source, model, content, top_ids, created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(day) DO UPDATE SET source=excluded.source, model=excluded.model,
        content=excluded.content, top_ids=excluded.top_ids, created_at=excluded.created_at`)
      .run(day(), source, model, content, JSON.stringify(top3.map(p => p.id)), now());
  }
  if (writeFile) {
    const dir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `daily-${day()}.md`), content, 'utf8');
  }
  return { day: day(), source, model, content };
}

function listReports(limit = 14) {
  return db.prepare('SELECT id, day, source, model, top_ids, created_at FROM reports ORDER BY day DESC LIMIT ?').all(limit);
}

function getReport(d) {
  return db.prepare('SELECT * FROM reports WHERE day = ?').get(d);
}

module.exports = { scoreProduct, listProducts, topProducts, trendSeries, recordSnapshot, generateReport, listReports, getReport };
