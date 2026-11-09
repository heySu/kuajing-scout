'use strict';
/** 日报接口。 */
const agent = require('../services/agent');
const { validate } = require('../lib/validate');
const { badRequest, notFound } = require('../lib/errors');
const { today, addDays } = require('../lib/time');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = (route) => {
  route('GET', '/api/reports', { perm: 'read' }, (ctx) => ({
    reports: agent.listReports(ctx.tenantId, Number(ctx.query.get('limit')) || 30),
    today: today()
  }));

  route('POST', '/api/reports/generate', {
    perm: 'generate_report',
    limit: { name: 'generate', limit: 12, windowMs: 3600_000 }
  }, async (ctx) => {
    const body = validate(ctx.body, {
      use_llm: { type: 'bool', default: true },
      day: { type: 'string', maxLen: 10 }
    }, { partial: false, allowUnknown: false });
    if (body.day && (!DAY_RE.test(body.day) || body.day > today())) throw badRequest('日期不合法');
    const result = await agent.generateReport({
      tenantId: ctx.tenantId,
      actor: { userId: ctx.user.id, ip: ctx.ip },
      day: body.day || today(),
      useLLM: body.use_llm
    });
    return { ...result, quota: require('../services/plans').usageOf(ctx.tenantId) };
  });

  route('POST', '/api/reports/snapshot', { perm: 'generate_report' }, (ctx) => {
    const { recordSnapshots } = require('../services/snapshots');
    const n = recordSnapshots(ctx.tenantId, today(), 'manual');
    return { ok: true, products: n, day: today() };
  });

  route('GET', '/api/reports/:day', { perm: 'read' }, (ctx) => {
    if (!DAY_RE.test(ctx.params.day)) throw badRequest('日报日期格式应为 YYYY-MM-DD');
    const report = agent.getReport(ctx.tenantId, ctx.params.day);
    if (!report) throw notFound('当天没有日报');
    return { report };
  });

  route('GET', '/api/reports/:day/markdown', { perm: 'export' }, (ctx) => {
    if (!DAY_RE.test(ctx.params.day)) throw badRequest('日报日期格式应为 YYYY-MM-DD');
    const report = agent.getReport(ctx.tenantId, ctx.params.day);
    if (!report) throw notFound('当天没有日报');
    ctx.download(`scout-report-${ctx.params.day}.md`, report.content, 'text/markdown; charset=utf-8');
  });
};
