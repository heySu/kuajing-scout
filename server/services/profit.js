'use strict';
/**
 * 利润引擎 v2：售价 → 成本瀑布 → 净利/毛利/ROI/保本价/可承受成本上限。
 * 与 v0.1 的区别：不再用「头程占售价比」拍脑袋，而是按重量×运价，并显式计入关税、退货、投流、支付、
 * 包装质检与汇率缓冲；毛利率按售价计（而不是按净收入），避免虚高。
 *
 * v1.1 口径修正：低值免税已取消，新增「每件固定关税 / 每票固定报关费」与
 * 「半托管·海外仓本地履约」四项成本；固定税费不随货值变化，保本价与可承受成本反解同步纳入。
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * @param {object} p 商品（含 cost_cny / sale_usd / weight_g / scene / logistics / duty_rate / target_margin）
 * @param {object} cfg 租户配置（services/settings.getConfig）
 */
function computeProfit(p, cfg) {
  const sale = Number(p.sale_usd) || 0;
  const costCny = Number(p.cost_cny) || 0;
  const fx = Number(cfg.fx?.usdCny) || 7.2;
  const buffer = Number(cfg.fx?.buffer) || 0;
  const weightKg = Math.max(0, Number(p.weight_g) || 0) / 1000;
  const scene = p.scene === 'tiktok' ? 'tiktok' : 'temu';
  const fee = cfg.fees?.[scene] || {};
  const logi = cfg.logistics || {};
  const dutyCfg = cfg.duty || {};
  const nonNeg = (v) => Math.max(0, Number(v) || 0);

  // 2026 起主要市场取消低值免税：每票固定税费与货值无关，必须单列
  const perItemDuty = nonNeg(dutyCfg.perItemDutyUsd);
  const customsFee = nonNeg(dutyCfg.customsPerOrderUsd);
  const fixedTaxes = perItemDuty + customsFee;

  // direct = 直发/全托管供货；local = 半托管/海外仓本地发货（成本项由 2 项变 5 项）
  const localMode = logi.fulfillmentModel === 'local';
  const loc = logi.local || {};
  const inbound = localMode ? nonNeg(loc.inboundUsdPerUnit) : 0;
  const storage = localMode ? nonNeg(loc.storageUsdPerUnit) : 0;
  const lastMile = localMode ? nonNeg(loc.lastMileUsdPerUnit) : 0;
  const deadStockPct = localMode ? nonNeg(loc.deadStockPct) : 0;
  const localFixed = inbound + storage + lastMile;

  const perKg = logi.mode === 'sea' ? Number(logi.seaUsdPerKg) : Number(logi.airUsdPerKg);
  const freight = weightKg * (Number(perKg) || 0);
  const landedUsd = (costCny * (1 + buffer)) / (fx || 7.2);
  const dutyRate = p.duty_rate === null || p.duty_rate === undefined ? Number(dutyCfg.defaultRate) || 0 : Number(p.duty_rate);
  const duty = (landedUsd + freight) * dutyRate + perItemDuty;
  const packaging = Number(logi.packagingUsd) || 0;
  const qc = Number(logi.qcUsd) || 0;
  const commission = sale * (Number(fee.commission) || 0);
  const fulfillment = Number(fee.fulfillment) || 0;
  const ad = sale * (Number(fee.ad) || 0);
  const returns = sale * (Number(fee.returns) || 0);
  const payment = sale * (Number(fee.payment) || 0);
  const deadStock = sale * deadStockPct;

  const goodsCost = landedUsd + freight + duty + packaging + qc + customsFee;
  const platformCost = commission + fulfillment + payment;
  const marketCost = ad + returns;
  const localCost = localFixed + deadStock;
  const totalCost = goodsCost + platformCost + marketCost + localCost;
  const netUsd = sale - totalCost;
  const netCny = netUsd * fx;
  const margin = sale > 0 ? netUsd / sale : 0;
  const roi = goodsCost > 0 ? netUsd / goodsCost : 0;

  const variableRate = (Number(fee.commission) || 0) + (Number(fee.ad) || 0) +
    (Number(fee.returns) || 0) + (Number(fee.payment) || 0) + deadStockPct;
  const fixedCost = goodsCost + fulfillment + localFixed;
  const breakEvenUsd = variableRate < 1 ? fixedCost / (1 - variableRate) : Infinity;

  const targetMargin = p.target_margin === null || p.target_margin === undefined
    ? Number(cfg.scoring?.profitTargetMargin) || 0.45
    : Number(p.target_margin);
  // 在目标毛利率下反解可承受的到岸成本：关税随到岸成本线性变化，固定税费不随之变化
  const otherFixed = freight * (1 + dutyRate) + perItemDuty + customsFee +
    packaging + qc + fulfillment + localFixed;
  const maxLandedUsd = (sale * (1 - variableRate - targetMargin) - otherFixed) / (1 + dutyRate);
  const maxCostCny = Math.max(0, maxLandedUsd * (fx || 7.2)) / (1 + buffer);
  const headroomPct = costCny > 0 ? (maxCostCny - costCny) / costCny : null;

  const warnings = [];
  if (sale <= 0) warnings.push('售价未填写');
  if (costCny <= 0) warnings.push('拿货成本未填写');
  if (netUsd <= 0) warnings.push('当前为亏损定价');
  else if (margin < 0.15) warnings.push('毛利率低于 15%，抗风险能力弱');
  const deMinimis = nonNeg(dutyCfg.deMinimisUsd);
  if (sale > 0 && deMinimis > 0 && sale < deMinimis) {
    warnings.push(`售价低于免税额度 $${deMinimis}，请确认该市场当期政策是否仍适用`);
  }
  if (deMinimis === 0 && fixedTaxes === 0) {
    warnings.push('主流市场低值免税已取消；当前未设置每票固定清关税费，低客单价净利可能被高估');
  }
  if (sale > 0 && fixedTaxes > 0 && fixedTaxes / sale >= 0.1) {
    warnings.push(`每票固定税费占售价 ${((fixedTaxes / sale) * 100).toFixed(0)}%，低客单价商品利润被固定成本压平`);
  }
  if (localMode && localFixed === 0 && deadStockPct === 0) {
    warnings.push('已选本地仓履约但未填写仓储/尾程成本，模型会低估履约支出');
  }
  if (p.duty_rate === null || p.duty_rate === undefined) warnings.push(`关税按默认 ${(dutyRate * 100).toFixed(0)}% 估算，建议按 HS 编码核实`);
  if (!p.weight_g) warnings.push('缺少重量，头程为估算值');

  const breakdown = [
    { key: 'goods', label: '拿货成本', usd: landedUsd },
    { key: 'freight', label: '头程物流', usd: freight, note: `${weightKg.toFixed(2)}kg × $${Number(perKg).toFixed(1)}/kg` },
    { key: 'duty', label: '关税/进口税', usd: duty, note: `${(dutyRate * 100).toFixed(1)}%${perItemDuty ? ` + $${perItemDuty.toFixed(2)}/件固定` : ''}` },
    { key: 'customs', label: '固定报关/清关', usd: customsFee, note: '每票固定，与货值无关' },
    { key: 'packaging', label: '包装/质检', usd: packaging + qc },
    { key: 'commission', label: '平台佣金', usd: commission, note: `${((Number(fee.commission) || 0) * 100).toFixed(1)}%` },
    { key: 'fulfillment', label: '仓配履约', usd: fulfillment },
    { key: 'ad', label: '投流/推广', usd: ad, note: `${((Number(fee.ad) || 0) * 100).toFixed(1)}%` },
    { key: 'returns', label: '退货售后', usd: returns, note: `${((Number(fee.returns) || 0) * 100).toFixed(1)}%` },
    { key: 'payment', label: '支付/提现', usd: payment },
    ...(localMode ? [
      { key: 'inbound', label: '批量清关/入库分摊', usd: inbound },
      { key: 'storage', label: '海外仓仓储分摊', usd: storage },
      { key: 'lastMile', label: '本地尾程派送', usd: lastMile },
      { key: 'deadStock', label: '滞销/退货损耗', usd: deadStock, note: `${(deadStockPct * 100).toFixed(1)}%` }
    ] : [])
  ].map((b) => ({ ...b, usd: round2(b.usd), pct: sale > 0 ? round2((b.usd / sale) * 100) : 0 }));

  return {
    scene,
    duty_rate: dutyRate,
    target_margin: targetMargin,
    weight_kg: round2(weightKg),
    sale_usd: round2(sale),
    total_cost_usd: round2(totalCost),
    net_profit_usd: round2(netUsd),
    net_profit_cny: round2(netCny),
    margin_pct: round2(margin * 100),
    roi_pct: round2(roi * 100),
    break_even_usd: Number.isFinite(breakEvenUsd) ? round2(breakEvenUsd) : null,
    max_cost_cny: round2(maxCostCny),
    headroom_pct: headroomPct === null ? null : round2(headroomPct * 100),
    variable_rate_pct: round2(variableRate * 100),
    fulfillment_model: localMode ? 'local' : 'direct',
    fixed_taxes_usd: round2(fixedTaxes),
    local_cost_usd: round2(localCost),
    breakdown,
    warnings
  };
}

/** 旧接口兼容：返回 v0.1 风格的 profit_usd / margin_pct */
function legacyProfit(p, cfg) {
  const m = computeProfit(p, cfg);
  return { profit_usd: m.net_profit_usd, margin_pct: m.margin_pct };
}

module.exports = { computeProfit, legacyProfit, round2, clamp };
