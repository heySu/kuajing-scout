'use strict';
/** 结构化日志（JSON 行），便于接 Loki/ELK；同时输出人类可读的控制台行。 */
const { config } = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  // 防御：绝不把凭据写进日志
  for (const k of ['password', 'token', 'authorization', 'cookie', 'apiKey', 'secret']) {
    if (line[k]) line[k] = '[redacted]';
  }
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

module.exports = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
  child: (base) => ({
    debug: (m, f = {}) => emit('debug', m, { ...base, ...f }),
    info: (m, f = {}) => emit('info', m, { ...base, ...f }),
    warn: (m, f = {}) => emit('warn', m, { ...base, ...f }),
    error: (m, f = {}) => emit('error', m, { ...base, ...f })
  })
};
