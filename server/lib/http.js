'use strict';
/** HTTP 基础设施：响应、请求体读取（限长）、安全响应头、静态文件。 */
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config');
const { HttpError } = require('./errors');

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    ...extraHeaders
  });
  res.end(body);
}

function sendDownload(res, filename, content, contentType = 'text/csv; charset=utf-8') {
  const body = Buffer.from(content, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 读取 JSON 请求体，超限抛 413；解析失败抛 400 */
function readJsonBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume();
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(new HttpError(413, 'payload_too_large', `请求体超过 ${Math.round(limit / 1024)}KB`));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return reject(new HttpError(400, 'bad_json', '请求体不是合法 JSON')); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, 'bad_json', '请求体必须是 JSON 对象'));
      }
      resolve(parsed);
    });
    req.on('error', (e) => fail(e));
    req.on('aborted', () => fail(new HttpError(499, 'client_closed', '客户端中断')));
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // 允许内联 style：图表宽度/颜色由 JS 以数值写入 style 属性，脚本与数据均已转义；
    // 若后续引入用户自定义主题，应改为 CSS 变量 + 类名，去掉 unsafe-inline。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

/** 静态文件：严格路径包含校验 + 扩展名白名单 + ETag 协商缓存 */
function serveStatic(req, res, rootDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return sendText(res, 400, 'bad path'); }
  if (decoded.includes('\0')) return sendText(res, 400, 'bad path');

  let rel = decoded.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  else if (rel === 'login') rel = 'login.html';

  const abs = path.resolve(rootDir, rel);
  const relCheck = path.relative(rootDir, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return sendText(res, 403, 'forbidden');
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) return sendText(res, 404, 'not found');
  if (path.basename(abs).startsWith('.')) return sendText(res, 404, 'not found');

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'not found');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': st.size,
      'Cache-Control': cache,
      ETag: etag
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

module.exports = { sendJson, sendText, sendDownload, readJsonBody, applySecurityHeaders, serveStatic, MIME };
