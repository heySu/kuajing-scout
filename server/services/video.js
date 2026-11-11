'use strict';
/**
 * 成片工厂：对接可灵（Kling）/ HeyGen 生成带货成片，并把成本按秒记入 SPU 成本账本。
 *
 * 设计要点：
 *  - 以 products 表的 kling_task_id / heygen_task_id 存任务 ID，cost_ledger 按秒记账（kind=provider）。
 *  - 无 API Key 时走「沙盒模式」：本地造 taskId 并立即按配置单价 × 秒数记账，全链路与毛利核算可离线跑通。
 *  - 配置 KLING_API_KEY / HEYGEN_API_KEY 后自动切真实 API（对接公开文档端点，计费以你账户套餐为准）。
 *  - 真实模式下先提交拿 task_id 写库，按"提交即计规划成本"记账（成本由 秒数×单价 确定，与成片是否最终成功无关）。
 */
const { config } = require('../config');
const { badRequest, HttpError } = require('../lib/errors');
const spu = require('./spu');
const audit = require('./audit');

const PROVIDERS = ['kling', 'heygen'];
const DURATIONS = [15, 30, 60];

function getCfg(name) {
  const c = config.video && config.video[name];
  if (!c) throw badRequest('不支持的成片供应商：' + name);
  return c;
}
function isEnabled(name) { const c = getCfg(name); return !!c.apiKey; }

/** 把总时长拆成若干段（每段不超过 max 秒），用于可灵等长片上限的自动拆分 */
function planChunks(duration, max) {
  max = Math.max(1, Math.floor(Number(max) || 10));
  duration = Math.max(1, Math.floor(Number(duration) || 0));
  if (duration <= max) return [duration];
  const segs = [];
  let left = duration;
  while (left > 0) {
    const seg = Math.min(max, left);
    segs.push(seg);
    left -= seg;
  }
  return segs;
}

/** 单次供应商提交（注入点，便于测试时替换为假实现，避免真实网络调用） */
async function defaultCall(provider, tenantId, id, duration, prompt, imageUrl, avatarId) {
  if (provider === 'kling') return callKling(tenantId, id, duration, prompt, imageUrl);
  return callHeyGen(tenantId, id, duration, prompt, imageUrl, avatarId);
}

function computeCost(name, seconds) {
  const c = getCfg(name);
  const per = Number(c.perSecondUsd) || 0;
  return Math.round(per * seconds * 1e4) / 1e4;
}

/** 给前端展示供应商可用状态与单价 */
function listProviders() {
  return PROVIDERS.map((name) => {
    const c = getCfg(name);
    return {
      name,
      enabled: !!c.apiKey,
      configured: !!c.apiKey,
      mode: c.apiKey ? 'live' : 'sandbox',
      perSecondUsd: Number(c.perSecondUsd) || 0,
      maxSeconds: name === 'kling' ? (Number(c.maxSeconds) || 10) : null
    };
  });
}

/** 配置自检：不发起任何网络请求，仅核对接线状态，便于上线前确认密钥/端点是否正确 */
function selfCheck() {
  return PROVIDERS.map((name) => {
    const c = getCfg(name);
    const configured = !!c.apiKey;
    let note = '沙盒模式：本地造任务并立即按秒记账，无需密钥，全链路可离线跑通。';
    if (configured) {
      note = name === 'kling'
        ? `真实模式：提交至 ${c.baseUrl}/v1/videos（text2video/image2video），状态轮询 /v1/videos/{task_id}；单次上限 ${c.maxSeconds}s，超长自动拆段。`
        : `真实模式：提交至 ${c.baseUrl}/video.generate，状态轮询 /v2/video_status.get。`;
    }
    return {
      name,
      configured,
      mode: configured ? 'live' : 'sandbox',
      baseUrl: c.baseUrl,
      perSecondUsd: Number(c.perSecondUsd) || 0,
      maxSeconds: name === 'kling' ? (Number(c.maxSeconds) || 10) : null,
      note
    };
  });
}

function productScript(tenantId, id, duration) {
  const spv = spu.getSpv(tenantId, id);
  return {
    script: (spv.scripts && spv.scripts[String(duration)]) || '',
    material_refs: spv.material_refs || [],
    selling: spv.selling_points || ''
  };
}

/** 写回任务 ID + 按秒记账 + 审计 */
function finalize(tenantId, id, provider, taskId, seconds, costUsd, actor = {}) {
  const field = provider === 'kling' ? 'kling_task_id' : 'heygen_task_id';
  spu.writeFields(tenantId, id, { [field]: String(taskId) }, actor);
  spu.addCostLedger(tenantId, id, { kind: provider, seconds, cost_usd: costUsd }, actor);
  if (actor.userId) audit.log(tenantId, actor.userId, 'product.video.' + provider, String(id), `task=${taskId},sec=${seconds},usd=${costUsd}`, actor.ip);
}

