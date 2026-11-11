'use strict';
/** HTTP 应用：路由表 + 鉴权 + CSRF/同源校验 + 限流 + 静态资源 + 统一错误处理。 */
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('./config');
const { db } = require('./db');
const { sendJson, sendText, readJsonBody, applySecurityHeaders, serveStatic } = require('./lib/http');
const { HttpError } = require('./lib/errors');
const { parseCookies, serializeCookie } = require('./lib/cookies');
const { RateLimiter } = require('./lib/ratelimit');
const auth = require('./services/auth');
const log = require('./lib/logger');

const routes = [];
const limiter = new RateLimiter();

/**
 * @param {string} method
 * @param {string} pattern 支持 :param
 * @param {{auth?: boolean, perm?: string, limit?: {name: string, limit: number, windowMs: number, scope?: 'ip'|'tenant'}, bodyLimit?: number}} opts
 * @param {Function} handler
 */
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  routes.push({ method: method.toUpperCase(), pattern, opts, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split('/').filter(Boolean);
    const up = pathname.split('/').filter(Boolean);
    if (pp.length !== up.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '';
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // 同源 fetch / curl 可能不带 Origin
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'bad_origin', 'Origin 不合法'); }
  if (host !== req.headers.host) throw new HttpError(403, 'bad_origin', '跨站请求被拒绝');
}

/** 计算允许跨域的 Origin（供纯前端工具经 API Key 回传数据）；未配置则仅同源 */
function corsAllowOrigin(req) {
  if (config.corsAllowAll) return req.headers.origin || '*';
  const origin = req.headers.origin;
  if (!origin) return null;
  if (config.corsAllowOrigins.includes(origin)) return origin;
  return null;
}

function resolveAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = auth.authenticate(cookies[auth.COOKIE]);
  if (session) return session;
  const apiKey = req.headers['x-api-key'] ||
    (String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7) : '');
  if (apiKey && String(apiKey).startsWith('ks_')) return auth.authenticateApiKey(String(apiKey));
  return null;
}

function checkRate(ctx, rule) {
  if (config.rateLimitDisabled) return;
  const scope = rule.scope || 'ip';
  const key = `${rule.name}:${scope === 'tenant' ? ctx.tenantId : ctx.ip}`;
  const res = limiter.hit(key, rule.limit, rule.windowMs);
  if (!res.ok) {
    const err = new HttpError(429, 'rate_limited', '操作过于频繁，请稍后再试');
    err.retryAfter = res.retryAfter;
    throw err;
  }
}

