'use strict';
/**
 * 认证与授权：
 *  - 密码 scrypt 散列，登录错误统一文案，防用户枚举；
 *  - 服务端会话（可撤销）+ HttpOnly Cookie + CSRF Token；
 *  - 支持 API Key（X-API-Key / Bearer），供脚本与集成使用；
 *  - 角色：owner > admin > analyst > viewer，权限矩阵集中定义。
 */
const { db } = require('../db');
const { config } = require('../config');
const { hashPassword, verifyPassword, randomToken, sha256, newApiKey } = require('../lib/crypto');
const { unauthorized, forbidden, badRequest, conflict, notFound } = require('../lib/errors');
const { nowIso } = require('../lib/time');
const { ROLES } = require('../defaults');
const { assertQuota } = require('./plans');

const COOKIE = 'ks_sid';
const PERMS = {
  viewer: new Set(['read']),
  analyst: new Set(['read', 'write_product', 'generate_report', 'export']),
  admin: new Set(['read', 'write_product', 'generate_report', 'export', 'manage_settings', 'manage_users', 'manage_alerts']),
  owner: new Set(['read', 'write_product', 'generate_report', 'export', 'manage_settings', 'manage_users', 'manage_alerts', 'manage_billing', 'manage_keys'])
};

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123',
  'admin123', 'demo1234', 'demo12345', '11111111', 'abc12345'
]);

function assertPassword(password) {
  const pw = String(password || '');
  if (pw.length < 10) throw badRequest('密码至少 10 位');
  if (pw.length > 128) throw badRequest('密码过长');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw badRequest('密码需同时包含字母与数字');
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) throw badRequest('密码过于常见，请更换');
}

function can(role, action) { return (PERMS[role] || new Set()).has(action); }

/* ---------------- 会话 ---------------- */

function createSession(user, ip = '', ua = '') {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlDays * 86400000);
  db.prepare(`INSERT INTO sessions (token_hash, user_id, tenant_id, csrf, ip, user_agent, created_at, last_seen_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sha256(token), user.id, user.tenant_id, csrf, String(ip).slice(0, 60), String(ua).slice(0, 300),
      now.toISOString(), now.toISOString(), expires.toISOString());
  return { token, csrf, expiresAt: expires.toISOString() };
}

/** 校验会话；滑动续期（剩余不足一半时延长） */
function authenticate(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT s.*, u.email, u.name, u.role, u.status AS user_status, t.name AS tenant_name, t.plan, t.status AS tenant_status
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = s.tenant_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  if (row.user_status !== 'active' || row.tenant_status !== 'active') return null;
  const ttlMs = config.sessionTtlDays * 86400000;
  if (new Date(row.expires_at).getTime() - now < ttlMs / 2) {
    const next = new Date(now + ttlMs).toISOString();
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?').run(next, new Date(now).toISOString(), row.token_hash);
    row.expires_at = next;
  } else if (now - new Date(row.last_seen_at).getTime() > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), row.token_hash);
  }
  return {
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role, tenantId: row.tenant_id },
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    csrf: row.csrf,
    expiresAt: row.expires_at,
    via: 'session'
  };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(userId, exceptTokenHash = '') {
  if (exceptTokenHash) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptTokenHash);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function cleanupSessions() {
  const info = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return info.changes;
}

/* ---------------- 登录 ---------------- */

let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-123');
  return dummyHashPromise;
}

async function login(email, password, ip = '', ua = '') {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !password) throw unauthorized('邮箱或密码不正确');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
  if (!user) {
    // 与存在用户时耗时接近，降低账号枚举风险
    await verifyPassword(String(password), await dummyHash());
    throw unauthorized('邮箱或密码不正确');
  }
  const ok = await verifyPassword(String(password), user.password_hash);
  if (!ok) throw unauthorized('邮箱或密码不正确');
  if (user.status !== 'active') throw forbidden('账号已被禁用，请联系管理员');
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(user.tenant_id);
  if (!tenant || tenant.status !== 'active') throw forbidden('企业空间已停用');

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  const session = createSession(user, ip, ua);
  return {
    ...session,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenant_id },
    tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan }
  };
}

/* ---------------- API Key ---------------- */

function authenticateApiKey(plain) {
  if (!plain) return null;
  const row = db.prepare(`SELECT k.*, u.email, u.name, u.role, u.status AS user_status, t.name AS tenant_name, t.status AS tenant_status
    FROM api_keys k JOIN users u ON u.id = k.user_id JOIN tenants t ON t.id = k.tenant_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(sha256(plain));
  if (!row || row.user_status !== 'active' || row.tenant_status !== 'active') return null;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60000) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  }
  return {
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role, tenantId: row.tenant_id },
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    csrf: null,
    via: 'api_key',
    scopes: String(row.scopes || 'read').split(',').map((s) => s.trim()).filter(Boolean),
    apiKeyId: row.id
  };
}

