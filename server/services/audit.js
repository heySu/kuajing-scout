'use strict';
/** 审计日志：谁在什么时候改了什么，商用与合规（等保/ISO）都要求可追溯。 */
const { db } = require('../db');
const { nowIso } = require('../lib/time');

function log(tenantId, userId, action, target = '', detail = '', ip = '') {
  const safe = (v, n) => String(v ?? '').slice(0, n);
  db.prepare(`INSERT INTO audit_logs (tenant_id, user_id, action, target, detail, ip, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, userId || null, safe(action, 80), safe(target, 120), safe(detail, 2000), safe(ip, 60), nowIso());
}

function list(tenantId, limit = 50) {
  return db.prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit);
}

module.exports = { log, list };
