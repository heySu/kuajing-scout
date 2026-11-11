'use strict';
/**
 * SPU 打通层接口：以商品为 SPU 主数据枢纽，提供
 *   - 完整 SPU 视图（GET /api/products/:id/spu）
 *   - 下游（脚本/成片工具）消费的 JSON 导出（GET /api/products/:id/spu.json）
 *   - 跨工具 JSON 合并导入（POST /api/products/:id/spu-import，打通 profit / listing）
 *   - 脚本/卖点/内容状态编写（PATCH /api/products/:id/script）
 *   - 按秒成本记账（POST /api/products/:id/cost-ledger）
 * 路由均为 /api/products/:id/* 四段路径，不与 products 的静态路径冲突。
 */
const spu = require('../services/spu');
const { validate } = require('../lib/validate');
const { badRequest } = require('../lib/errors');

function parseId(ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('id 不合法');
  return id;
}

module.exports = (route) => {
  route('GET', '/api/products/:id/spu', { perm: 'read' }, (ctx) => {
    const id = parseId(ctx);
    return { spv: spu.getSpv(ctx.tenantId, id) };
  });

  route('GET', '/api/products/:id/spu.json', { perm: 'read' }, (ctx) => {
    const id = parseId(ctx);
    const payload = spu.exportPayload(ctx.tenantId, id);
    ctx.download(`spu-${id}.json`, JSON.stringify(payload, null, 2), 'application/json');
  });

  route('POST', '/api/products/:id/spu-import', { perm: 'write_product' }, (ctx) => {
    const id = parseId(ctx);
    const payload = (ctx.body && typeof ctx.body === 'object' && ctx.body.payload) ? ctx.body.payload : ctx.body;
    const { imported } = spu.importFromModules(ctx.tenantId, id, payload, { userId: ctx.user.id, ip: ctx.ip });
    return { imported, spv: spu.getSpv(ctx.tenantId, id) };
  });

  route('PATCH', '/api/products/:id/script', { perm: 'write_product' }, (ctx) => {
    const id = parseId(ctx);
    const body = validate(ctx.body, {
      selling_points: { type: 'string', maxLen: 1000 },
      pain_points: { type: 'string', maxLen: 1000 },
      target_audience: { type: 'string', maxLen: 200 },
      scenario: { type: 'string', maxLen: 500 },
      script_15s: { type: 'string', maxLen: 8000 },
      script_30s: { type: 'string', maxLen: 8000 },
      script_60s: { type: 'string', maxLen: 8000 },
      voiceover: { type: 'string', maxLen: 8000 },
      content_tags: { type: 'string', maxLen: 200 },
      content_status: { type: 'enum', enum: ['none', 'draft', 'reviewing', 'approved', 'delivered'] },
      kling_task_id: { type: 'string', maxLen: 120 },
      heygen_task_id: { type: 'string', maxLen: 120 },
      tier: { type: 'enum', enum: ['', '15', '30', '60'] },
      order_status: { type: 'enum', enum: ['none', 'paid', 'producing', 'delivered'] },
      customer_id: { type: 'string', maxLen: 120 },
      access_code: { type: 'string', maxLen: 120 }
    }, { partial: true });
    spu.writeFields(ctx.tenantId, id, body, { userId: ctx.user.id, ip: ctx.ip });
    return { spv: spu.getSpv(ctx.tenantId, id) };
  });

  route('POST', '/api/products/:id/cost-ledger', { perm: 'write_product' }, (ctx) => {
    const id = parseId(ctx);
    const body = validate(ctx.body, {
      kind: { type: 'string', maxLen: 40 },
      seconds: { type: 'number', min: 0, max: 100000 },
      cost_usd: { type: 'number', min: 0, max: 100000 }
    });
    const ledger = spu.addCostLedger(ctx.tenantId, id, body, { userId: ctx.user.id, ip: ctx.ip });
    return { cost_ledger: ledger, total_cost_usd: spu.getSpv(ctx.tenantId, id).total_cost_usd };
  });
};
