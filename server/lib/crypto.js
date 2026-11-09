'use strict';
/** 密码散列（scrypt）+ 令牌生成/摘要。只用 node:crypto，避免 bcrypt 原生编译。 */
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 返回 scrypt$N$r$p$saltB64$hashB64 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('password_too_short');
  if (password.length > 200) throw new Error('password_too_long');
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** 常量时间校验；格式非法一律 false */
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scryptAsync(String(password).normalize('NFKC'), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function hmac(value, secret) { return crypto.createHmac('sha256', secret).update(String(value)).digest('hex'); }
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 生成形如 ks_live_xxx 的 API Key，返回明文与可存储的摘要 */
function newApiKey() {
  const prefix = 'ks_' + crypto.randomBytes(3).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  return { plain: `${prefix}_${secret}`, prefix, hash: sha256(`${prefix}_${secret}`) };
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, hmac, timingSafeEqualStr, newApiKey };
