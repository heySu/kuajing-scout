'use strict';
/**
 * 轻量 schema 校验：不引三方库，保持零依赖；错误信息对前端友好。
 * schema: { field: { type, required, min, max, maxLen, enum, pattern, default } }
 */
const { badRequest } = require('./errors');

function coerce(value, spec, key) {
  const { type } = spec;
  if (value === null) {
    if (spec.nullable) return null;
    throw badRequest(`字段 ${key} 不能为空`);
  }
  if (type === 'string') {
    const s = String(value).trim();
    if (spec.maxLen && s.length > spec.maxLen) throw badRequest(`字段 ${key} 超过最大长度 ${spec.maxLen}`);
    if (spec.pattern && !spec.pattern.test(s)) throw badRequest(`字段 ${key} 格式不合法`);
    return s;
  }
  if (type === 'number' || type === 'int') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw badRequest(`字段 ${key} 必须是数字`);
    if (type === 'int' && !Number.isInteger(n)) throw badRequest(`字段 ${key} 必须是整数`);
    if (spec.min !== undefined && n < spec.min) throw badRequest(`字段 ${key} 不能小于 ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw badRequest(`字段 ${key} 不能大于 ${spec.max}`);
    return n;
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
    throw badRequest(`字段 ${key} 必须是布尔值`);
  }
  if (type === 'enum') {
    const s = String(value);
    if (!spec.enum.includes(s)) throw badRequest(`字段 ${key} 必须是 ${spec.enum.join('/')} 之一`);
    return s;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw badRequest(`字段 ${key} 必须是数组`);
    if (spec.maxItems && value.length > spec.maxItems) throw badRequest(`字段 ${key} 最多 ${spec.maxItems} 项`);
    return spec.items ? value.map((v, i) => coerce(v, spec.items, `${key}[${i}]`)) : value;
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`字段 ${key} 必须是对象`);
    return spec.schema ? validate(value, spec.schema) : value;
  }
  throw new Error('unknown schema type: ' + type);
}

/**
 * @param {object} input
 * @param {object} schema
 * @param {{partial?: boolean, allowUnknown?: boolean}} opts partial=true 时只校验出现的字段
 */
function validate(input, schema, opts = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  const out = {};
  const unknown = [];
  const errors = [];

  for (const [key, value] of Object.entries(input)) {
    if (!schema[key]) { unknown.push(key); continue; }
    if (value === undefined) continue;
    try { out[key] = coerce(value, schema[key], key); }
    catch (e) { errors.push({ field: key, message: e.message }); }
  }

  for (const [key, spec] of Object.entries(schema)) {
    if (out[key] !== undefined) continue;
    if (spec.default !== undefined && !opts.partial) { out[key] = spec.default; continue; }
    if (spec.required && !opts.partial) {
      if (!errors.some((e) => e.field === key)) errors.push({ field: key, message: `字段 ${key} 必填` });
    }
  }

  if (errors.length) throw badRequest('参数校验失败', { fields: errors });
  if (!opts.allowUnknown && unknown.length) {
    throw badRequest('包含未知字段', { fields: unknown.map((f) => ({ field: f, message: '不支持的字段' })) });
  }
  if (opts.partial && Object.keys(out).length === 0) throw badRequest('没有可更新的字段');
  return out;
}

module.exports = { validate };
