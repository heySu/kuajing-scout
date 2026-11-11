'use strict';
/**
 * 成片工厂接口：
 *   - GET  /api/video/providers                  供应商可用状态 / 单价（前端渲染徽标）
 *   - POST /api/products/:id/video               提交成片生成（可灵 / HeyGen），写任务 ID 并按秒记账
 *   - GET  /api/products/:id/video/:provider/status  查询成片任务状态（沙盒恒 succeeded；真实模式轮询）
 */
const video = require('../services/video');
const { validate } = require('../lib/validate');
const { badRequest } = require('../lib/errors');

function parseId(ctx) {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('id 不合法');
  return id;
}

module.exports = (route) => {
  route('GET', '/api/video/providers', { perm: 'read' }, () => {
    return { providers: video.listProviders() };
  });

  // 配置自检（不发网络请求）：确认密钥是否就位、真实/沙盒模式、单段上限与端点
  route('GET', '/api/video/selfcheck', { perm: 'read' }, () => {
    return { providers: video.selfCheck() };
  });

  route('POST', '/api/products/:id/video', { perm: 'write_product' }, async (ctx) => {
    const id = parseId(ctx);
    const body = validate(ctx.body, {
      provider: { type: 'enum', enum: video.PROVIDERS },
      duration: { type: 'enum', enum: video.DURATIONS.map(String) },
      prompt: { type: 'string', maxLen: 8000 },
      image_url: { type: 'string', maxLen: 2000 },
      avatar_id: { type: 'string', maxLen: 120 }
    });
    const result = await video.submitVideo(ctx.tenantId, id, {
      provider: body.provider,
      duration: Number(body.duration),
      prompt: body.prompt,
      image_url: body.image_url,
      avatar_id: body.avatar_id
    }, { userId: ctx.user.id, ip: ctx.ip });
    return { video: result, spv: require('../services/spu').getSpv(ctx.tenantId, id) };
  });

  route('GET', '/api/products/:id/video/:provider/status', { perm: 'read' }, async (ctx) => {
    const id = parseId(ctx);
    const status = await video.getStatus(ctx.tenantId, id, ctx.params.provider);
    return { status };
  });
};
