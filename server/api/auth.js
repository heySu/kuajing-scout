'use strict';
/** 认证相关接口。 */
const { validate } = require('../lib/validate');
const { sendJson } = require('../lib/http');
const { config } = require('../config');
const auth = require('../services/auth');
const plans = require('../services/plans');
const audit = require('../services/audit');
const { HttpError } = require('../lib/errors');

module.exports = (route) => {
  route('POST', '/api/auth/login', {
    auth: false,
    limit: { name: 'login', limit: 10, windowMs: 5 * 60_000, scope: 'ip' }
  }, async (ctx) => {
    const body = validate(ctx.body, {
      email: { type: 'string', required: true, maxLen: 200 },
      password: { type: 'string', required: true, maxLen: 200 }
    });
    const result = await auth.login(body.email, body.password, ctx.ip, ctx.req.headers['user-agent'] || '');
    ctx.setCookie(auth.COOKIE, result.token, {
      maxAge: config.sessionTtlDays * 86400,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax'
    });
    const plan = plans.getPlan(result.user.tenantId);
    audit.log(result.user.tenantId, result.user.id, 'auth.login', result.user.email, '登录成功', ctx.ip);
    return {
      user: result.user,
      tenant: result.tenant,
      csrf: result.csrf,
      expires_at: result.expiresAt,
      plan: { key: plan.key, name: plan.name, limits: plan.limits },
      permissions: [...(auth.PERMS[result.user.role] || [])]
    };
  });

  route('POST', '/api/auth/logout', {}, (ctx) => {
    const token = require('../lib/cookies').parseCookies(ctx.req.headers.cookie)[auth.COOKIE];
    auth.destroySession(token);
    ctx.clearCookie(auth.COOKIE);
    return { ok: true };
  });

  route('GET', '/api/auth/me', {}, (ctx) => {
    const plan = plans.getPlan(ctx.tenantId);
    return {
      user: ctx.user,
      tenant: { id: ctx.tenantId, name: ctx.session.tenantName, plan: plan.key, plan_name: plan.name, status: plan.status },
      csrf: ctx.csrf,
      via: ctx.via,
      permissions: [...(auth.PERMS[ctx.role] || [])],
      plan: { key: plan.key, name: plan.name, price_cny: plan.priceCny, limits: plan.limits, trial_ends_at: plan.trialEndsAt },
      usage: plans.usageOf(ctx.tenantId),
      demo_mode: config.demoMode,
      llm_configured: Boolean(config.llm.apiKey)
    };
  });

  route('PATCH', '/api/auth/password', {}, async (ctx) => {
    const body = validate(ctx.body, {
      old_password: { type: 'string', required: true, maxLen: 200 },
      new_password: { type: 'string', required: true, maxLen: 200 }
    });
    await auth.updatePassword(ctx.user.id, body.old_password, body.new_password);
    auth.destroyUserSessions(ctx.user.id);
    audit.log(ctx.tenantId, ctx.user.id, 'auth.password', ctx.user.email, '修改密码', ctx.ip);
    ctx.clearCookie(auth.COOKIE);
    return { ok: true, relogin: true };
  });

  route('POST', '/api/auth/demo', { auth: false, limit: { name: 'demo', limit: 30, windowMs: 60 * 60_000, scope: 'ip' } }, async (ctx) => {
    if (!config.demoMode) throw new HttpError(404, 'not_found', '演示模式未开启');
    const email = process.env.DEMO_EMAIL || 'demo@scout.local';
    const password = process.env.DEMO_PASSWORD || 'demo12345';
    const result = await auth.login(email, password, ctx.ip, ctx.req.headers['user-agent'] || '');
    ctx.setCookie(auth.COOKIE, result.token, {
      maxAge: config.sessionTtlDays * 86400, httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax'
    });
    return { user: result.user, tenant: result.tenant, csrf: result.csrf, demo: true };
  });

  // 便于前端在 401 时拿到统一结构
  route('GET', '/api/auth/ping', { auth: false }, () => ({ ok: true, ts: new Date().toISOString() }));
};
