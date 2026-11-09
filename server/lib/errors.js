'use strict';
/** 统一错误类型：携带 HTTP 状态、机器可读 code、可选 details。 */
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    const body = { error: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
const unauthorized = (msg = '请先登录') => new HttpError(401, 'unauthorized', msg);
const forbidden = (msg = '没有权限执行该操作') => new HttpError(403, 'forbidden', msg);
const notFound = (msg = '资源不存在') => new HttpError(404, 'not_found', msg);
const conflict = (msg) => new HttpError(409, 'conflict', msg);
const tooMany = (msg = '请求过于频繁，请稍后再试', retryAfter) =>
  new HttpError(429, 'rate_limited', msg, retryAfter ? { retry_after: retryAfter } : undefined);
const quotaExceeded = (msg, details) => new HttpError(402, 'quota_exceeded', msg, details);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, quotaExceeded };
