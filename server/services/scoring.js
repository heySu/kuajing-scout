'use strict';
/**
 * 评分引擎 v2：
 *  - 权重与阈值来自租户配置，可被运营按品类调参，而不是写死在代码里；
 *  - 趋势分引入近 7 天动量（来自 snapshots），避免「静态高分」；
 *  - 输出可解释的因素贡献、惩罚项与数据置信度，商用产品不能只给一个黑盒分数；
 *  - 高合规风险商品在完成合规复核前不允许给出「主推」结论。
 */
const { computeProfit, round2, clamp } = require('./profit');
const { today, daysBetween } = require('../lib/time');

const FACTOR_LABELS = {
  trend: '趋势热度',
  profit: '利润空间',
  differentiation: '差异化空间',
  repurchase: '复购属性'
};

function trendStatsFromSeries(series = [], todayStr = today()) {
  const points = series.filter((s) => Number.isFinite(Number(s.trend_score)));
  if (!points.length) return { momentumPct: 0, freshnessDays: null, points: 0, last: null, first: null };
  const first = Number(points[0].trend_score);
  const last = Number(points[points.length - 1].trend_score);
  const momentumPct = first > 0 ? ((last - first) / first) * 100 : 0;
  return {
    momentumPct: round2(momentumPct),
    freshnessDays: daysBetween(points[points.length - 1].day, todayStr),
    points: points.length,
    last,
    first
  };
}

function computeScore(p, cfg, stats = {}) {
  const weights = cfg.weights || {};
  const wsum = ['trend', 'profit', 'differentiation', 'repurchase'].reduce((s, k) => s + (Number(weights[k]) || 0), 0) || 1;
  const norm = Object.fromEntries(Object.keys(FACTOR_LABELS).map((k) => [k, (Number(weights[k]) || 0) / wsum]));

  const profit = computeProfit(p, cfg);
  const target = Math.max(0.1, Number(cfg.scoring?.profitTargetMargin) || 0.45);
  const profitScore = clamp(((profit.margin_pct / 100 - 0.05) / (target - 0.05)) * 100, 0, 100);

  const momentum = Number(stats.momentumPct) || 0;
  const momentumBonus = clamp(momentum * 0.6, -12, 12);
  const trendScore = clamp((Number(p.trend_score) || 0) + momentumBonus, 0, 100);
  const diffScore = clamp(Number(p.differentiation) || 0, 0, 100);
  const repScore = clamp(Number(p.repurchase) || 0, 0, 100);

  const raw = { trend: trendScore, profit: profitScore, differentiation: diffScore, repurchase: repScore };
  const factors = Object.entries(raw).map(([key, score]) => ({
    key,
    label: FACTOR_LABELS[key],
    weight: round2(norm[key] * 1000) / 1000,
    score: round2(score),
    contribution: round2(score * norm[key])
  }));

  const penalties = [];
  const competition = clamp(Number(p.competition) || 0, 0, 100);
  const threshold = Number(cfg.scoring?.competitionThreshold) || 60;
  if (competition > threshold) {
    const pts = round2((competition - threshold) * (Number(cfg.scoring?.competitionPenalty) || 0.25));
    penalties.push({ key: 'competition', label: '竞争红海', points: pts, note: `竞争度 ${competition} > ${threshold}` });
  }
  const compLevel = ['low', 'mid', 'high'].includes(p.compliance) ? p.compliance : 'low';
  const compPenalty = Number(cfg.scoring?.compliancePenalty?.[compLevel]) || 0;
  if (compPenalty > 0) {
    penalties.push({
      key: 'compliance',
      label: '合规风险',
      points: compPenalty,
      note: compLevel === 'high' ? '需资质/认证，禁功效宣称' : '需补充认证或检测报告'
    });
  }

  const base = factors.reduce((s, f) => s + f.contribution, 0);
  const total = round2(clamp(base - penalties.reduce((s, x) => s + x.points, 0), 0, 100));

  // 数据置信度：字段完整度 60% + 数据新鲜度 40%
  let completeness = 0;
  if (Number(p.cost_cny) > 0) completeness += 30;
  if (Number(p.sale_usd) > 0) completeness += 30;
  if (Number(p.weight_g) > 0) completeness += 15;
  if (p.duty_rate !== null && p.duty_rate !== undefined) completeness += 15;
  if (p.notes) completeness += 10;
  completeness = Math.min(100, completeness);
  const fresh = stats.freshnessDays;
  const freshness = fresh === null || fresh === undefined ? 0 : fresh <= 1 ? 100 : fresh <= 3 ? 80 : fresh <= 7 ? 60 : 30;
  const confidence = Math.round(completeness * 0.6 + freshness * 0.4);

  const v = cfg.scoring?.verdicts || { main: 78, test: 62, watch: 45 };
  let verdictKey, verdict;
  const reviewBlocked = compLevel === 'high' && !p.compliance_reviewed;
  if (reviewBlocked) {
    verdictKey = 'review';
    verdict = '合规待审';
  } else if (total >= v.main) { verdictKey = 'main'; verdict = '重点主推'; }
  else if (total >= v.test) { verdictKey = 'test'; verdict = '可以测款'; }
  else if (total >= v.watch) { verdictKey = 'watch'; verdict = '谨慎观察'; }
  else { verdictKey = 'drop'; verdict = '观望/放弃'; }

  const topFactors = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 2);
  const reasons = topFactors.map((f) => `${f.label} ${f.score} 分（贡献 ${f.contribution} 分）`);
  if (penalties.length) reasons.push(`扣分：${penalties.map((x) => `${x.label} -${x.points}`).join('、')}`);

  const actions = {
    main: p.differentiation >= 65
      ? '做套装/独家款拉高客单，避开同款比价，7 天内小批量下单验证'
      : '保持单品打法，先小单测款，重点盯前 3 天转化与退货率',
    test: '小单测款（30-50 件），跑通投放/达人模型后再追加',
    watch: '加入观察名单，等趋势动量转正或成本下降再决策',
    drop: '本期不投入，保留在池中观察',
    review: '先完成合规复核（资质/认证/宣称审查），通过后再进入评分决策'
  };

  return {
    ...p,
    profit,
    profit_usd: profit.net_profit_usd,
    margin_pct: profit.margin_pct,
    roi_pct: profit.roi_pct,
    scout_score: total,
    base_score: round2(base),
    verdict,
    verdict_key: verdictKey,
    factors,
    penalties,
    trend_momentum_pct: round2(momentum),
    trend_bonus: round2(momentumBonus),
    data_freshness_days: fresh,
    confidence,
    confidence_label: confidence >= 85 ? '高' : confidence >= 65 ? '中' : '低',
    reasons,
    next_action: actions[verdictKey],
    logistics_note: p.logistics === 'heavy' ? '重货：优先海运/海外仓，头程占比显著升高' : '轻小件：空运直发可行'
  };
}

module.exports = { computeScore, trendStatsFromSeries, FACTOR_LABELS };
