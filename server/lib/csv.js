'use strict';
/** CSV 读写：支持引号转义、BOM、CRLF；导出时防公式注入。 */

function parseCsv(text) {
  if (typeof text !== 'string') throw new Error('csv 必须是字符串');
  let src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx].trim() : ''; });
    return obj;
  });
  return { headers, records };
}

/** Excel 会把 = + - @ 开头的单元格当公式执行，导出前加单引号前缀 */
function sanitizeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toCsv(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = sanitizeCell(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(esc).join(',')];
  for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { parseCsv, toCsv, sanitizeCell };
