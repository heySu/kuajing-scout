'use strict';
/**
 * 集中配置：.env 加载 + 校验 + 默认值。
 * 原则：生产环境缺关键配置直接启动失败（fail fast），开发环境给出可用默认值并告警。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

/** 极简 .env 解析（不覆盖已存在的环境变量，不做变量展开） */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function int(v, dflt) { return Math.trunc(num(v, dflt)); }

const warnings = [];
const errors = [];

// ---- 基础 ----
const PORT = int(process.env.PORT, 3600);
const HOST = process.env.HOST || '127.0.0.1';
const TIMEZONE = process.env.TZ_NAME || process.env.TZ || 'Asia/Shanghai';
if (!/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(TIMEZONE) && TIMEZONE !== 'UTC') {
  errors.push(`TZ_NAME 不是合法 IANA 时区：${TIMEZONE}`);
}

const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/scout.db');

// ---- 会话 / 安全 ----
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  if (isProd) errors.push('生产环境必须设置 SESSION_SECRET（>=32 字符随机串）');
  else {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    warnings.push('未设置 SESSION_SECRET，已生成临时密钥（重启后登录态失效）');
  }
} else if (SESSION_SECRET.length < 32 && isProd) {
  errors.push('SESSION_SECRET 长度不足 32 字符');
}

const SESSION_TTL_DAYS = int(process.env.SESSION_TTL_DAYS, 7);
const COOKIE_SECURE = bool(process.env.COOKIE_SECURE, isProd);
const TRUST_PROXY = bool(process.env.TRUST_PROXY, false);
const DEMO_MODE = bool(process.env.DEMO_MODE, false);
const MAX_BODY_BYTES = int(process.env.MAX_BODY_BYTES, 256 * 1024);
const RATE_LIMIT_DISABLED = bool(process.env.RATE_LIMIT_DISABLED, false);
const LOG_LEVEL = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

// ---- 初始化管理员 ----
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
if (BOOTSTRAP_ADMIN_EMAIL && BOOTSTRAP_ADMIN_PASSWORD && BOOTSTRAP_ADMIN_PASSWORD.length < 10) {
  errors.push('BOOTSTRAP_ADMIN_PASSWORD 至少 10 位');
}
if (isProd && !BOOTSTRAP_ADMIN_EMAIL) {
  warnings.push('未设置 BOOTSTRAP_ADMIN_EMAIL：首次启动不会创建账号，需使用 `npm run create-user`');
}

// ---- LLM ----
const LLM = {
  apiKey: process.env.LLM_API_KEY || '',
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  timeoutMs: int(process.env.LLM_TIMEOUT_MS, 45000),
  maxRetries: int(process.env.LLM_MAX_RETRIES, 2),
  temperature: num(process.env.LLM_TEMPERATURE, 0.4),
  maxTokens: int(process.env.LLM_MAX_TOKENS, 1200)
};
if (LLM.apiKey && !/^https?:\/\//.test(LLM.baseUrl)) errors.push('LLM_BASE_URL 必须是 http(s) 地址');

// ---- 任务调度 ----
const REPORT_CRON_HOUR = int(process.env.REPORT_CRON_HOUR, 8);
const REPORT_CRON_MINUTE = int(process.env.REPORT_CRON_MINUTE, 0);
if (REPORT_CRON_HOUR < 0 || REPORT_CRON_HOUR > 23) errors.push('REPORT_CRON_HOUR 必须在 0-23');
const SNAPSHOT_INTERVAL_HOURS = num(process.env.SNAPSHOT_INTERVAL_HOURS, 6);
const ENABLE_CRON = bool(process.env.ENABLE_CRON, true);
const WRITE_REPORT_FILES = bool(process.env.REPORT_WRITE_FILES, true);

// ---- 数据源 ----
const DATA_PROVIDER = process.env.DATA_PROVIDER || 'manual';

const config = {
  env: NODE_ENV,
  isProd,
  root: ROOT,
  port: PORT,
  host: HOST,
  timezone: TIMEZONE,
  dbPath: DB_PATH,
  sessionSecret: SESSION_SECRET,
  sessionTtlDays: SESSION_TTL_DAYS,
  cookieSecure: COOKIE_SECURE,
  trustProxy: TRUST_PROXY,
  demoMode: DEMO_MODE,
  maxBodyBytes: MAX_BODY_BYTES,
  rateLimitDisabled: RATE_LIMIT_DISABLED,
  logLevel: LOG_LEVEL,
  bootstrapAdminEmail: BOOTSTRAP_ADMIN_EMAIL,
  bootstrapAdminPassword: BOOTSTRAP_ADMIN_PASSWORD,
  llm: LLM,
  reportCron: { hour: REPORT_CRON_HOUR, minute: REPORT_CRON_MINUTE },
  snapshotIntervalHours: SNAPSHOT_INTERVAL_HOURS,
  enableCron: ENABLE_CRON,
  writeReportFiles: WRITE_REPORT_FILES,
  dataProvider: DATA_PROVIDER,
  version: require('../package.json').version
};

module.exports = { config, warnings, errors, loadDotEnv };
