'use strict';
/**
 * 创建/重置管理员账号（无交互，适合部署脚本）：
 *   node server/cli/create-user.js --email a@b.com --password 'REPLACE_WITH_A_STRONG_PASSWORD' [--name 张三] [--role owner] [--tenant default]
 */
const { initSchema } = require('../db');
const { db, close } = require('../db');
const auth = require('../services/auth');
const { nowIso } = require('../lib/time');
const { hashPassword } = require('../lib/crypto');

function arg(name, dflt = '') {
  const idx = process.argv.indexOf('--' + name);
  return idx > -1 && process.argv[idx + 1] ? process.argv[idx + 1] : dflt;
}

async function main() {
  initSchema();
  const email = arg('email').toLowerCase();
  const password = arg('password');
  const name = arg('name', '管理员');
  const role = arg('role', 'owner');
  const slug = arg('tenant', 'default');
  if (!email || !password) {
    console.error('用法: node server/cli/create-user.js --email you@example.com --password "REPLACE_WITH_A_STRONG_PASSWORD" [--role owner]');
    process.exit(1);
  }
  if (!['owner', 'admin', 'analyst', 'viewer'].includes(role)) {
    console.error('角色必须是 owner/admin/analyst/viewer');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('密码至少 10 位');
    process.exit(1);
  }
  let tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!tenant) {
    const info = db.prepare('INSERT INTO tenants (name, slug, plan, status, created_at) VALUES (?,?,?,?,?)')
      .run(slug, slug, 'pro', 'active', nowIso());
    tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(info.lastInsertRowid));
    console.log('已创建租户:', tenant.slug);
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const hash = await hashPassword(password);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ?, status = ? WHERE id = ?').run(hash, role, 'active', existing.id);
    console.log('已重置密码:', email);
  } else {
    db.prepare(`INSERT INTO users (tenant_id, email, password_hash, name, role, status, created_at)
      VALUES (?,?,?,?,?,'active',?)`).run(tenant.id, email, hash, name, role, nowIso());
    console.log('已创建账号:', email, '角色:', role);
  }
  auth.destroyUserSessions(existing?.id || 0);
  close();
}

main().catch((e) => { console.error(e); process.exit(1); });
