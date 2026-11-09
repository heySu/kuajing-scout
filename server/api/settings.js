'use strict';
/** 设置 / 团队 / API Key / 数据源 / 审计 / 用量。 */
const { config } = require('../config');
const settings = require('../services/settings');
const plans = require('../services/plans');
const usage = require('../services/usage');
const audit = require('../services/audit');
const providers = require('../services/providers');
const notify = require('../services/notify');
const auth = require('../services/auth');
const { PLANS } = require('../defaults');
const { validate } = require('../lib/validate');
const { badRequest } = require('../lib/errors');

module.exports = (route) => {
  route('GET', '/api/settings', { perm: 'read' }, (ctx) => {
    const plan = plans.getPlan(ctx.tenantId);
    const cfg = settings.getConfig(ctx.tenantId);
    // Webhook URL 内含机器人密钥，非管理员只返回脱敏占位
    if (!auth.can(ctx.role, 'manage_settings') && cfg.alerts?.webhook) {
      cfg.alerts.webhook = {
        ...cfg.alerts.webhook,
        url: cfg.alerts.webhook.url ? '••••••（仅管理员可见）' : ''
      };
    }
    return {
      config: cfg,
      plan: { key: plan.key, name: plan.name, price_cny: plan.priceCny, limits: plan.limits, status: plan.status },
      usage: plans.usageOf(ctx.tenantId),
      usage_summary: usage.summary(ctx.tenantId),
      plans: Object.values(PLANS),
      role: ctx.role,
      integrations: providers.status(ctx.tenantId),
      alerts_summary: require('../services/alerts').summary(ctx.tenantId)
    };
  });

  route('PATCH', '/api/settings/config', { perm: 'manage_settings' }, (ctx) => {
    const next = settings.updateConfig(ctx.tenantId, ctx.body);
    audit.log(ctx.tenantId, ctx.user.id, 'settings.update', 'config', Object.keys(ctx.body).join(','), ctx.ip);
    return { config: next };
  });

  route('POST', '/api/settings/config/reset', { perm: 'manage_settings' }, (ctx) => {
    const cfg = settings.resetConfig(ctx.tenantId);
    audit.log(ctx.tenantId, ctx.user.id, 'settings.reset', 'config', '', ctx.ip);
    return { config: cfg };
  });

  route('POST', '/api/settings/webhook/test', { perm: 'manage_settings', limit: { name: 'webhook_test', limit: 10, windowMs: 3600_000 } }, async (ctx) => {
    const body = validate(ctx.body, {
      url: { type: 'string', maxLen: 500 },
      type: { type: 'enum', enum: ['wecom', 'feishu', 'slack', 'serverchan', 'generic'] }
    }, { partial: true, allowUnknown: true });
    const cfg = settings.getConfig(ctx.tenantId);
    const webhook = body.url ? { ...cfg.alerts.webhook, ...body, enabled: true } : cfg.alerts.webhook;
    const result = await notify.test(webhook);
    return { ...result, channel: webhook?.type || 'generic' };
  });

  route('GET', '/api/usage', { perm: 'read' }, (ctx) => ({
    usage: plans.usageOf(ctx.tenantId),
    summary: usage.summary(ctx.tenantId),
    plan: plans.getPlan(ctx.tenantId)
  }));

  route('GET', '/api/audit', { perm: 'manage_settings' }, (ctx) => ({
    logs: audit.list(ctx.tenantId, Math.min(200, Number(ctx.query.get('limit')) || 50))
  }));

  route('GET', '/api/users', { perm: 'manage_users' }, (ctx) => ({
    users: auth.listUsers(ctx.tenantId),
    seats: plans.usageOf(ctx.tenantId).seats,
    limit: plans.limitsOf(ctx.tenantId).seats
  }));

  route('POST', '/api/users', { perm: 'manage_users' }, async (ctx) => {
    const body = validate(ctx.body, {
      email: { type: 'string', required: true, maxLen: 200 },
      password: { type: 'string', required: true, maxLen: 200 },
      name: { type: 'string', maxLen: 40, default: '' },
      role: { type: 'enum', enum: ['admin', 'analyst', 'viewer'], default: 'viewer' }
    });
    const user = await auth.createUser(ctx.tenantId, body);
    audit.log(ctx.tenantId, ctx.user.id, 'user.create', user.email, body.role, ctx.ip);
    return { user };
  });

  route('PATCH', '/api/users/:id', { perm: 'manage_users' }, (ctx) => {
    const body = validate(ctx.body, {
      role: { type: 'enum', enum: ['admin', 'analyst', 'viewer'] },
      status: { type: 'enum', enum: ['active', 'disabled'] },
      name: { type: 'string', maxLen: 40 }
    }, { partial: true });
    const user = auth.updateUser(ctx.tenantId, Number(ctx.params.id), body, ctx.user.id);
    audit.log(ctx.tenantId, ctx.user.id, 'user.update', String(ctx.params.id), Object.keys(body).join(','), ctx.ip);
    return { user };
  });

  route('GET', '/api/keys', { perm: 'manage_keys' }, (ctx) => ({
    keys: auth.listApiKeys(ctx.tenantId),
    limit: plans.limitsOf(ctx.tenantId).apiKeys
  }));

  route('POST', '/api/keys', { perm: 'manage_keys', limit: { name: 'keys', limit: 20, windowMs: 3600_000 } }, (ctx) => {
    const body = validate(ctx.body, {
      name: { type: 'string', required: true, maxLen: 60 },
      scopes: { type: 'enum', enum: ['read', 'write'], default: 'read' }
    });
    const key = auth.createApiKey(ctx.tenantId, ctx.user.id, body.name, body.scopes);
    audit.log(ctx.tenantId, ctx.user.id, 'key.create', key.prefix, body.scopes, ctx.ip);
    return { key };
  });

  route('DELETE', '/api/keys/:id', { perm: 'manage_keys' }, (ctx) => {
    const res = auth.revokeApiKey(ctx.tenantId, Number(ctx.params.id));
    audit.log(ctx.tenantId, ctx.user.id, 'key.revoke', ctx.params.id, '', ctx.ip);
    return res;
  });

  route('GET', '/api/integrations', { perm: 'read' }, (ctx) => providers.status(ctx.tenantId));

  route('POST', '/api/integrations/google-trends/sync', {
    perm: 'manage_settings',
    limit: { name: 'provider_sync', limit: 6, windowMs: 3600_000 }
  }, async (ctx) => {
    const body = validate(ctx.body, {
      geo: { type: 'enum', enum: ['US', 'GB', 'DE', 'FR', 'JP', 'KR'], default: 'US' },
      apply: { type: 'bool', default: false }
    });
    return providers.syncGoogleTrends(ctx.tenantId, body);
  });

  route('POST', '/api/signals', {
    perm: 'write_product',
    limit: { name: 'signals', limit: 120, windowMs: 3600_000 }
  }, (ctx) => {
    if (!Array.isArray(ctx.body.items)) throw badRequest('请求体需为 { items: [...] }');
    return providers.ingestSignals(ctx.tenantId, ctx.body.items);
  });

  route('POST', '/api/plan', { perm: 'manage_billing' }, (ctx) => {
    const body = validate(ctx.body, { plan: { type: 'enum', enum: Object.keys(PLANS) } });
    const plan = plans.setPlan(ctx.tenantId, body.plan);
    audit.log(ctx.tenantId, ctx.user.id, 'plan.change', body.plan, '', ctx.ip);
    return { plan };
  });
};
