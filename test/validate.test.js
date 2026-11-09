'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../server/lib/validate');

const schema = {
  name: { type: 'string', required: true, maxLen: 10 },
  count: { type: 'number', min: 0, max: 100, default: 5 },
  mode: { type: 'enum', enum: ['a', 'b'], default: 'a' },
  flag: { type: 'bool', default: false },
  note: { type: 'string', maxLen: 20, default: '' },
  nullable: { type: 'number', min: 0, max: 1, nullable: true, default: null }
};

/** 取字段级错误信息，便于断言 */
function fieldErrors(fn) {
  try { fn(); } catch (e) {
    assert.equal(e.status, 400);
    return e.details?.fields?.map((f) => `${f.field}:${f.message}`) || [];
  }
  assert.fail('应当抛出校验错误');
}

test('必填校验与默认值', () => {
  assert.throws(() => validate({}, schema), /参数校验失败/);
  const out = validate({ name: 'x' }, schema);
  assert.equal(out.count, 5);
  assert.equal(out.mode, 'a');
  assert.equal(out.flag, false);
  assert.equal(out.nullable, null);
});

test('范围与类型错误会给出字段级提示', () => {
  const errs = fieldErrors(() => validate({ name: 'x', count: 500 }, schema));
  assert.ok(errs.some((e) => e.startsWith('count:') && e.includes('不能大于')));
  const typeErrs = fieldErrors(() => validate({ name: 'x', count: 'abc' }, schema));
  assert.ok(typeErrs.some((e) => e.includes('必须是数字')));
});

test('partial 模式不填默认值', () => {
  const out = validate({ count: 3 }, schema, { partial: true });
  assert.deepEqual(out, { count: 3 });
  assert.throws(() => validate({}, schema, { partial: true }), /没有可更新/);
});

test('未知字段被拒绝，null 仅对 nullable 生效', () => {
  const errs = fieldErrors(() => validate({ name: 'x', hack: 1 }, schema));
  assert.ok(errs.some((e) => e.includes('不支持的字段')));
  assert.equal(validate({ name: 'x', nullable: null }, schema).nullable, null);
  const nullErrs = fieldErrors(() => validate({ name: 'x', count: null }, schema));
  assert.ok(nullErrs.some((e) => e.includes('不能为空')));
});

test('字符串长度与枚举校验', () => {
  const lenErrs = fieldErrors(() => validate({ name: 'x'.repeat(11) }, schema));
  assert.ok(lenErrs.some((e) => e.includes('最大长度')));
  const enumErrs = fieldErrors(() => validate({ name: 'x', mode: 'c' }, schema));
  assert.ok(enumErrs.some((e) => e.includes('之一')));
});
