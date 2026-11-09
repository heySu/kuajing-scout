'use strict';
/** 数据库连接：WAL + 外键 + busy_timeout；提供事务包装与优雅关闭。 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

const dir = path.dirname(config.dbPath);
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');
if (config.dbPath !== ':memory:') db.exec('PRAGMA temp_store = MEMORY');

let depth = 0;
/** 事务包装（可嵌套，内层用 SAVEPOINT） */
function tx(fn) {
  const savepoint = `sp_${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  depth += 1;
  try {
    const result = fn();
    depth -= 1;
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (e) {
    depth -= 1;
    if (depth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw e;
  }
}

function close() {
  try { db.close(); } catch { /* 已关闭 */ }
}

function initSchema() {
  const { runMigrations } = require('./migrations');
  return runMigrations();
}

module.exports = { db, tx, close, initSchema };