function createApiKey(tenantId, userId, name, scopes = 'read') {
  assertQuota(tenantId, 'apiKeys');
  if (!['read', 'write'].includes(scopes)) throw badRequest('scopes 必须是 read 或 write');
  const { plain, prefix, hash } = newApiKey();
  const info = db.prepare(`INSERT INTO api_keys (tenant_id, user_id, name, prefix, key_hash, scopes, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(tenantId, userId, String(name).slice(0, 60) || 'API Key', prefix, hash, scopes, nowIso());
  return { id: Number(info.lastInsertRowid), plain, prefix, scopes, name };
}

function listApiKeys(tenantId) {
  return db.prepare(`SELECT id, name, prefix, scopes, last_used_at, created_at, revoked_at FROM api_keys
    WHERE tenant_id = ? ORDER BY id DESC`).all(tenantId);
}

function revokeApiKey(tenantId, id) {
  const info = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL')
    .run(nowIso(), id, tenantId);
  if (!info.changes) throw notFound('API Key 不存在或已撤销');
  return { ok: true };
}

/* ---------------- 用户管理 ---------------- */

function listUsers(tenantId) {
  return db.prepare(`SELECT id, email, name, role, status, last_login_at, created_at FROM users
    WHERE tenant_id = ? ORDER BY id ASC`).all(tenantId);
}

async function createUser(tenantId, { email, password, name = '', role = 'viewer' }) {
  assertQuota(tenantId, 'seats');
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw badRequest('邮箱格式不正确');
  if (!ROLES.includes(role)) throw badRequest('角色不合法');
  if (role === 'owner') throw badRequest('不能创建第二个所有者');
  assertPassword(password);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(mail)) throw conflict('该邮箱已注册');
  const hash = await hashPassword(password);
  const info = db.prepare(`INSERT INTO users (tenant_id, email, password_hash, name, role, status, created_at)
    VALUES (?,?,?,?,?,'active',?)`).run(tenantId, mail, hash, String(name).slice(0, 40), role, nowIso());
  return db.prepare('SELECT id, email, name, role, status, created_at FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
}

function updateUser(tenantId, id, patch, actorId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!user) throw notFound('成员不存在');
  if (user.role === 'owner' && actorId !== user.id) throw forbidden('不能修改其他所有者');
  const sets = []; const vals = [];
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw badRequest('角色不合法');
    if (patch.role === 'owner') throw badRequest('不能转让所有者');
    sets.push('role = ?'); vals.push(patch.role);
  }
  if (patch.status !== undefined) {
    if (!['active', 'disabled'].includes(patch.status)) throw badRequest('状态不合法');
    if (user.role === 'owner') throw badRequest('不能禁用所有者');
    sets.push('status = ?'); vals.push(patch.status);
  }
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(String(patch.name).slice(0, 40)); }
  if (!sets.length) throw badRequest('没有可更新的字段');
  vals.push(id, tenantId);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
  if (patch.status === 'disabled') destroyUserSessions(id);
  return db.prepare('SELECT id, email, name, role, status, last_login_at FROM users WHERE id = ?').get(id);
}

async function updatePassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw notFound('用户不存在');
  const ok = await verifyPassword(String(oldPassword || ''), user.password_hash);
  if (!ok) throw badRequest('原密码不正确');
  assertPassword(newPassword);
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  return { ok: true };
}

/* ---------------- 初始化 ---------------- */

async function ensureBootstrap() {
  let tenant = db.prepare('SELECT * FROM tenants ORDER BY id ASC LIMIT 1').get();
  let created = false;
  if (!tenant) {
    const ts = nowIso();
    const info = db.prepare('INSERT INTO tenants (name, slug, plan, status, trial_ends_at, created_at) VALUES (?,?,?,?,?,?)')
      .run('默认空间', 'default', 'pro', 'active', new Date(Date.now() + 14 * 86400000).toISOString(), ts);
    tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(info.lastInsertRowid));
    created = true;
  }

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  let demoCredentials = null;
  if (config.bootstrapAdminEmail) {
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(config.bootstrapAdminEmail);
    if (!exists) {
      const hash = await hashPassword(config.bootstrapAdminPassword || randomToken(12) + 'a1');
      db.prepare(`INSERT INTO users (tenant_id, email, password_hash, name, role, status, created_at)
        VALUES (?,?,?,?,?,'active',?)`).run(tenant.id, config.bootstrapAdminEmail, hash, '管理员', 'owner', nowIso());
      created = true;
    }
  }
  if (!userCount && !config.isProd && !config.bootstrapAdminEmail) {
    const hash = await hashPassword(process.env.DEMO_PASSWORD || 'demo12345');
    db.prepare(`INSERT INTO users (tenant_id, email, password_hash, name, role, status, created_at)
      VALUES (?,?,?,?,?,'active',?)`).run(tenant.id, 'demo@scout.local', hash, '演示账号', 'owner', nowIso());
    demoCredentials = { email: 'demo@scout.local', password: process.env.DEMO_PASSWORD || 'demo12345' };
    created = true;
  }
  return { tenant, created, demoCredentials };
}

function tenantStats(tenantId) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM users WHERE tenant_id = ?) AS users,
    (SELECT COUNT(*) FROM products WHERE tenant_id = ? AND status='active') AS products,
    (SELECT COUNT(*) FROM sessions WHERE tenant_id = ?) AS sessions`).get(tenantId, tenantId, tenantId);
}

module.exports = {
  COOKIE, PERMS, can, assertPassword, createSession, authenticate, destroySession, destroyUserSessions,
  cleanupSessions, login, authenticateApiKey, createApiKey, listApiKeys, revokeApiKey,
  listUsers, createUser, updateUser, updatePassword, ensureBootstrap, tenantStats
};
