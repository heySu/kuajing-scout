'use strict';
const { prepareEnv } = require('./helpers');
prepareEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { initSchema, db } = require('../server/db');
const auth = require('../server/services/auth');
const { hashPassword, verifyPassword } = require('../server/lib/crypto');

initSchema();

test('密码散列与校验（scrypt，含盐）', async () => {
  const hash = await hashPassword('REPLACE_WITH_A_STRONG_PASSWORD');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('REPLACE_WITH_A_STRONG_PASSWORD', hash), true);
  assert.equal(await verifyPassword('wrong-pass', hash), false);
  assert.equal(await verifyPassword('REPLACE_WITH_A_STRONG_PASSWORD', 'garbage'), false);
  await assert.rejects(hashPassword('short'), /password_too_short/);
});

test('初始化会创建租户与演示账号', async () => {
  const boot = await auth.ensureBootstrap();
  assert.ok(boot.tenant.id >= 1);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@scout.local');
  assert.ok(user);
  assert.equal(user.role, 'owner');
});

test('登录成功返回会话与 CSRF，密码错误统一报错', async () => {
  const res = await auth.login('demo@scout.local', 'demo12345', '127.0.0.1', 'test');
  assert.ok(res.token.length > 20);
  assert.ok(res.csrf.length > 10);
  const session = auth.authenticate(res.token);
  assert.equal(session.user.email, 'demo@scout.local');
  assert.equal(session.via, 'session');
  await assert.rejects(auth.login('demo@scout.local', 'bad-password', '', ''), /邮箱或密码不正确/);
  await assert.rejects(auth.login('nobody@example.com', 'whatever', '', ''), /邮箱或密码不正确/);
});

test('会话过期后失效，注销后立即失效', async () => {
  const res = await auth.login('demo@scout.local', 'demo12345', '', '');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() - 1000).toISOString(), require('../server/lib/crypto').sha256(res.token));
  assert.equal(auth.authenticate(res.token), null);

  const res2 = await auth.login('demo@scout.local', 'demo12345', '', '');
  assert.ok(auth.authenticate(res2.token));
  auth.destroySession(res2.token);
  assert.equal(auth.authenticate(res2.token), null);
});

test('成员创建、角色校验与重复邮箱', async () => {
  const boot = await auth.ensureBootstrap();
  const user = await auth.createUser(boot.tenant.id, {
    email: 'analyst@example.com', password: 'Analyst12345', name: '分析员', role: 'analyst'
  });
  assert.equal(user.role, 'analyst');
  await assert.rejects(auth.createUser(boot.tenant.id, { email: 'analyst@example.com', password: 'Analyst12345' }), /已注册/);
  await assert.rejects(auth.createUser(boot.tenant.id, { email: 'bad@example.com', password: 'short' }), /密码/);
  const list = auth.listUsers(boot.tenant.id);
  assert.ok(list.length >= 2);
});

test('权限矩阵：只读不能写，分析员不能改设置', () => {
  assert.equal(auth.can('viewer', 'read'), true);
  assert.equal(auth.can('viewer', 'write_product'), false);
  assert.equal(auth.can('analyst', 'write_product'), true);
  assert.equal(auth.can('analyst', 'manage_settings'), false);
  assert.equal(auth.can('admin', 'manage_settings'), true);
  assert.equal(auth.can('owner', 'manage_billing'), true);
});

test('API Key 创建、认证与撤销', async () => {
  const boot = await auth.ensureBootstrap();
  const key = auth.createApiKey(boot.tenant.id, 1, '测试脚本', 'read');
  assert.match(key.plain, /^ks_/);
  const ctx = auth.authenticateApiKey(key.plain);
  assert.equal(ctx.tenantId, boot.tenant.id);
  assert.deepEqual(ctx.scopes, ['read']);
  auth.revokeApiKey(boot.tenant.id, key.id);
  assert.equal(auth.authenticateApiKey(key.plain), null);
});

test('修改密码需要原密码，且新密码强度校验', async () => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('analyst@example.com');
  await assert.rejects(auth.updatePassword(user.id, 'wrong', 'NewPass12345'), /原密码/);
  await assert.rejects(auth.updatePassword(user.id, 'Analyst12345', 'weak'), /至少 10 位/);
  await auth.updatePassword(user.id, 'Analyst12345', 'NewPass12345');
  const updated = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(await verifyPassword('NewPass12345', updated.password_hash), true);
});
