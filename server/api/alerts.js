'use strict';
/** 预警接口：列表、确认、重扫。 */
const alerts = require('../services/alerts');
const { allScored } = require('../services/products');
const { getConfig } = require('../services/settings');

module.exports = (route) => {
  route('GET', '/api/alerts', { perm: 'read' }, (ctx) => ({
    alerts: alerts.list(ctx.tenantId, { status: ctx.query.get('status') || 'open', limit: Number(ctx.query.get('limit')) || 50 }),
    summary: alerts.summary(ctx.tenantId)
  }));

  route('GET', '/api/alerts/summary', { perm: 'read' }, (ctx) => ({ summary: alerts.summary(ctx.tenantId) }));

  route('POST', '/api/alerts/ack-all', { perm: 'manage_alerts' }, (ctx) => alerts.ackAll(ctx.tenantId));

  route('POST', '/api/alerts/rescan', {
    perm: 'generate_report',
    limit: { name: 'rescan', limit: 20, windowMs: 3600_000 }
  }, (ctx) => {
    const created = alerts.evaluate(ctx.tenantId, allScored(ctx.tenantId), getConfig(ctx.tenantId));
    return { created, summary: alerts.summary(ctx.tenantId) };
  });

  route('POST', '/api/alerts/:id/ack', { perm: 'manage_alerts' }, (ctx) => alerts.ack(ctx.tenantId, Number(ctx.params.id)));
};
