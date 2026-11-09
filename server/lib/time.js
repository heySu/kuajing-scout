'use strict';
/** 时区安全的时间工具：日报按业务时区（默认 Asia/Shanghai）切天，而不是 UTC。 */
const { config } = require('../config');

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false
});

/** 业务时区的 YYYY-MM-DD */
function today(date = new Date()) {
  const parts = dateFmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 当前业务时区小时/分钟，用于无 cron 依赖的定时任务判断 */
function timeInZone(date = new Date()) {
  const parts = partsFmt.formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get('hour') % 24, minute: get('minute') };
}

function nowIso() { return new Date().toISOString(); }

function addDays(dayStr, delta) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** 当月起始日（业务时区），用于配额统计 */
function monthStart(dayStr = today()) { return dayStr.slice(0, 8) + '01'; }

module.exports = { today, nowIso, addDays, daysBetween, timeInZone, monthStart };