function createServer({ publicDir = path.join(__dirname, '..', 'public') } = {}) {
  const server = http.createServer(async (req, res) => {
    const reqId = crypto.randomUUID();
    const start = Date.now();
    applySecurityHeaders(res);
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('Vary', 'Cookie, Origin');
    const allowOrigin = corsAllowOrigin(req);
    if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);

    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return sendText(res, 400, 'bad url'); }

    res.on('finish', () => {
      if (url.pathname.startsWith('/api/')) {
        log.debug('request', {
          reqId, method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - start
        });
      }
    });

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
      // 演示站：访问首页时自动以只读演示账号登录，便于公开体验（DEMO_MODE=1 时才生效）
      if (config.demoMode && url.pathname === '/' && !parseCookies(req.headers.cookie)[auth.COOKIE]) {
        const demo = db.prepare('SELECT * FROM users WHERE email = ?').get(process.env.DEMO_EMAIL || 'demo@scout.local');
        if (demo) {
          const s = auth.createSession(demo, clientIp(req), req.headers['user-agent'] || '');
          res.setHeader('Set-Cookie', serializeCookie(auth.COOKIE, s.token, {
            maxAge: config.sessionTtlDays * 86400, httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax'
          }));
        }
      }
      return serveStatic(req, res, publicDir, url.pathname);
    }

    // 跨域预检（仅当 Origin 被 CORS 白名单允许时才回应，避免非法源拿到预检通过）
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      if (res.getHeader('Access-Control-Allow-Origin')) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-csrf-token, Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        return sendText(res, 204, '');
      }
      return sendText(res, 404, 'not found');
    }

    try {
      const matched = matchRoute(req.method, url.pathname);
      if (!matched) throw new HttpError(404, 'not_found', '接口不存在');
      const { route: r, params } = matched;
      const ip = clientIp(req);

      const ctx = {
        req, res, url, params, reqId, ip,
        query: url.searchParams,
        body: {},
        tenantId: null, user: null, role: null, csrf: null, via: null,
        setCookie(name, value, opts = {}) {
          res.setHeader('Set-Cookie', serializeCookie(name, value, opts));
        },
        clearCookie(name) {
          res.setHeader('Set-Cookie', serializeCookie(name, '', { maxAge: 0 }));
        },
        download(filename, content, contentType) {
          const { sendDownload } = require('./lib/http');
          sendDownload(res, filename, content, contentType);
        }
      };

      // 全局限流（健康检查豁免，便于探针）
      if (url.pathname !== '/api/health' && !config.rateLimitDisabled) {
        const g = limiter.hit('global:' + ip, 600, 60_000);
        if (!g.ok) {
          res.setHeader('Retry-After', String(g.retryAfter));
          throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试');
        }
      }

      if (r.opts.auth !== false) {
        const session = resolveAuth(req);
        if (!session) throw new HttpError(401, 'unauthorized', '请先登录');
        ctx.tenantId = session.tenantId;
        ctx.user = session.user;
        ctx.role = session.user.role;
        ctx.csrf = session.csrf;
        ctx.via = session.via;
        ctx.session = session;

        if (session.via === 'api_key') {
          const scopes = session.scopes || ['read'];
          if (req.method !== 'GET' && !scopes.includes('write')) {
            throw new HttpError(403, 'readonly_key', '该 API Key 只有只读权限');
          }
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          // API Key 为 Bearer 凭证，无需同域 / CSRF 校验（与浏览器会话隔离）
          if (session.via !== 'api_key') {
            assertSameOrigin(req);
            if (session.via === 'session') {
              const token = req.headers['x-csrf-token'];
              if (!token || token !== session.csrf) throw new HttpError(403, 'csrf_failed', 'CSRF 校验失败，请刷新页面重试');
            }
            if (config.demoMode && ctx.via === 'session' && session.user.email === 'demo@scout.local') {
              throw new HttpError(403, 'demo_readonly', '演示账号为只读，部署后使用管理员账号');
            }
          }
        }

        if (r.opts.perm && !auth.can(ctx.role, r.opts.perm)) {
          throw new HttpError(403, 'forbidden', '当前角色没有该操作权限');
        }
        if (r.opts.limit) checkRate(ctx, { ...r.opts.limit, scope: r.opts.limit.scope || 'tenant' });
      } else if (r.opts.limit) {
        ctx.ip = ip;
        checkRate(ctx, { ...r.opts.limit, scope: 'ip' });
      }

      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        ctx.body = await readJsonBody(req, r.opts.bodyLimit || config.maxBodyBytes);
      }

      const result = await r.handler(ctx);
      if (res.writableEnded) return;
      if (result === undefined) return sendJson(res, 200, { ok: true });
      return sendJson(res, result.__status || 200, result);
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof HttpError) {
        if (e.status >= 500) log.error('api error', { reqId, code: e.code, message: e.message });
        if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
        return sendJson(res, e.status, { ...e.toJSON(), request_id: reqId });
      }
      log.error('unhandled error', { reqId, message: e.message, stack: e.stack });
      return sendJson(res, 500, {
        error: 'internal_error',
        message: config.isProd ? '服务器内部错误，请联系管理员' : e.message,
        request_id: reqId
      });
    }
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

module.exports = { createServer, route, limiter, clientIp, matchRoute };
