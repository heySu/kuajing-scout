'use strict';
/**
 * 热备份：使用 SQLite VACUUM INTO 生成一致性快照（服务运行中也可执行）。
 *   node server/cli/backup.js [--keep 14]
 * 产物：data/backups/scout-YYYYMMDD-HHmmss.db
 */
const fs = require('node:fs');
const path = require('node:path');
const { db, close } = require('../db');
const { config } = require('../config');

function parseKeep() {
  const idx = process.argv.indexOf('--keep');
  const n = idx > -1 ? Number(process.argv[idx + 1]) : 14;
  return Number.isInteger(n) && n > 0 ? n : 14;
}

function main() {
  const dir = path.join(path.dirname(config.dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `scout-${stamp}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`备份完成: ${file} (${size} MB)`);

  // 只保留最近 N 份
  const keep = parseKeep();
  const files = fs.readdirSync(dir).filter((f) => /^scout-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
  for (const f of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, f));
    console.log('已清理旧备份:', f);
  }
  close();
}

main();
