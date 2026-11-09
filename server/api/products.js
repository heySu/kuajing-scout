'use strict';
/** 商品池接口：列表/详情/增改/归档/导入/导出。静态路径必须注册在 :id 之前。 */
const products = require('../services/products');
const plans = require('../services/plans');
const usage = require('../services/usage');
const audit = require('../services/audit');
const { validate } = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const { today } = require('../lib/time');
const { seriesFor } = require('../services/snapshots');

module.exports = (route) => {
  route('GET', '/api/products', { perm: 'read' }, (ctx) => products.list(ctx.tenantId, {
    q: ctx.query.get('q') || '',
    scene: ctx.query.get('scene') || '',
    category: ctx.query.get('category') || '',
    verdict: ctx.query.get('verdict') || '',
    status: ctx.query.get('status') || 'active',
    sort: ctx.query.get('sort') || 'score',
    order: ctx.query.get('order') || 'desc',
    page: ctx.query.get('page'),
    pageSize: ctx.query.get('pageSize'),
    minScore: ctx.query.get('minScore'),
    maxScore: ctx.query.get('maxScore'),
    risk: ctx.query.get('risk')
  }));

  route('GET', '/api/products/export.csv', { perm: 'export', limit: { name: 'export', limit: 30, windowMs: 3600_000 } }, (ctx) => {
    plans.assertQuota(ctx.tenantId, 'exportsPerMonth');
    const csv = products.exportCsv(ctx.tenantId, { status: ctx.query.get('status') || 'active' });
    usage.record(ctx.tenantId, 'export', { meta: { kind: 'products' } });
    audit.log(ctx.tenantId, ctx.user.id, 'product.export', 'csv', '', ctx.ip);
    ctx.download(`scout-products-${today()}.csv`, csv);
  });

  route('GET', '/api/products/template.csv', { perm: 'read' }, (ctx) => {
    const header = ['商品名', '编码', '品类', '平台', '拿货价CNY', '售价USD', '重量g', '趋势分', '竞争度', '复购', '差异化', '物流', '合规风险', '关税率', '目标毛利率', '备注'];
    const sample = [
      '示例·磁吸手机支架', 'SKU-DEMO-1', '车载配件', 'temu', '3.2', '10.99', '180', '80', '60', '45', '55', 'light', 'low', '0.25', '0.45', '套装可差异化'
    ];
    const csv = '\uFEFF' + header.join(',') + '\r\n' + sample.join(',') + '\r\n';
    ctx.download('scout-import-template.csv', csv);
  });

  route('GET', '/api/products/stats', { perm: 'read' }, (ctx) => {
    const list = products.list(ctx.tenantId, { pageSize: 1 });
    return { summary: list.pool, weights: list.weights, facets: list.facets };
  });

  route('GET', '/api/products/trend', { perm: 'read' }, (ctx) => {
    const id = Number(ctx.query.get('id'));
    if (!Number.isInteger(id) || id <= 0) throw badRequest('id 不合法');
    const days = Math.min(90, Math.max(7, Number(ctx.query.get('days')) || 30));
    return { product_id: id, series: seriesFor(ctx.tenantId, id, days) };
  });

  route('GET', '/api/products/:id', { perm: 'read' }, (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('id 不合法');
    return { product: products.getProduct(ctx.tenantId, id) };
  });

  route('POST', '/api/products', { perm: 'write_product', limit: { name: 'product_write', limit: 120, windowMs: 3600_000 } }, (ctx) => {
    const product = products.create(ctx.tenantId, ctx.body, { userId: ctx.user.id, ip: ctx.ip });
    return { product };
  });

  route('POST', '/api/products/import', {
    perm: 'write_product',
    bodyLimit: 1024 * 1024,
    limit: { name: 'import', limit: 20, windowMs: 3600_000 }
  }, (ctx) => {
    const body = validate(ctx.body, { csv: { type: 'string', required: true, maxLen: 1000000 } });
    return products.importCsv(ctx.tenantId, body.csv, { userId: ctx.user.id, ip: ctx.ip });
  });

  route('POST', '/api/products/:id/restore', { perm: 'write_product' }, (ctx) => {
    const id = Number(ctx.params.id);
    return products.setStatus(ctx.tenantId, id, 'active', { userId: ctx.user.id, ip: ctx.ip });
  });

  route('PATCH', '/api/products/:id', { perm: 'write_product', limit: { name: 'product_write', limit: 300, windowMs: 3600_000 } }, (ctx) => {
    const id = Number(ctx.params.id);
    const product = products.update(ctx.tenantId, id, ctx.body, { userId: ctx.user.id, ip: ctx.ip });
    return { product };
  });

  route('DELETE', '/api/products/:id', { perm: 'write_product' }, (ctx) => {
    const id = Number(ctx.params.id);
    return products.setStatus(ctx.tenantId, id, 'archived', { userId: ctx.user.id, ip: ctx.ip });
  });
};
