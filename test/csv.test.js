'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toCsv, sanitizeCell } = require('../server/lib/csv');

test('解析带引号、逗号、换行与 BOM 的 CSV', () => {
  const text = '\uFEFF商品名,备注\r\n"磁吸支架, 黑色","含""磁吸""\n第二行"\r\n普通商品,无\r\n';
  const { headers, records } = parseCsv(text);
  assert.deepEqual(headers, ['商品名', '备注']);
  assert.equal(records.length, 2);
  assert.equal(records[0]['商品名'], '磁吸支架, 黑色');
  assert.equal(records[0]['备注'], '含"磁吸"\n第二行');
});

test('空行被忽略，空文件返回空结果', () => {
  assert.deepEqual(parseCsv('\n\n'), { headers: [], records: [] });
  const { records } = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.equal(records.length, 2);
});

test('导出会转义引号并防止公式注入', () => {
  const csv = toCsv([{ name: '=cmd|calc', note: 'a"b' }], ['name', 'note']);
  assert.ok(csv.includes("'=cmd|calc"));
  assert.ok(csv.includes('"a""b"'));
  assert.equal(sanitizeCell('+1'), "'+1");
  assert.equal(sanitizeCell('@x'), "'@x");
  assert.equal(sanitizeCell('normal'), 'normal');
});

test('导出带 BOM，Excel 打开中文不乱码', () => {
  assert.equal(toCsv([{ a: '中文' }], ['a']).charCodeAt(0), 0xFEFF);
});