function sandboxTaskId(provider) {
  return `sandbox-${provider}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 提交一次成片生成（可灵 / HeyGen）；真实可灵模式下超长自动分片提交并逐段记账 */
async function submitVideo(tenantId, id, opts, actor = {}, deps = {}) {
  const provider = String(opts.provider || '').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw badRequest('provider 必须是 kling / heygen');
  const duration = Number(opts.duration);
  if (!DURATIONS.includes(duration)) throw badRequest('duration 必须是 15 / 30 / 60（秒）');

  const info = productScript(tenantId, id, duration);
  const prompt = (opts.prompt && String(opts.prompt).trim()) || info.script || info.selling;
  const imageUrl = (opts.image_url && String(opts.image_url).trim()) || (info.material_refs[0] && (info.material_refs[0].url || '')) || '';
  const call = deps.call || defaultCall;

  if (!isEnabled(provider)) {
    // 沙盒模式：本地造任务 ID，立即按秒记账，模拟成功
    const taskId = sandboxTaskId(provider);
    const costUsd = computeCost(provider, duration);
    finalize(tenantId, id, provider, taskId, duration, costUsd, actor);
    return { provider, task_id: taskId, status: 'sandbox', seconds: duration, cost_usd: costUsd, sandbox: true };
  }

  // 真实模式：按供应商单次上限拆分；可灵公开版多为 5/10s 上限，需分段提交
  const cfg = getCfg(provider);
  const max = provider === 'kling' ? (Number(cfg.maxSeconds) || 10) : duration;
  const segs = planChunks(duration, max);
  const taskField = provider === 'kling' ? 'kling_task_id' : 'heygen_task_id';
  const taskIds = [];
  let totalCost = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const segPrompt = segs.length > 1 ? `${prompt} [片段 ${i + 1}/${segs.length}]` : prompt;
    const taskId = await call(provider, tenantId, id, seg, segPrompt, imageUrl, opts.avatar_id);
    taskIds.push(String(taskId));
    const segCost = computeCost(provider, seg);
    totalCost += segCost;
    spu.addCostLedger(tenantId, id, { kind: provider, seconds: seg, cost_usd: segCost }, actor);
  }
  const stored = taskIds.length === 1 ? taskIds[0] : JSON.stringify(taskIds);
  spu.writeFields(tenantId, id, { [taskField]: stored }, actor);
  if (actor.userId) audit.log(tenantId, actor.userId, 'product.video.' + provider, String(id), `tasks=${stored},segs=${segs.length},sec=${duration},usd=${totalCost}`, actor.ip);
  return {
    provider,
    task_id: taskIds.length === 1 ? taskIds[0] : taskIds,
    segments: segs.length,
    seconds: duration,
    cost_usd: Math.round(totalCost * 1e4) / 1e4,
    sandbox: false,
    status: 'submitted'
  };
}

async function callKling(tenantId, id, duration, prompt, imageUrl) {
  const c = getCfg('kling');
  const dur = String(duration);
  const body = imageUrl
    ? { model: c.model, image: imageUrl, prompt, mode: c.mode, duration: dur }
    : { model: c.model, prompt, mode: c.mode, duration: dur };
  const endpoint = c.baseUrl + '/v1/videos/' + (imageUrl ? 'image2video' : 'text2video');
  if (process.env.KS_VERBOSE_VIDEO) console.log('[video:kling] POST', endpoint);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const json = await safeJson(res);
  if (!res.ok || !json || !json.data || !json.data.task_id) {
    throw new HttpError(502, 'provider_unavailable', '可灵提交失败：HTTP ' + res.status + ' ' + safeMsg(json));
  }
  return String(json.data.task_id);
}

async function callHeyGen(tenantId, id, duration, prompt, imageUrl, avatarId) {
  const c = getCfg('heygen');
  const avatar_id = (avatarId && String(avatarId).trim()) || c.avatarId;
  const input = {
    character: { type: 'avatar', avatar_id: avatar_id || 'default', avatar_style: 'normal' },
    voice: { type: 'text', input_text: prompt || ' ' },
    background: imageUrl ? { type: 'image', image_url: imageUrl } : { type: 'color', value: '#ffffff' }
  };
  const body = { video_inputs: [input], dimension: { width: 1080, height: 1920 }, caption: false };
  const endpoint = c.baseUrl + '/video.generate';
  if (process.env.KS_VERBOSE_VIDEO) console.log('[video:heygen] POST', endpoint);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const json = await safeJson(res);
  if (!res.ok || !json || !json.data || !json.data.video_id) {
    throw new HttpError(502, 'provider_unavailable', 'HeyGen 提交失败：HTTP ' + res.status + ' ' + safeMsg(json));
  }
  return String(json.data.video_id);
}

/** 查询成片状态（沙盒恒为 succeeded；真实模式轮询供应商；支持多段任务聚合） */
async function getStatus(tenantId, id, provider, deps = {}) {
  if (!PROVIDERS.includes(provider)) throw badRequest('provider 必须是 kling / heygen');
  const spv = spu.getSpv(tenantId, id);
  const rawTaskId = provider === 'kling' ? spv.kling_task_id : spv.heygen_task_id;
  if (!rawTaskId) return { provider, task_id: '', status: 'none' };
  if (String(rawTaskId).startsWith('sandbox-')) return { provider, task_id: rawTaskId, status: 'succeeded', sandbox: true };
  if (!isEnabled(provider)) return { provider, task_id: rawTaskId, status: 'unknown', sandbox: false };

  // 真实模式：多段任务以 JSON 数组存储，逐段轮询后聚合（任一失败即失败，否则以最慢一段为准）
  let taskIds = [];
  try { const arr = JSON.parse(rawTaskId); if (Array.isArray(arr)) taskIds = arr; } catch { /* 单任务字符串 */ }
  if (!Array.isArray(taskIds) || !taskIds.length) taskIds = [rawTaskId];

  const pollOne = provider === 'kling' ? (deps.pollKling || pollKling) : (deps.pollHeyGen || pollHeyGen);
  let overall = 'succeeded';
  let finalUrl = '';
  for (const tid of taskIds) {
    let status = 'processing';
    let url = '';
    try {
      ({ status, url } = await pollOne(tid));
    } catch (e) {
      throw new HttpError(502, 'provider_unavailable', '查询' + provider + '状态失败：' + e.message);
    }
    if (url) finalUrl = url;
    if (status === 'failed') { overall = 'failed'; break; }
    if (status !== 'succeeded') overall = 'processing';
  }
  return { provider, task_id: taskIds.length === 1 ? taskIds[0] : taskIds, status: overall, sandbox: false, segments: taskIds.length, url: finalUrl || undefined };
}

async function pollKling(taskId) {
  const c = getCfg('kling');
  const res = await fetch(c.baseUrl + '/v1/videos/' + encodeURIComponent(taskId), {
    headers: { Authorization: 'Bearer ' + c.apiKey }, signal: AbortSignal.timeout(20000)
  });
  const json = await safeJson(res);
  // 轮询阶段的 5xx / 空响应视为「仍在处理」，避免一次瞬时故障让整条状态查询失败
  if (!res.ok || !json || !json.data) {
    if (process.env.KS_VERBOSE_VIDEO) console.log('[video:kling] poll non-ok', res.status, safeMsg(json));
    return { status: 'processing', url: '', degraded: true };
  }
  const d = json.data;
  const s = d.task_status;
  let url = '';
  if (d.task_result && Array.isArray(d.task_result.videos)) {
    url = (d.task_result.videos.find((v) => v.resource_url) || {}).resource_url || '';
  }
  if (s === 'succeed' || s === 'succeeded' || s === 'complete') return { status: 'succeeded', url };
  if (s === 'failed') return { status: 'failed', url };
  return { status: 'processing', url };
}

async function pollHeyGen(taskId) {
  const c = getCfg('heygen');
  const res = await fetch(c.baseUrl + '/video_status.get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey },
    body: JSON.stringify({ video_id: taskId }),
    signal: AbortSignal.timeout(20000)
  });
  const json = await safeJson(res);
  if (!res.ok || !json || !json.data) {
    if (process.env.KS_VERBOSE_VIDEO) console.log('[video:heygen] poll non-ok', res.status, safeMsg(json));
    return { status: 'processing', url: '', degraded: true };
  }
  const d = json.data;
  const s = d.status;
  const url = d.video_url || d.gif_url || '';
  if (s === 'completed' || s === 'success') return { status: 'succeeded', url };
  if (s === 'failed' || s === 'error') return { status: 'failed', url };
  return { status: 'processing', url };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}
function safeMsg(json) {
  if (!json) return '';
  if (json.message) return String(json.message);
  if (json.msg) return String(json.msg);
  if (json.error && json.error.message) return String(json.error.message);
  try { return JSON.stringify(json).slice(0, 200); } catch { return ''; }
}

module.exports = { PROVIDERS, DURATIONS, listProviders, selfCheck, isEnabled, computeCost, planChunks, submitVideo, getStatus };
