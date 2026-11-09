'use strict';
/**
 * 预警通知：企业微信 / 飞书 / Slack / Server酱 / 通用 JSON。
 * 商用注意：Webhook URL 由用户填写，必须做 SSRF 防护（协议白名单 + 内网地址拦截）。
 */
const { config } = require('../config');
const { badRequest } = require('../lib/errors');
const log = require('../lib/logger');

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./
];

function assertSafeWebhook(urlStr) {
  let url;
  try { url = new URL(String(urlStr)); } catch { throw badRequest('Webhook 地址不合法'); }
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
  const allowHttp = !config.isProd || process.env.WEBHOOK_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw badRequest('Webhook 必须使用 https（内网自建可在环境变量中显式放开）');
  }
  if (url.username || url.password) throw badRequest('Webhook 地址不能包含账号密码');
  const host = url.hostname.toLowerCase();
  const isPrivate = host === 'localhost' || host.endsWith('.local') || host === '[::1]' ||
    host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') ||
    PRIVATE_V4.some((re) => re.test(host));
  if (isPrivate && !allowPrivate) throw badRequest('禁止向内网地址发送 Webhook');
  return url;
}

function buildPayload(type, { title, markdown, day, alerts = [] }) {
  switch (type) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: markdown.slice(0, 4000) } };
    case 'feishu':
      return { msg_type: 'text', content: { text: `${title}\n\n${markdown}`.slice(0, 4000) } };
    case 'slack':
      return { text: `*${title}*\n${markdown}`.slice(0, 4000) };
    case 'serverchan':
      return { title: title.slice(0, 100), desp: markdown.slice(0, 30000) };
    case 'generic':
    default:
      return {
        event: 'scout.digest',
        day,
        title,
        markdown,
        alerts: alerts.map((a) => ({ rule: a.rule, level: a.level, product: a.product_name, message: a.message }))
      };
  }
}

async function postJson(url, body) {
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'kuajing-scout/' + config.version },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await doFetch();
      const text = await resp.text().catch(() => '');
      if (resp.ok) return { ok: true, status: resp.status };
      lastErr = new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw lastErr || new Error('webhook failed');
}

async function send(cfg, { title, markdown, day, alerts }) {
  const webhook = cfg?.alerts?.webhook;
  if (!webhook || !webhook.enabled || !webhook.url) return { skipped: true };
  const url = assertSafeWebhook(webhook.url);
  const payload = buildPayload(webhook.type, { title, markdown, day, alerts });
  try {
    const res = await postJson(url.toString(), payload);
    return { ok: true, ...res };
  } catch (e) {
    log.warn('webhook 发送失败', { error: e.message });
    return { ok: false, error: e.message };
  }
}

async function test(webhook) {
  if (!webhook || !webhook.url) throw badRequest('请先填写 Webhook 地址');
  const url = assertSafeWebhook(webhook.url);
  const payload = buildPayload(webhook.type, {
    title: '跨境选品侦察兵 · 测试消息',
    markdown: '这是一条测试消息，收到即代表 Webhook 配置正确。',
    day: new Date().toISOString().slice(0, 10)
  });
  const res = await postJson(url.toString(), payload);
  return { ok: true, status: res.status };
}

module.exports = { send, test, assertSafeWebhook, buildPayload };
