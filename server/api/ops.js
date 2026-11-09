'use strict';
/** 运维与公共元信息接口（不需要登录）。 */
const { db } = require('../db');
const { config } = require('../config');
const { PLANS } = require('../defaults');
const { today } = require('../lib/time');

const startedAt = Date.now();

module.exports = (route) => {
  route('GET', '/api/health', { auth: false }, () => {
    let dbOk = true;
    try { db.prepare('SELECT 1 AS ok').get(); } catch { dbOk = false; }
    return {
      status: dbOk ? 'ok' : 'degraded',
      version: config.version,
      env: config.env,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      db: dbOk ? 'ok' : 'error',
      timezone: config.timezone,
      time: new Date().toISOString(),
      day: today(),
      llm_configured: Boolean(config.llm.apiKey),
      demo_mode: config.demoMode
    };
  });

  route('GET', '/api/meta', { auth: false }, () => ({
    name: '跨境选品侦察兵',
    name_en: 'kuajing-scout',
    version: config.version,
    demo_mode: config.demoMode,
    llm_configured: Boolean(config.llm.apiKey),
    timezone: config.timezone,
    today: today()
  }));

  route('GET', '/api/plans', { auth: false }, () => ({ plans: Object.values(PLANS), currency: 'CNY' }));
};
