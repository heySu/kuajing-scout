'use strict';
/** 租户默认配置（评分权重、费用结构、告警阈值）与套餐目录。 */

const DEFAULT_CONFIG = {
  weights: { trend: 0.4, profit: 0.25, differentiation: 0.2, repurchase: 0.15 },
  fees: {
    // commission: 平台抽成/供货折价；ad: 投流占售价；returns: 退货与售后损耗；payment: 支付/提现费
    // Temu 全托管卖家只拿供货价，不投流、不承担售后，故默认 0；切换半托管需自行回填投流/退货费率。
    temu: { commission: 0.18, fulfillment: 0.0, ad: 0, returns: 0, payment: 0.0 },
    tiktok: { commission: 0.24, fulfillment: 0.0, ad: 0.22, returns: 0.05, payment: 0.02 }
  },
  logistics: {
    mode: 'air', // air / sea
    airUsdPerKg: 6.5,
    seaUsdPerKg: 1.2,
    packagingUsd: 0.25,
    qcUsd: 0.1,
    // direct: 直发 / 全托管供货；local: 半托管 / 海外仓本地发货（卖家成本项由 2 项变 5 项）
    fulfillmentModel: 'direct',
    local: {
      inboundUsdPerUnit: 0,  // 批量清关 + 头程入库，分摊到单件
      storageUsdPerUnit: 0,  // 海外仓仓储 / 库龄附加费，分摊到单件
      lastMileUsdPerUnit: 0, // 本地尾程派送
      deadStockPct: 0        // 滞销 / 退货损耗占售价
    }
  },
  fx: { usdCny: 7.2, buffer: 0.02 },
  duty: {
    // 2025/8 美国取消 800 美元低值免税、2026/2 全面收紧；2026/7 欧盟取消 150 欧免税，
    // 改按商品项征收 €3 固定关税。主流市场已无低值免税额度，默认 0。
    // 每票固定成本与货值无关，必须单列，否则低客单价商品的净利会被系统性高估。
    defaultRate: 0.25,
    deMinimisUsd: 0,
    perItemDutyUsd: 0,     // 每件固定关税（如欧盟 €3/商品项，按汇率折算成美元填写）
    customsPerOrderUsd: 0  // 每票固定报关 / 清关 / 处理费
  },
  scoring: {
    profitTargetMargin: 0.35,
    competitionThreshold: 60,
    competitionPenalty: 0.25,
    compliancePenalty: { low: 0, mid: 3, high: 8 },
    verdicts: { main: 78, test: 62, watch: 45 }
  },
  alerts: {
    scoreThreshold: 78,
    trendDropPct: 15,
    competitionHigh: 80,
    complianceHigh: true,
    webhook: null // { type: 'wecom'|'feishu'|'slack'|'serverchan'|'generic', url, enabled, minLevel }
  },
  report: { topN: 3 }
};

const PLANS = {
  free: {
    key: 'free',
    name: '免费版',
    priceCny: 0,
    limits: {
      products: 50, seats: 1, llmReportsPerMonth: 3, exportsPerMonth: 10,
      webhooks: 1, apiKeys: 0, reportHistoryDays: 7
    }
  },
  pro: {
    key: 'pro',
    name: '专业版',
    priceCny: 199,
    limits: {
      products: 500, seats: 5, llmReportsPerMonth: 60, exportsPerMonth: 100,
      webhooks: 5, apiKeys: 5, reportHistoryDays: 90
    }
  },
  team: {
    key: 'team',
    name: '团队版',
    priceCny: 699,
    limits: {
      products: 5000, seats: 20, llmReportsPerMonth: 300, exportsPerMonth: 1000,
      webhooks: 20, apiKeys: 20, reportHistoryDays: 365
    }
  },
  enterprise: {
    key: 'enterprise',
    name: '企业版',
    priceCny: null,
    limits: {
      products: 100000, seats: 500, llmReportsPerMonth: 5000, exportsPerMonth: 100000,
      webhooks: 100, apiKeys: 100, reportHistoryDays: 3650
    }
  }
};

const ROLES = ['owner', 'admin', 'analyst', 'viewer'];

/**
 * 读配置时迁移 v1.0 落库的旧默认值：deMinimisUsd = 800 已随 2026 政策失效。
 * 仅当租户从未设置过 v1.1 的固定税费字段时才剔除，避免覆盖用户显式配置。
 */
function migrateLegacyConfig(stored) {
  const s = JSON.parse(JSON.stringify(stored || {}));
  const d = s.duty;
  if (d && d.deMinimisUsd === 800 && d.perItemDutyUsd === undefined && d.customsPerOrderUsd === undefined) {
    delete d.deMinimisUsd;
  }
  return s;
}

module.exports = { DEFAULT_CONFIG, PLANS, ROLES, migrateLegacyConfig };
