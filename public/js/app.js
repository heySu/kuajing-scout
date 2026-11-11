'use strict';
/**
 * 工作台前端：原生 JS + 事件委托，无框架、无构建步骤。
 * 安全：所有动态文本经 esc() 转义；Markdown 先转义再渲染，链接仅允许 http(s)；
 *      所有写请求带 X-CSRF-Token（与 SameSite Cookie 双重防护）。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : '$' + Number(n).toFixed(2));
  const pct = (n, d = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : Number(n).toFixed(d) + '%');
  const cny = (n) => (n === null || n === undefined ? '-' : '¥' + Number(n).toFixed(2));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const state = {
    me: null,
    view: 'pool',
    settingsTab: 'cost',
    filters: { q: '', scene: '', category: '', verdict: '', content_status: '', sort: 'score', risk: false, page: 1, pageSize: 20 },
    pool: null,
    reports: [],
    reportDay: null,
    report: null,
    alerts: { list: [], summary: { open: 0, critical: 0, warn: 0 } },
    alertFilter: 'open',
    settings: null,
    users: [],
    keys: [],
    audit: [],
    detail: null,
    busy: false
  };

  // 成片状态轮询定时器（模块级，跨详情重渲染保持可取消）
  let videoPollTimer = null;

  const VIEW_META = {
    pool: { title: '选品池', sub: '按综合分排序，点击任意商品查看利润拆解与评分依据' },
    reports: { title: '选品日报', sub: '每天一份可执行的决策简报，规则引擎兜底、LLM 可选' },
    alerts: { title: '预警中心', sub: '亏损定价、合规高危、竞争红海与热度下滑自动汇总' },
    settings: { title: '成本与设置', sub: '利润口径、评分权重、预警推送与团队权限' }
  };

  /* ---------------- 工具 ---------------- */

  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (state.me?.csrf) headers['X-CSRF-Token'] = state.me.csrf;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin'
    });
    if (res.status === 401) {
      location.replace('/');
      throw new Error('登录已失效');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || '请求失败');
      err.status = res.status;
      err.code = data.error;
      err.details = data.details;
      throw err;
    }
    return data;
  }

  async function download(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || '下载失败');
    }
    const blob = await res.blob();
    const disp = res.headers.get('content-disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function can(action) { return (state.me?.permissions || []).includes(action); }

  function openDialog(id) {
    const d = document.getElementById(id);
    if (d && !d.open) d.showModal();
  }
  function closeDialog(id) {
    const d = document.getElementById(id);
    if (d && d.open) d.close();
  }

  function confirmBox({ title, text, okText = '确认', danger = true }) {
    return new Promise((resolve) => {
      const dlg = $('#confirmDialog');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      const ok = $('#confirmOk');
      ok.textContent = okText;
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      const done = (val) => { cleanup(); if (dlg.open) dlg.close(); resolve(val); };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onClose = () => done(false);
      function cleanup() {
        ok.removeEventListener('click', onOk);
        $('#confirmCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
      }
      ok.addEventListener('click', onOk);
      $('#confirmCancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  /* ---------------- 图表 ---------------- */

  function sparkline(series, w = 88, h = 26) {
    const vals = (series || []).map((s) => Number(s.trend_score)).filter((n) => Number.isFinite(n));
    if (vals.length < 2) return '<span class="muted small">无快照</span>';
    const min = Math.min(...vals); const max = Math.max(...vals); const span = Math.max(1, max - min);
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `0,${h} ${line} ${w},${h}`;
    const stroke = vals[vals.length - 1] >= vals[0] ? '#3fb950' : '#f0564d';
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 30 天热度趋势">
      <polygon class="area" points="${area}" fill="${stroke}"></polygon>
      <polyline points="${line}" stroke="${stroke}"></polyline></svg>`;
  }

  function trendChart(series, w = 520, h = 150) {
    const rows = (series || []).filter((s) => Number.isFinite(Number(s.trend_score)));
    if (rows.length < 2) return '<div class="empty">暂无足够快照数据，无法绘制趋势</div>';
    const vals = rows.map((s) => Number(s.trend_score));
    const min = Math.max(0, Math.floor(Math.min(...vals) - 5)); const max = Math.min(100, Math.ceil(Math.max(...vals) + 5));
    const span = Math.max(1, max - min);
    const padL = 30; const padB = 22; const padT = 8; const padR = 8;
    const iw = w - padL - padR; const ih = h - padT - padB;
    const pts = vals.map((v, i) => [padL + (i / (vals.length - 1)) * iw, padT + ih - ((v - min) / span) * ih]);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${padL},${padT + ih} ${line} ${padL + iw},${padT + ih}`;
    const stroke = vals[vals.length - 1] >= vals[0] ? '#3fb950' : '#f0564d';
    const grid = [0, 0.5, 1].map((r) => {
      const y = padT + ih - r * ih;
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + iw}" y2="${y.toFixed(1)}" stroke="#263241" stroke-dasharray="3 4"></line>
        <text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#8593a3">${Math.round(min + r * span)}</text>`;
    }).join('');
    const labels = [0, rows.length - 1].map((idx) => {
      const x = padL + (idx / Math.max(1, vals.length - 1)) * iw;
      return `<text x="${idx === 0 ? padL : padL + iw}" y="${h - 6}" text-anchor="${idx === 0 ? 'start' : 'end'}" font-size="10" fill="#8593a3">${esc(String(rows[idx].day).slice(5))}</text>`;
    }).join('');
    return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 30 天热度趋势图" preserveAspectRatio="none">
      ${grid}<polygon points="${area}" fill="${stroke}" opacity="0.10"></polygon>
      <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="2"></polyline>
      ${labels}</svg>`;
  }

  function factorBar(f) {
    const color = f.key === 'trend' ? 'green' : f.key === 'profit' ? 'blue' : f.key === 'differentiation' ? 'violet' : 'amber';
    return `<div class="factor">
      <span class="label">${esc(f.label)} <span class="contribution">×${Math.round(f.weight * 100)}%</span></span>
      <span class="bar"><i class="${color}" style="width:${clamp(f.score, 0, 100)}%"></i></span>
      <span class="val">${f.score} → ${f.contribution}</span>
    </div>`;
  }

  /* Markdown 渲染统一由 /js/markdown.js 提供（同一套实现有单测覆盖） */
  const mdToHtml = (md) => window.KSMarkdown.render(md);

  /* ---------------- 外壳 ---------------- */

  function renderShell() {
    const me = state.me;
    if (!me) return;
    $('#userName').textContent = me.user.name || me.user.email;
    $('#userRole').textContent = ({ owner: '所有者', admin: '管理员', analyst: '分析员', viewer: '只读' })[me.user.role] || me.user.role;
    $('#userAvatar').textContent = (me.user.name || me.user.email).slice(0, 1).toUpperCase();
    $('#demoBanner').hidden = !me.demo_mode;

    const plan = me.plan;
    const limits = plan.limits;
    const used = me.usage;
    $('#planName').textContent = plan.name;
    $('#planBadge').textContent = plan.key === 'pro' ? 'PRO' : plan.key === 'team' ? 'TEAM' : plan.key === 'enterprise' ? 'ENT' : 'FREE';
    const usageRatio = limits.products ? Math.min(1, used.products / limits.products) : 0;
    $('#planUsageText').textContent = `商品 ${used.products}/${limits.products} · 本月 AI 日报 ${used.llmReportsPerMonth}/${limits.llmReportsPerMonth}`;
    $('#planUsageBar').style.width = Math.round(usageRatio * 100) + '%';

    // 顶部按钮按视图与权限显示
    const isPool = state.view === 'pool';
    const isReports = state.view === 'reports';
    $('#btnAddProduct').hidden = !isPool || !can('write_product');
    $('#btnImport').hidden = !isPool || !can('write_product');
    $('#btnExport').hidden = !isPool || !can('export');
    $('#btnGenerate').hidden = !(isPool || isReports) || !can('generate_report');
  }

  async function refreshBadge() {
    try {
      const { summary } = await api('/api/alerts/summary');
      state.alerts.summary = summary;
      const badge = $('#alertBadge');
      badge.textContent = String(summary.open);
      badge.hidden = summary.open === 0;
    } catch { /* 忽略 */ }
  }

  function setView(view) {
    if (!VIEW_META[view]) view = 'pool';
    state.view = view;
    $$('.nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    const meta = VIEW_META[view];
    $('#pageTitle').textContent = meta.title;
    $('#pageSub').textContent = meta.sub;
    renderShell();
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    renderView();
  }

  function renderView() {
    if (state.view === 'pool') return renderPool();
    if (state.view === 'reports') return renderReports();
    if (state.view === 'alerts') return renderAlerts();
    return renderSettings();
  }

  /* ---------------- 选品池 ---------------- */

  function filtersQuery() {
    const f = state.filters;
    const q = new URLSearchParams();
    q.set('page', f.page); q.set('pageSize', f.pageSize); q.set('sort', f.sort);
    if (f.q) q.set('q', f.q);
    if (f.scene) q.set('scene', f.scene);
    if (f.category) q.set('category', f.category);
    if (f.verdict) q.set('verdict', f.verdict);
    if (f.risk) q.set('risk', '1');
    return q.toString();
  }

  async function loadPool() {
    state.pool = await api('/api/products?' + filtersQuery());
    return state.pool;
  }

  async function renderPool() {
    let data;
    try { data = await loadPool(); }
    catch (e) { $('#view').innerHTML = '<div class="panel"><div class="empty">加载失败：' + esc(e.message) + '</div></div>'; return; }
    const p = data.pool;
    const f = state.filters;
    const CS_LABEL = { none: '未开始', draft: '草稿', reviewing: '审核中', approved: '已通过', delivered: '已交付' };
    const cats = data.facets.categories.filter((c) => c.value);
    const catOptions = ['<option value="">全部品类</option>'].concat(
      cats.map((c) => `<option value="${esc(c.value)}" ${f.category === c.value ? 'selected' : ''}>${esc(c.value)}（${c.count}）</option>`)
    ).join('');

    $('#view').innerHTML = `
      <section class="kpis" aria-label="商品池关键指标">
        <div class="kpi"><div class="label">在池商品</div><div class="val">${p.count}</div><div class="hint">筛选结果 ${data.total} 个 · 均价毛利 ${pct(p.avgMargin)}</div></div>
        <div class="kpi"><div class="label">平均综合分</div><div class="val">${p.avgScore}</div><div class="hint">趋势 40% + 利润 25% + 差异 20% + 复购 15%</div></div>
        <div class="kpi"><div class="label">高热商品</div><div class="val">${p.hot}</div><div class="hint">趋势分 ≥ 80，需备货窗口</div></div>
        <div class="kpi"><div class="label">风险商品</div><div class="val">${p.risky}</div><div class="hint">合规高危 ${p.loss ? '· 亏损 ' + p.loss : '或竞争 ≥ 80'}</div></div>
        <div class="kpi"><div class="label">今日首推</div><div class="val sm">${p.top ? esc(p.top.name) : '—'}</div><div class="hint">${p.top ? '综合分 ' + p.top.score + ' · ' + esc(p.top.verdict) : '暂无数据'}</div></div>
      </section>

      <section class="panel">
        <div class="toolbar" role="search">
          <input class="search-input" id="fq" type="search" placeholder="搜索商品名 / 品类 / SKU / 备注" value="${esc(f.q)}" aria-label="搜索商品">
          <select class="control" id="fscene" aria-label="平台筛选">
            <option value="">全部平台</option>
            <option value="temu" ${f.scene === 'temu' ? 'selected' : ''}>Temu</option>
            <option value="tiktok" ${f.scene === 'tiktok' ? 'selected' : ''}>TikTok Shop</option>
          </select>
          <select class="control" id="fcat" aria-label="品类筛选">${catOptions}</select>
          <select class="control" id="fverdict" aria-label="结论筛选">
            <option value="">全部结论</option>
            <option value="main" ${f.verdict === 'main' ? 'selected' : ''}>重点主推</option>
            <option value="test" ${f.verdict === 'test' ? 'selected' : ''}>可以测款</option>
            <option value="watch" ${f.verdict === 'watch' ? 'selected' : ''}>谨慎观察</option>
            <option value="review" ${f.verdict === 'review' ? 'selected' : ''}>合规待审</option>
            <option value="drop" ${f.verdict === 'drop' ? 'selected' : ''}>观望/放弃</option>
          </select>
          <select class="control" id="fcs" aria-label="内容状态筛选">
            <option value="">全部内容状态</option>
            <option value="none" ${f.content_status === 'none' ? 'selected' : ''}>未开始</option>
            <option value="draft" ${f.content_status === 'draft' ? 'selected' : ''}>草稿</option>
            <option value="reviewing" ${f.content_status === 'reviewing' ? 'selected' : ''}>审核中</option>
            <option value="approved" ${f.content_status === 'approved' ? 'selected' : ''}>已通过</option>
            <option value="delivered" ${f.content_status === 'delivered' ? 'selected' : ''}>已交付</option>
          </select>
          <select class="control" id="fsort" aria-label="排序">
            <option value="score" ${f.sort === 'score' ? 'selected' : ''}>按综合分</option>
            <option value="margin" ${f.sort === 'margin' ? 'selected' : ''}>按毛利率</option>
            <option value="net" ${f.sort === 'net' ? 'selected' : ''}>按单件净利</option>
            <option value="netincl" ${f.sort === 'netincl' ? 'selected' : ''}>按含成片后净利</option>
            <option value="cost" ${f.sort === 'cost' ? 'selected' : ''}>按成片成本（高→低）</option>
            <option value="trend" ${f.sort === 'trend' ? 'selected' : ''}>按趋势分</option>
            <option value="competition" ${f.sort === 'competition' ? 'selected' : ''}>按竞争度（低→高）</option>
            <option value="confidence" ${f.sort === 'confidence' ? 'selected' : ''}>按数据置信度</option>
            <option value="name" ${f.sort === 'name' ? 'selected' : ''}>按名称</option>
          </select>
          <label class="check"><input type="checkbox" id="frisk" ${f.risk ? 'checked' : ''}>只看风险</label>
          <span class="spacer" style="flex:1"></span>
          <span class="muted small">共 ${data.total} 条 · 第 ${data.page}/${data.totalPages} 页</span>
        </div>

        <div class="table-wrap">
          <table class="data">
            <thead><tr>
              <th>商品</th><th>平台</th><th>综合分</th><th class="num">毛利率</th><th class="num">单件净利</th>
              <th class="num">含成片后净利</th>
              <th class="num">保本价</th><th>30 天热度</th><th>竞争度</th><th>置信度</th><th>内容状态</th><th>结论</th>
            </tr></thead>
            <tbody>
              ${data.items.map((it) => `
                <tr data-action="detail" data-id="${it.id}" tabindex="0" role="button" aria-label="查看 ${esc(it.name)} 详情">
                  <td><div class="name">${esc(it.name)}</div><div class="meta">${esc(it.category)} · ${esc(it.sku || '无编码')} · ${cny(it.cost_cny)} → ${money(it.sale_usd)}</div></td>
                  <td><span class="pill scene-${it.scene}">${it.scene === 'temu' ? 'Temu' : 'TikTok'}</span></td>
                  <td><span class="score ${it.verdict_key}">${it.scout_score}</span></td>
                  <td class="num">${pct(it.margin_pct)}</td>
                  <td class="num" style="color:${it.profit.net_profit_usd > 0 ? 'inherit' : 'var(--red)'}">${money(it.profit.net_profit_usd)}</td>
                  <td class="num" style="color:${it.net_profit_incl_cost_usd > 0 ? 'inherit' : 'var(--red)'}">${money(it.net_profit_incl_cost_usd)}${it.total_cost_usd ? `<div class="muted small">成本 ${money(it.total_cost_usd)}</div>` : ''}</td>
                  <td class="num">${money(it.profit.break_even_usd)}</td>
                  <td>${sparkline(it.series, 84, 24)}</td>
                  <td><div class="bar-row"><span class="bar"><i class="${it.competition >= 80 ? 'red' : it.competition >= 60 ? 'amber' : 'green'}" style="width:${clamp(it.competition, 0, 100)}%"></i></span><span class="muted small">${Math.round(it.competition)}</span></div></td>
                  <td><span class="pill ${it.confidence >= 85 ? 'low' : it.confidence >= 65 ? 'mid' : 'high'}">${it.confidence_label}</span></td>
                  <td><span class="pill cs-${it.content_status || 'none'}">${CS_LABEL[it.content_status] || '未开始'}</span></td>
                  <td><span class="pill ${it.verdict_key}">${esc(it.verdict)}</span></td>
                </tr>`).join('') || `<tr><td colspan="12"><div class="empty"><h3>没有匹配的商品</h3><p>换个筛选条件，或导入商品数据</p><button class="btn btn-primary" data-action="add-product">+ 新增商品</button></div></td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="pager">
          <span>每页 ${data.pageSize} 条</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-action="page" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span>${data.page} / ${data.totalPages}</span>
          <button class="btn btn-ghost btn-sm" data-action="page" data-page="${data.page + 1}" ${data.page >= data.totalPages ? 'disabled' : ''}>下一页</button>
        </div>
      </section>`;

    // 筛选事件
    let timer;
    $('#fq').addEventListener('input', (e) => {
      clearTimeout(timer);
      const v = e.target.value;
      timer = setTimeout(async () => {
        state.filters.q = v;
        state.filters.page = 1;
        await renderPool();
        const el = $('#fq');
        if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n); }
      }, 280);
    });
    const bind = (id, key, parse = (v) => v) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => { state.filters[key] = parse(el.type === 'checkbox' ? el.checked : el.value); state.filters.page = 1; renderPool(); });
    };
    bind('#fscene', 'scene'); bind('#fcat', 'category'); bind('#fverdict', 'verdict'); bind('#fcs', 'content_status'); bind('#fsort', 'sort'); bind('#frisk', 'risk');
  }

  /* ---------------- 详情抽屉 ---------------- */

  async function openDetail(id) {
    try {
      const { product } = await api('/api/products/' + id);
      state.detail = product;
      renderDetail(product);
      openDialog('detailDrawer');
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderDetail(p) {
    const profit = p.profit;
    $('#detailTitle').textContent = p.name;
    $('#detailSub').innerHTML = `${esc(p.category)} · ${p.scene === 'temu' ? 'Temu' : 'TikTok Shop'} · 更新于 ${esc(String(p.updated_at).slice(0, 10))}`;

    const breakdown = profit.breakdown.map((b) => `
      <tr><td>${esc(b.label)}${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}</td><td>${money(b.usd)}<span class="muted small"> · ${pct(b.pct)}</span></td></tr>`).join('');

    $('#detailBody').innerHTML = `
      <section class="score-hero">
        <div>
          <div class="score-big score ${p.verdict_key}">${p.scout_score}</div>
          <div class="muted small">综合分（满分 100）</div>
        </div>
        <div class="stack" style="gap:6px">
          <span class="pill ${p.verdict_key}">${esc(p.verdict)}</span>
          <span class="muted small">数据置信度 ${p.confidence}（${p.confidence_label}） · 快照 ${
            p.data_freshness_days === null ? '无' : p.data_freshness_days === 0 ? '今日' : p.data_freshness_days + ' 天前'
          }</span>
          <span class="muted small">趋势动量 ${p.trend_momentum_pct > 0 ? '+' : ''}${p.trend_momentum_pct}%（30 天）</span>
        </div>
      </section>

      <div class="verdict-box mb-18">
        <h4>决策依据</h4>
        <ul class="warn-list" style="color:var(--text-2);margin:0;padding-left:18px">
          ${p.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}
        </ul>
        <p class="small mt-8" style="color:var(--green)"><strong>建议动作：</strong>${esc(p.next_action)}</p>
      </div>

      <div class="section-title">评分拆解</div>
      ${p.factors.map(factorBar).join('')}
      ${p.penalties.length ? `<div class="small" style="color:#edc363;margin-top:6px">惩罚项：${p.penalties.map((x) => `${esc(x.label)} −${x.points}（${esc(x.note)}）`).join('；')}</div>` : ''}

      <div class="section-title">利润拆解（单件，美元）</div>
      <table class="breakdown">
        <tr><td>平台售价</td><td>${money(profit.sale_usd)}</td></tr>
        ${breakdown}
        <tr class="total"><td>单件净利</td><td style="color:${profit.net_profit_usd >= 0 ? 'var(--green)' : 'var(--red)'}">${money(profit.net_profit_usd)}</td></tr>
      </table>

      <div class="grid-3 mt-14">
        <div class="kpi" style="min-height:auto"><div class="label">毛利率</div><div class="val" style="font-size:18px">${pct(profit.margin_pct)}</div><div class="hint">按售价计算</div></div>
        <div class="kpi" style="min-height:auto"><div class="label">保本价</div><div class="val" style="font-size:18px">${money(profit.break_even_usd)}</div><div class="hint">低于此价即亏损</div></div>
        <div class="kpi" style="min-height:auto"><div class="label">可承受拿货价</div><div class="val" style="font-size:18px">¥${profit.max_cost_cny}</div><div class="hint">目标毛利 ${Math.round(profit.target_margin * 100)}%</div></div>
      </div>

      ${profit.warnings.length ? `<ul class="warn-list">${profit.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}

      <div class="section-title">近 30 天热度</div>
      ${trendChart(p.series, 540, 150)}

      <div class="section-title">商品参数</div>
      <div class="kv"><span class="k">拿货价 / 售价</span><span class="v">${cny(p.cost_cny)} / ${money(p.sale_usd)}</span></div>
      <div class="kv"><span class="k">重量 / 物流</span><span class="v">${p.weight_g}g · ${p.logistics === 'heavy' ? '重货' : '轻小件'}</span></div>
      <div class="kv"><span class="k">关税 / 目标毛利</span><span class="v">${pct(p.duty_rate === null ? profit.duty_rate * 100 : p.duty_rate * 100)} / ${pct(p.target_margin === null ? profit.target_margin * 100 : p.target_margin * 100)}</span></div>
      <div class="kv"><span class="k">竞争度 / 复购 / 差异化</span><span class="v">${p.competition} / ${p.repurchase} / ${p.differentiation}</span></div>
      <div class="kv"><span class="k">合规风险 / 复核</span><span class="v"><span class="pill ${p.compliance}">${({ low: '低', mid: '中', high: '高' })[p.compliance]}</span> ${p.compliance_reviewed ? '已复核' : '未复核'}</span></div>
      ${p.notes ? `<div class="kv"><span class="k">备注</span><span class="v">${esc(p.notes)}</span></div>` : ''}

      <div class="section-title">SPU · 内容生产（选品 → 素材 → 脚本 → 成片）</div>
      <div class="spu-block">
        <label class="field"><span>核心卖点（每行一条）</span><textarea class="control" id="sp_selling" rows="2" maxlength="1000">${esc(p.selling_points || '')}</textarea></label>
        <div class="grid-2">
          <label class="field"><span>目标人群</span><input class="control" id="sp_audience" maxlength="200" value="${esc(p.target_audience || '')}"></label>
          <label class="field"><span>使用场景</span><input class="control" id="sp_scenario" maxlength="500" value="${esc(p.scenario || '')}"></label>
        </div>
        <label class="field"><span>15 秒脚本</span><textarea class="control" id="sp_s15" rows="3" maxlength="8000">${esc(p.script_15s || '')}</textarea></label>
        <label class="field"><span>30 秒脚本</span><textarea class="control" id="sp_s30" rows="3" maxlength="8000">${esc(p.script_30s || '')}</textarea></label>
        <label class="field"><span>60 秒脚本</span><textarea class="control" id="sp_s60" rows="3" maxlength="8000">${esc(p.script_60s || '')}</textarea></label>
        <label class="field"><span>旁白 / voiceover</span><textarea class="control" id="sp_vo" rows="2" maxlength="8000">${esc(p.voiceover || '')}</textarea></label>
        <div class="grid-2">
          <label class="field"><span>内容状态</span>
            <select class="control" id="sp_status">
              ${['none','draft','reviewing','approved','delivered'].map((s) => `<option value="${s}" ${p.content_status === s ? 'selected' : ''}>${({none:'未开始',draft:'草稿',reviewing:'审核中',approved:'已通过',delivered:'已交付'})[s]}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>档位 / 订单状态</span>
            <input class="control" id="sp_tier" value="${esc((p.tier ? p.tier + 's' : '未设') + ' / ' + (p.order_status || 'none'))}" readonly>
          </label>
        </div>
        <div class="kv"><span class="k">素材引用</span><span class="v">${Array.isArray(p.material_refs) && p.material_refs.length ? p.material_refs.map((m) => esc((m && (m.name || m.url)) || '素材')).join('、') : '未上传'}</span></div>
        <div class="kv"><span class="k">成片任务</span><span class="v">kling: ${esc(p.kling_task_id || '-')} · heygen: ${esc(p.heygen_task_id || '-')}</span></div>
        <div class="kv"><span class="k">含成片后净利</span><span class="v" id="sp_net_incl"><span class="muted small">计算中…</span></span></div>
        <div class="section-subtitle" style="margin-top:14px">成片生成（可灵 / HeyGen）<span id="sp_video_status" class="muted small"></span></div>
        <div class="grid-2">
          <label class="field"><span>时长（秒）</span>
            <select class="control" id="sp_vduration">
              <option value="15">15 秒</option>
              <option value="30" selected>30 秒</option>
              <option value="60">60 秒</option>
            </select>
          </label>
          <label class="field"><span>成片供应商</span>
            <select class="control" id="sp_vprovider">
              <option value="kling">可灵 Kling</option>
              <option value="heygen">HeyGen</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn btn-primary btn-sm" id="sp_vgen" ${can('write_product') ? '' : 'disabled'}>生成成片并记账</button>
          <button class="btn btn-ghost btn-sm" id="sp_vstatus">刷新成片状态</button>
          <button class="btn btn-ghost btn-sm" id="sp_vcheck">配置自检</button>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-primary btn-sm" id="sp_save" ${can('write_product') ? '' : 'disabled'}>保存内容生产</button>
          <button class="btn btn-ghost btn-sm" id="sp_export">导出 SPU JSON</button>
          <label class="btn btn-ghost btn-sm" id="sp_import_label" ${can('write_product') ? '' : 'hidden'}>
            导入 SPU JSON
            <input type="file" id="sp_import" accept="application/json,.json" ${can('write_product') ? '' : 'disabled'} hidden>
          </label>
        </div>
        <div class="hint-box" style="margin-top:10px">导出 SPU JSON 可交给脚本/成片工具，或导入 profit / listing 等模块；保存后写入商品主数据，与选品、利润同源。<br>也可在上方「导入 SPU JSON」中选择 profit / listing 导出的 JSON，自动回填成本、素材引用等字段。</div>
      </div>
    `;
    $('#detailEdit').hidden = !can('write_product');
    $('#detailArchive').hidden = !can('write_product');
    $('#detailArchive').textContent = p.status === 'archived' ? '恢复' : '归档';
    bindSpv(p);
  }

  function bindSpv(p) {
    if (videoPollTimer) { clearTimeout(videoPollTimer); videoPollTimer = null; }
    const save = $('#sp_save');
    if (save) save.addEventListener('click', async () => {
      const body = {
        selling_points: $('#sp_selling').value,
        target_audience: $('#sp_audience').value,
        scenario: $('#sp_scenario').value,
        script_15s: $('#sp_s15').value,
        script_30s: $('#sp_s30').value,
        script_60s: $('#sp_s60').value,
        voiceover: $('#sp_vo').value,
        content_status: $('#sp_status').value
      };
      try {
        await api('/api/products/' + p.id + '/script', { method: 'PATCH', body });
        toast('内容生产已保存');
        state.detail = (await api('/api/products/' + p.id)).product;
      } catch (e) { toast(e.message, 'error'); }
    });
    const exp = $('#sp_export');
    if (exp) exp.addEventListener('click', () => download('/api/products/' + p.id + '/spu.json'));
    const imp = $('#sp_import');
    if (imp) imp.addEventListener('change', async () => {
      const file = imp.files && imp.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { throw new Error('JSON 解析失败：' + e.message); }
        const res = await api('/api/products/' + p.id + '/spu-import', { method: 'POST', body: { payload } });
        toast('已导入：' + (res.imported || []).join('、'), 'success');
        state.detail = (await api('/api/products/' + p.id)).product;
        renderDetail(state.detail);
      } catch (e) { toast(e.message, 'error'); }
      finally { imp.value = ''; }
    });

    // 成片工厂：供应商状态 + 生成 + 实时状态轮询 + 配置自检
    const vLabel = (name) => (name === 'kling' ? '可灵' : 'HeyGen');
    function setVStat(html) {
      const el = document.getElementById('sp_video_status');
      if (el) el.innerHTML = ' · ' + html;
    }
    async function loadVideoStatus() {
      try {
        const { providers } = await api('/api/video/providers');
        if (videoPollTimer) return; // 轮询进行中，避免覆盖进度提示
        setVStat(providers.map((x) => `${vLabel(x.name)}:${x.mode === 'live' ? '已配置' : '沙盒'}($${x.perSecondUsd}/s)`).join(' / '));
      } catch { /* 忽略状态展示错误 */ }
    }
    loadVideoStatus();

    // 轮询成片状态直到终态；每 3s 一次，最多 40 次（约 2 分钟）
    async function pollStatus(provider, tries = 0) {
      if (videoPollTimer) { clearTimeout(videoPollTimer); videoPollTimer = null; }
      const label = vLabel(provider);
      try {
        const { status } = await api('/api/products/' + p.id + '/video/' + provider + '/status');
        const st = status.status;
        if (st === 'none') { setVStat(`${label}：暂无任务`); return; }
        if (st === 'succeeded') {
          const seg = status.segments && status.segments > 1 ? `（${status.segments} 段已提交）` : '';
          setVStat(`<span class="text-ok">${label}：已完成${seg}${status.sandbox ? '·沙盒' : ''}</span>`);
          await loadNetIncl();
          return;
        }
        if (st === 'failed') { setVStat(`<span class="text-danger">${label}：生成失败，请检查脚本/素材或供应商额度</span>`); return; }
        if (st === 'unknown') { setVStat(`${label}：任务已存在，但未配置密钥无法查询`); return; }
        setVStat(`<span class="pill cs-reviewing">${label}：生成中…（${tries + 1}）</span>`);
        if (tries < 40) videoPollTimer = setTimeout(() => pollStatus(provider, tries + 1), 3000);
      } catch (e) {
        setVStat(`<span class="text-danger">${label}：状态查询失败 - ${esc(e.message)}</span>`);
      }
    }

    const vgen = $('#sp_vgen');
    if (vgen) vgen.addEventListener('click', async () => {
      const provider = $('#sp_vprovider').value;
      const duration = Number($('#sp_vduration').value);
      vgen.disabled = true;
      vgen.textContent = '提交中…';
      try {
        const r = await api('/api/products/' + p.id + '/video', { method: 'POST', body: { provider, duration } });
        const v = r.video;
        toast(`${vLabel(provider)} 成片已提交：task=${v.task_id}，记账 $${v.cost_usd}（${v.seconds}s）`, 'success');
        state.detail = (await api('/api/products/' + p.id)).product;
        renderDetail(state.detail);
        pollStatus(provider);
      } catch (e) { toast(e.message, 'error'); vgen.disabled = false; vgen.textContent = '生成成片并记账'; }
    });

    const vrefresh = $('#sp_vstatus');
    if (vrefresh) vrefresh.addEventListener('click', () => pollStatus($('#sp_vprovider').value));

    const vcheck = $('#sp_vcheck');
    if (vcheck) vcheck.addEventListener('click', async () => {
      try {
        const { providers } = await api('/api/video/selfcheck');
        const html = providers.map((x) => `${vLabel(x.name)}:${x.configured ? '真实(' + x.mode + ')' : '沙盒'}${x.maxSeconds ? '·单段≤' + x.maxSeconds + 's' : ''}`).join(' / ');
        setVStat(html);
        toast(providers.map((x) => x.note).join('\n'), 'info');
      } catch (e) { toast(e.message, 'error'); }
    });

    // 含成片后净利：拉取 SPU 视图（已扣减成本账本）并填充（每次查询最新 DOM，跨重渲染安全）
    async function loadNetIncl() {
      const el = document.getElementById('sp_net_incl');
      if (!el) return;
      try {
        const spv = await api('/api/products/' + p.id + '/spu');
        const usd = spv.net_profit_incl_cost_usd;
        const cny = spv.net_profit_incl_cost_cny;
        const neg = Number(usd) < 0;
        el.innerHTML = `<span class="${neg ? 'text-danger' : 'text-ok'}">$${usd} / ¥${cny}</span>`
          + (spv.total_cost_usd ? ` <span class="muted small">（已扣成片成本 $${spv.total_cost_usd}）</span>` : '');
      } catch { el.innerHTML = '<span class="muted small">—</span>'; }
    }
    loadNetIncl();
  }

  /* ---------------- 商品表单 ---------------- */

  function fillProductForm(p) {
    $('#productDialogTitle').textContent = p ? '编辑商品' : '新增商品';
    $('#productError').hidden = true;
    $('#p_id').value = p ? p.id : '';
    $('#p_name').value = p ? p.name : '';
    $('#p_sku').value = p ? (p.sku || '') : '';
    $('#p_category').value = p ? p.category : '';
    $('#p_scene').value = p ? p.scene : 'temu';
    $('#p_cost').value = p ? p.cost_cny : '';
    $('#p_sale').value = p ? p.sale_usd : '';
    $('#p_weight').value = p ? p.weight_g : 200;
    $('#p_duty').value = p && p.duty_rate !== null ? p.duty_rate : '';
    $('#p_target').value = p && p.target_margin !== null ? p.target_margin : '';
    $('#p_logistics').value = p ? p.logistics : 'light';
    $('#p_compliance').value = p ? p.compliance : 'low';
    $('#p_tags').value = p ? (p.tags || '') : '';
    $('#p_trend').value = p ? p.trend_score : 50;
    $('#p_competition').value = p ? p.competition : 50;
    $('#p_repurchase').value = p ? p.repurchase : 50;
    $('#p_diff').value = p ? p.differentiation : 30;
    $('#p_reviewed').checked = p ? !!p.compliance_reviewed : false;
    $('#p_notes').value = p ? (p.notes || '') : '';
    $('#productHint').textContent = p ? '修改后立即重算评分与利润' : '保存后立即重算评分';

    const cats = (state.pool?.facets?.categories || []).map((c) => c.value).filter(Boolean);
    $('#categoryList').innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }

  function readProductForm() {
    const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
    return {
      name: $('#p_name').value.trim(),
      sku: $('#p_sku').value.trim(),
      category: $('#p_category').value.trim(),
      scene: $('#p_scene').value,
      cost_cny: num('#p_cost'),
      sale_usd: num('#p_sale'),
      weight_g: num('#p_weight'),
      duty_rate: num('#p_duty'),
      target_margin: num('#p_target'),
      logistics: $('#p_logistics').value,
      compliance: $('#p_compliance').value,
      tags: $('#p_tags').value.trim(),
      trend_score: num('#p_trend'),
      competition: num('#p_competition'),
      repurchase: num('#p_repurchase'),
      differentiation: num('#p_diff'),
      compliance_reviewed: $('#p_reviewed').checked,
      notes: $('#p_notes').value.trim()
    };
  }

  async function submitProduct(e) {
    e.preventDefault();
    const id = $('#p_id').value;
    const body = readProductForm();
    const errEl = $('#productError');
    errEl.hidden = true;
    const btn = $('#productSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      if (id) await api('/api/products/' + id, { method: 'PATCH', body });
      else await api('/api/products', { method: 'POST', body });
      closeDialog('productDialog');
      toast(id ? '已保存并重算评分' : '商品已创建');
      await renderPool();
      await refreshBadge();
      if (state.detail && String(state.detail.id) === String(id)) openDetail(id);
    } catch (err) {
      errEl.textContent = err.details?.fields?.length
        ? err.details.fields.map((f) => f.message).join('；')
        : err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  /* ---------------- 导入 / 导出 ---------------- */

  async function submitImport() {
    const csv = $('#importText').value.trim() || $('#importFile').dataset.csv || '';
    const errEl = $('#importError');
    errEl.hidden = true;
    if (!csv) { errEl.textContent = '请选择文件或粘贴 CSV 内容'; errEl.hidden = false; return; }
    const btn = $('#importSubmit');
    btn.disabled = true; btn.textContent = '导入中…';
    try {
      const res = await api('/api/products/import', { method: 'POST', body: { csv } });
      $('#importResult').innerHTML = `<div class="hint-box">新增 <strong>${res.created}</strong> 条，更新 <strong>${res.updated}</strong> 条，失败 <strong>${res.failed}</strong> 条。${
        res.errors.length ? '<br>前几条错误：' + res.errors.map((e) => `第 ${e.row} 行：${esc(e.message)}`).join('；') : ''}</div>`;
      toast(`导入完成：新增 ${res.created}，更新 ${res.updated}`);
      await renderPool();
      await refreshBadge();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '开始导入';
    }
  }

  /* ---------------- 日报 ---------------- */

  async function renderReports() {
    let data;
    try { data = await api('/api/reports'); } catch (e) { $('#view').innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; return; }
    state.reports = data.reports;
    if (!state.reportDay || !data.reports.some((r) => r.day === state.reportDay)) {
      state.reportDay = data.reports[0]?.day || data.today;
    }
    await loadReport(state.reportDay);

    const selected = state.report;
    const list = data.reports.map((r) => `
      <button class="report-item" type="button" data-action="select-report" data-day="${esc(r.day)}" aria-current="${r.day === state.reportDay ? 'true' : 'false'}">
        <div class="day">${esc(r.day)}${r.day === data.today ? ' · 今日' : ''}</div>
        <div class="meta">${r.source === 'llm' ? 'LLM · ' + esc(r.model || '') : '规则引擎'}${r.cost_usd ? ' · $' + Number(r.cost_usd).toFixed(4) : ''}</div>
      </button>`).join('');

    $('#view').innerHTML = `
      <div class="report-layout">
        <section class="panel">
          <div class="panel-head"><h2>历史日报</h2><span class="sub">${data.reports.length} 份</span></div>
          <div class="report-list">${list || '<div class="empty small">还没有日报<br>点右上角生成</div>'}</div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>${selected ? esc(selected.day) + ' 选品日报' : '选品日报'}</h2>
              <div class="sub">${selected ? (selected.source === 'llm' ? 'LLM 撰写 · ' + esc(selected.model || '') + ' · prompt v' + esc(selected.prompt_version || '') : '规则引擎生成') : '尚未生成'}</div>
            </div>
            <span class="spacer" style="flex:1"></span>
            ${selected && can('export') ? `<button class="btn btn-ghost btn-sm" data-action="download-report" data-day="${esc(selected.day)}">下载 Markdown</button>` : ''}
            ${selected ? `<button class="btn btn-ghost btn-sm" data-action="copy-report">复制</button>` : ''}
          </div>
          <div class="panel-body markdown" id="reportBody">${selected ? mdToHtml(selected.content) : '<div class="empty"><h3>今天还没有日报</h3><p>点击右上角「生成日报」，无 LLM Key 时由规则引擎生成</p></div>'}</div>
        </section>
      </div>`;
  }

  async function loadReport(day) {
    try {
      const { report } = await api('/api/reports/' + encodeURIComponent(day));
      state.report = report;
      state.reportDay = day;
    } catch {
      state.report = null;
    }
  }

  async function generateReport() {
    if (state.busy) return;
    state.busy = true;
    const btn = $('#btnGenerate');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const res = await api('/api/reports/generate', { method: 'POST', body: { use_llm: true } });
      const r = res.report;
      toast(`日报已生成（${r.source === 'llm' ? 'LLM' : '规则引擎'}）` + (res.fallbackReason ? '：' + res.fallbackReason : ''), res.fallbackReason ? 'warn' : 'ok');
      state.reportDay = r.day;
      await refreshBadge();
      if (state.view === 'reports') await renderReports();
      else if (state.view === 'alerts') await renderAlerts();
    } catch (e) {
      toast('生成失败：' + e.message, 'error');
    } finally {
      state.busy = false;
      btn.disabled = false; btn.textContent = old;
    }
  }

  /* ---------------- 预警 ---------------- */

  async function renderAlerts() {
    let data;
    try { data = await api('/api/alerts?status=' + state.alertFilter + '&limit=100'); }
    catch (e) { $('#view').innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; return; }
    state.alerts = { list: data.alerts, summary: data.summary };
    const s = data.summary;

    $('#view').innerHTML = `
      <section class="kpis">
        <div class="kpi"><div class="label">未处理预警</div><div class="val">${s.open}</div><div class="hint">按严重程度排序</div></div>
        <div class="kpi"><div class="label">严重</div><div class="val" style="color:var(--red)">${s.critical}</div><div class="hint">亏损定价 / 合规高危</div></div>
        <div class="kpi"><div class="label">警告</div><div class="val" style="color:var(--amber)">${s.warn}</div><div class="hint">竞争红海 / 热度下滑</div></div>
        <div class="kpi"><div class="label">推送渠道</div><div class="val sm">${state.settings?.config?.alerts?.webhook?.enabled ? '已启用' : '未配置'}</div><div class="hint">企业微信 / 飞书 / Slack</div></div>
      </section>

      <section class="panel">
        <div class="toolbar">
          <div class="tabs" style="border:0;margin:0">
            <button type="button" data-action="alert-filter" data-status="open" aria-selected="${state.alertFilter === 'open'}">未处理</button>
            <button type="button" data-action="alert-filter" data-status="acked" aria-selected="${state.alertFilter === 'acked'}">已处理</button>
            <button type="button" data-action="alert-filter" data-status="all" aria-selected="${state.alertFilter === 'all'}">全部</button>
          </div>
          <span class="spacer" style="flex:1"></span>
          ${can('generate_report') ? '<button class="btn btn-ghost btn-sm" data-action="rescan">重新扫描</button>' : ''}
          ${can('manage_alerts') && s.open ? '<button class="btn btn-ghost btn-sm" data-action="ack-all">全部标记已处理</button>' : ''}
        </div>
        <div>
          ${data.alerts.map((a) => `
            <div class="alert-item">
              <span class="alert-dot ${a.level}"></span>
              <div class="body">
                <div class="title">${esc(a.product_name)} <span class="muted small">· ${esc(a.rule_label)}</span></div>
                <div class="msg">${esc(a.message)}</div>
                <div class="meta">${esc(a.day)} · ${a.status === 'acked' ? '已处理' : '待处理'}</div>
              </div>
              ${a.status === 'open' && can('manage_alerts') ? `<button class="btn btn-ghost btn-sm" data-action="ack" data-id="${a.id}">标记已处理</button>` : ''}
            </div>`).join('') || '<div class="empty"><h3>暂无预警</h3><p>规则会在生成日报或手动扫描时自动评估</p></div>'}
        </div>
      </section>`;
  }

  /* ---------------- 设置 ---------------- */

  function numInput(id, value, attrs = '') {
    return `<input class="control" id="${id}" type="number" value="${value}" ${attrs}>`;
  }
  function rateInput(id, value, label, hint) {
    return `<label class="field"><span>${label}</span><div class="row"><input class="control" id="${id}" type="number" min="0" max="100" step="0.5" value="${(Number(value) * 100).toFixed(1)}"><span class="muted small">%</span></div>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  }

  async function renderSettings() {
    let data;
    try {
      data = await api('/api/settings');
      state.settings = data;
    } catch (e) { $('#view').innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; return; }
    const cfg = data.config;
    if (can('manage_settings')) {
      try { state.audit = (await api('/api/audit?limit=50')).logs; } catch { state.audit = []; }
    }
    if (can('manage_users')) {
      try { state.users = (await api('/api/users')).users; } catch { state.users = []; }
    }
    if (can('manage_keys')) {
      try { state.keys = (await api('/api/keys')).keys; } catch { state.keys = []; }
    }

    const tabs = [
      ['cost', '成本与汇率'], ['scoring', '评分口径'], ['alerts', '预警与推送'],
      ['team', '团队与密钥'], ['data', '数据与审计'], ['account', '账户']
    ];

    $('#view').innerHTML = `
      <div class="tabs" role="tablist">
        ${tabs.map(([k, label]) => `<button type="button" role="tab" data-action="settings-tab" data-tab="${k}" aria-selected="${state.settingsTab === k}">${label}</button>`).join('')}
      </div>
      <div id="settingsPane"></div>`;

    const pane = $('#settingsPane');
    if (state.settingsTab === 'cost') {
      const fees = cfg.fees;
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>平台费用口径</h2><span class="sub">改一处，全站重算</span></div>
            <div class="panel-body">
              <div class="section-title">Temu</div>
              <div class="grid-2">
                ${rateInput('fee_temu_commission', fees.temu.commission, '佣金/供货折价')}
                ${rateInput('fee_temu_ad', fees.temu.ad, '投流占比')}
                ${rateInput('fee_temu_returns', fees.temu.returns, '退货售后损耗')}
                ${rateInput('fee_temu_payment', fees.temu.payment, '支付/提现费')}
              </div>
              <label class="field"><span>单件仓配履约（美元）</span>${numInput('fee_temu_fulfillment', fees.temu.fulfillment, 'min="0" step="0.01"')}</label>
              <div class="section-title">TikTok Shop</div>
              <div class="grid-2">
                ${rateInput('fee_tiktok_commission', fees.tiktok.commission, '佣金 + 达人佣金')}
                ${rateInput('fee_tiktok_ad', fees.tiktok.ad, '投流占比')}
                ${rateInput('fee_tiktok_returns', fees.tiktok.returns, '退货售后损耗')}
                ${rateInput('fee_tiktok_payment', fees.tiktok.payment, '支付/提现费')}
              </div>
              <label class="field"><span>单件仓配履约（美元）</span>${numInput('fee_tiktok_fulfillment', fees.tiktok.fulfillment, 'min="0" step="0.01"')}</label>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>物流、汇率与关税</h2></div>
            <div class="panel-body">
              <div class="grid-2">
                <label class="field"><span>物流方式</span>
                  <select class="control" id="logi_mode">
                    <option value="air" ${cfg.logistics.mode === 'air' ? 'selected' : ''}>空运直发</option>
                    <option value="sea" ${cfg.logistics.mode === 'sea' ? 'selected' : ''}>海运/海外仓</option>
                  </select></label>
                <label class="field"><span>汇率 USD/CNY</span>${numInput('fx_usdCny', cfg.fx.usdCny, 'min="1" max="20" step="0.01"')}</label>
                <label class="field"><span>空运单价（美元/kg）</span>${numInput('logi_air', cfg.logistics.airUsdPerKg, 'min="0" step="0.1"')}</label>
                <label class="field"><span>海运单价（美元/kg）</span>${numInput('logi_sea', cfg.logistics.seaUsdPerKg, 'min="0" step="0.1"')}</label>
                <label class="field"><span>包装成本（美元/件）</span>${numInput('logi_pack', cfg.logistics.packagingUsd, 'min="0" step="0.01"')}</label>
                <label class="field"><span>质检成本（美元/件）</span>${numInput('logi_qc', cfg.logistics.qcUsd, 'min="0" step="0.01"')}</label>
                <label class="field"><span>默认关税率（%）</span><div class="row"><input class="control" id="duty_rate" type="number" min="0" max="100" step="0.5" value="${(cfg.duty.defaultRate * 100).toFixed(1)}"><span class="muted small">%</span></div></label>
                <label class="field"><span>汇率缓冲（%）</span><div class="row"><input class="control" id="fx_buffer" type="number" min="0" max="20" step="0.5" value="${(cfg.fx.buffer * 100).toFixed(1)}"><span class="muted small">%</span></div></label>
                <label class="field"><span>免税额度（美元，多数市场已为 0）</span>${numInput('duty_min', cfg.duty.deMinimisUsd, 'min="0" step="1"')}</label>
                <label class="field"><span>目标毛利率（%）</span><div class="row"><input class="control" id="target_margin" type="number" min="1" max="95" step="1" value="${(cfg.scoring.profitTargetMargin * 100).toFixed(0)}"><span class="muted small">%</span></div></label>
              </div>
              <div class="section-title">2026 固定税费与履约模式</div>
              <div class="grid-2">
                <label class="field"><span>履约模式</span>
                  <select class="control" id="logi_ff_model">
                    <option value="direct" ${cfg.logistics.fulfillmentModel === 'local' ? '' : 'selected'}>直发 / 全托管供货</option>
                    <option value="local" ${cfg.logistics.fulfillmentModel === 'local' ? 'selected' : ''}>半托管 / 海外仓本地发货</option>
                  </select></label>
                <label class="field"><span>每件固定关税（美元）</span>${numInput('duty_per_item', cfg.duty.perItemDutyUsd, 'min="0" step="0.01"')}</label>
                <label class="field"><span>每票固定报关/清关费（美元）</span>${numInput('duty_customs', cfg.duty.customsPerOrderUsd, 'min="0" step="0.01"')}</label>
                <label class="field"><span>批量清关/入库分摊（美元/件）</span>${numInput('local_inbound', cfg.logistics.local.inboundUsdPerUnit, 'min="0" step="0.01"')}</label>
                <label class="field"><span>海外仓仓储分摊（美元/件）</span>${numInput('local_storage', cfg.logistics.local.storageUsdPerUnit, 'min="0" step="0.01"')}</label>
                <label class="field"><span>本地尾程派送（美元/件）</span>${numInput('local_lastmile', cfg.logistics.local.lastMileUsdPerUnit, 'min="0" step="0.01"')}</label>
                <label class="field"><span>滞销/退货损耗（%）</span><div class="row"><input class="control" id="local_deadstock" type="number" min="0" max="90" step="0.5" value="${((cfg.logistics.local.deadStockPct || 0) * 100).toFixed(1)}"><span class="muted small">%</span></div></label>
              </div>
              <div class="hint-box">口径说明：毛利率 = 单件净利 ÷ 售价。2025/8 美国取消 800 美元低值免税、2026/7 欧盟改按商品项征 €3 固定关税，<strong>每票固定税费与货值无关</strong>，低客单价商品必须单列，否则净利会被高估（欧盟 €3 按汇率折算填入「每件固定关税」）。Temu 全托管只拿供货价、不投流也不承担售后，故投流/退货默认为 0；切换半托管请同时把履约模式改为本地仓、并回填投流与退货费率。半托管需自担头程、仓储、尾程、滞销与退货，成本项由 2 项变 5 项。关税与免税政策按目的国/原产地实时变化，请以官方最新口径维护。</div>
            </div>
          </section>
        </div>
        <div class="row mt-14" style="margin-top:14px">
          <span class="muted small">${can('manage_settings') ? '保存后所有商品立即按新口径重算' : '只读成员无法修改配置'}</span>
          <span class="spacer" style="flex:1"></span>
          ${can('manage_settings') ? '<button class="btn btn-ghost" data-action="reset-config">恢复默认</button><button class="btn btn-primary" data-action="save-fees">保存成本口径</button>' : ''}
        </div>`;
    } else if (state.settingsTab === 'scoring') {
      const w = cfg.weights;
      const v = cfg.scoring.verdicts;
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>评分权重</h2><span class="sub">合计会自动归一化</span></div>
            <div class="panel-body">
              ${[['weight_trend', '趋势热度', w.trend], ['weight_profit', '利润空间', w.profit], ['weight_diff', '差异化空间', w.differentiation], ['weight_rep', '复购属性', w.repurchase]]
                .map(([id, label, val]) => `<label class="field"><span>${label} <strong id="${id}_val">${Math.round(val * 100)}%</strong></span>
                  <input id="${id}" type="range" min="0" max="100" step="1" value="${Math.round(val * 100)}"></label>`).join('')}
              <div class="hint-box">建议：趋势 35-45%、利润 20-30%、差异化 15-25%、复购 10-20%。竞争与合规以扣分形式体现，不占权重。</div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>结论阈值与惩罚</h2></div>
            <div class="panel-body">
              <div class="grid-2">
                <label class="field"><span>主推阈值</span>${numInput('verdict_main', v.main, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>测款阈值</span>${numInput('verdict_test', v.test, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>观察阈值</span>${numInput('verdict_watch', v.watch, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>竞争度起扣点</span>${numInput('comp_threshold', cfg.scoring.competitionThreshold, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>每分竞争扣分</span>${numInput('comp_penalty', cfg.scoring.competitionPenalty, 'min="0" max="2" step="0.05"')}</label>
                <label class="field"><span>合规扣分（低/中/高）</span>
                  <div class="row">
                    <input class="control" id="cp_low" type="number" min="0" max="30" value="${cfg.scoring.compliancePenalty.low}">
                    <input class="control" id="cp_mid" type="number" min="0" max="30" value="${cfg.scoring.compliancePenalty.mid}">
                    <input class="control" id="cp_high" type="number" min="0" max="30" value="${cfg.scoring.compliancePenalty.high}">
                  </div></label>
              </div>
              <div class="hint-box">高合规风险商品在「已完成合规复核」前，结论会被锁定为「合规待审」，避免误推。</div>
            </div>
          </section>
        </div>
        <div class="row" style="margin-top:14px">
          <span class="muted small">权重与阈值属于方法论，建议先回测再调整</span>
          <span class="spacer" style="flex:1"></span>
          ${can('manage_settings') ? '<button class="btn btn-primary" data-action="save-scoring">保存评分口径</button>' : ''}
        </div>`;
      ['weight_trend', 'weight_profit', 'weight_diff', 'weight_rep'].forEach((id) => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => { document.getElementById(id + '_val').textContent = el.value + '%'; });
      });
    } else if (state.settingsTab === 'alerts') {
      const a = cfg.alerts;
      const wh = a.webhook || { type: 'wecom', url: '', enabled: false };
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>预警规则</h2></div>
            <div class="panel-body">
              <div class="grid-2">
                <label class="field"><span>高分机会阈值</span>${numInput('alert_score', a.scoreThreshold, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>竞争红海阈值</span>${numInput('alert_comp', a.competitionHigh, 'min="0" max="100" step="1"')}</label>
                <label class="field"><span>热度下滑阈值（30 天 %）</span>${numInput('alert_trend', a.trendDropPct, 'min="0" max="100" step="1"')}</label>
                <label class="field check align-end"><input type="checkbox" id="alert_compliance" ${a.complianceHigh ? 'checked' : ''}><span>高合规风险未复核时预警</span></label>
              </div>
              <div class="hint-box">预警在「生成日报」或「重新扫描」时评估，按天去重，不会重复轰炸。</div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Webhook 推送</h2><span class="sub">企业微信 / 飞书 / Slack / Server酱</span></div>
            <div class="panel-body">
              <div class="grid-2">
                <label class="field"><span>渠道类型</span>
                  <select class="control" id="wh_type">
                    <option value="wecom" ${wh.type === 'wecom' ? 'selected' : ''}>企业微信机器人</option>
                    <option value="feishu" ${wh.type === 'feishu' ? 'selected' : ''}>飞书机器人</option>
                    <option value="slack" ${wh.type === 'slack' ? 'selected' : ''}>Slack Incoming Webhook</option>
                    <option value="serverchan" ${wh.type === 'serverchan' ? 'selected' : ''}>Server酱</option>
                    <option value="generic" ${wh.type === 'generic' ? 'selected' : ''}>通用 JSON</option>
                  </select></label>
                <label class="field check align-end"><input type="checkbox" id="wh_enabled" ${wh.enabled ? 'checked' : ''}><span>启用推送</span></label>
              </div>
              <label class="field"><span>Webhook 地址（https）</span><input class="control" id="wh_url" type="url" value="${esc(wh.url || '')}" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."></label>
              <div class="row">
                <button class="btn btn-ghost btn-sm" type="button" data-action="test-webhook">发送测试消息</button>
                <span class="muted small">生产环境会拦截内网地址，防止 SSRF</span>
              </div>
            </div>
          </section>
        </div>
        <div class="row" style="margin-top:14px">
          <span class="spacer" style="flex:1"></span>
          ${can('manage_settings') ? '<button class="btn btn-primary" data-action="save-alerts">保存预警配置</button>' : ''}
        </div>`;
    } else if (state.settingsTab === 'team') {
      const plan = data.plan;
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>团队成员</h2><span class="sub">${state.users.length} / ${plan.limits.seats} 席位</span></div>
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>成员</th><th>角色</th><th>状态</th><th>最近登录</th></tr></thead>
                <tbody>${state.users.map((u) => `
                  <tr>
                    <td><div class="name">${esc(u.name || u.email)}</div><div class="meta">${esc(u.email)}</div></td>
                    <td>${can('manage_users') && u.role !== 'owner'
                      ? `<select class="control" data-action="user-role" data-id="${u.id}" style="width:auto">${['admin', 'analyst', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${({ admin: '管理员', analyst: '分析员', viewer: '只读' })[r]}</option>`).join('')}</select>`
                      : `<span class="pill ghost">${({ owner: '所有者', admin: '管理员', analyst: '分析员', viewer: '只读' })[u.role]}</span>`}</td>
                    <td>${u.status === 'active' ? '<span class="pill low">正常</span>' : '<span class="pill high">已禁用</span>'}</td>
                    <td class="muted small">${esc(String(u.last_login_at || '-').slice(0, 16).replace('T', ' '))}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
            ${can('manage_users') ? `
            <div class="panel-body">
              <div class="section-title">新增成员</div>
              <form id="addUserForm">
                <div class="grid-2">
                  <label class="field"><span>邮箱</span><input class="control" id="nu_email" type="email" required></label>
                  <label class="field"><span>姓名</span><input class="control" id="nu_name" maxlength="40"></label>
                  <label class="field"><span>初始密码（≥10 位，含字母数字）</span><input class="control" id="nu_password" type="password" required></label>
                  <label class="field"><span>角色</span><select class="control" id="nu_role"><option value="viewer">只读</option><option value="analyst">分析员</option><option value="admin">管理员</option></select></label>
                </div>
                <button class="btn btn-primary btn-sm" type="submit">创建成员</button>
              </form>
            </div>` : ''}
          </section>

          <section class="panel">
            <div class="panel-head"><h2>API Key</h2><span class="sub">集成自有爬虫 / BI / Agent</span></div>
            <div class="panel-body">
              ${can('manage_keys') ? `
                <form id="addKeyForm" class="row" style="margin-bottom:12px">
                  <input class="control" id="nk_name" placeholder="用途，如 爬虫推送" maxlength="60" required>
                  <select class="control" id="nk_scopes" style="width:auto"><option value="read">只读</option><option value="write">读写</option></select>
                  <button class="btn btn-primary btn-sm" type="submit">创建</button>
                </form>` : '<div class="hint-box">只有所有者可以管理 API Key</div>'}
              ${state.keys.length ? `<table class="data"><thead><tr><th>名称</th><th>前缀</th><th>权限</th><th>最近使用</th><th></th></tr></thead><tbody>
                ${state.keys.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono small">${esc(k.prefix)}…</td><td>${k.scopes === 'write' ? '读写' : '只读'}</td><td class="muted small">${esc(String(k.last_used_at || '未使用').slice(0, 16).replace('T', ' '))}</td>
                  <td>${!k.revoked_at && can('manage_keys') ? `<button class="btn btn-ghost btn-sm" data-action="revoke-key" data-id="${k.id}">撤销</button>` : '<span class="muted small">已撤销</span>'}</td></tr>`).join('')}
                </tbody></table>` : '<div class="muted small">还没有 API Key</div>'}
              <div class="hint-box" style="margin-top:12px">推送热度示例：<code>POST /api/signals</code>，Body: <code>{"items":[{"sku":"CAR-MAG-01","trend_score":83,"price_usd":9.99}]}</code></div>
            </div>
          </section>
        </div>`;
      const addUser = $('#addUserForm');
      if (addUser) addUser.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/users', {
            method: 'POST',
            body: { email: $('#nu_email').value.trim(), name: $('#nu_name').value.trim(), password: $('#nu_password').value, role: $('#nu_role').value }
          });
          toast('成员已创建');
          renderSettings();
        } catch (err) { toast(err.message, 'error'); }
      });
      const addKey = $('#addKeyForm');
      if (addKey) addKey.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const { key } = await api('/api/keys', { method: 'POST', body: { name: $('#nk_name').value.trim(), scopes: $('#nk_scopes').value } });
          $('#keyValue').value = key.plain;
          openDialog('keyDialog');
          renderSettings();
        } catch (err) { toast(err.message, 'error'); }
      });
    } else if (state.settingsTab === 'data') {
      const integ = data.integrations;
      const prov = integ.providers || [];
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>数据源</h2><span class="sub">当前：${esc(integ.active)}</span></div>
            <div class="panel-body">
              ${prov.map((p) => `<div class="kv"><span class="k">${esc(p.name)}${p.requiresNetwork ? ' · 需外网' : ''}</span><span class="v muted small" style="max-width:60%">${esc(p.description)}</span></div>`).join('')}
              <div class="row" style="margin-top:12px">
                <button class="btn btn-ghost btn-sm" data-action="sync-trends">拉取 Google Trends 信号</button>
                <span class="muted small">${integ.state?.lastSyncAt ? '上次：' + esc(integ.state.lastSyncAt.slice(0, 16).replace('T', ' ')) : '尚未同步'}</span>
              </div>
              <div id="trendResult" class="small" style="margin-top:10px"></div>
              <div class="hint-box" style="margin-top:12px">商用请使用合规数据源（官方 API / 授权数据商 / 自有采集），并在页面上标注数据来源与更新时间，避免「估算值」被当成事实。</div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>套餐与用量</h2><span class="sub">${esc(data.plan.name)}</span></div>
            <div class="panel-body">
              <div class="kv"><span class="k">商品池</span><span class="v">${data.usage.products} / ${data.plan.limits.products}</span></div>
              <div class="kv"><span class="k">成员席位</span><span class="v">${data.usage.seats} / ${data.plan.limits.seats}</span></div>
              <div class="kv"><span class="k">本月 AI 日报</span><span class="v">${data.usage.llmReportsPerMonth} / ${data.plan.limits.llmReportsPerMonth}</span></div>
              <div class="kv"><span class="k">本月导出</span><span class="v">${data.usage.exportsPerMonth} / ${data.plan.limits.exportsPerMonth}</span></div>
              <div class="kv"><span class="k">API Key</span><span class="v">${data.usage.apiKeys} / ${data.plan.limits.apiKeys}</span></div>
              <div class="kv"><span class="k">本月 LLM 成本</span><span class="v">$${Number(data.usage_summary.totalCostUsd || 0).toFixed(4)}</span></div>
              ${can('manage_billing') ? `
                <div class="row" style="margin-top:12px">
                  <select class="control" id="planSelect" style="width:auto">${data.plans.map((p) => `<option value="${p.key}" ${p.key === data.plan.key ? 'selected' : ''}>${p.name}${p.priceCny ? ' · ¥' + p.priceCny + '/月' : ''}</option>`).join('')}</select>
                  <button class="btn btn-ghost btn-sm" data-action="change-plan">切换套餐（管理员）</button>
                </div>
                <div class="hint-box" style="margin-top:10px">未接入支付网关前，套餐由管理员在此手动调整；正式商用需接 Stripe/支付宝并做订阅状态校验。</div>` : ''}
            </div>
          </section>
        </div>

        <section class="panel" style="margin-top:16px">
          <div class="panel-head"><h2>操作审计</h2><span class="sub">最近 50 条</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>时间</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
            <tbody>${(state.audit || []).map((l) => `<tr><td class="muted small nowrap">${esc(String(l.created_at).slice(0, 19).replace('T', ' '))}</td><td>${esc(l.action)}</td><td class="small">${esc(l.target)}</td><td class="muted small">${esc(String(l.detail).slice(0, 80))}</td><td class="muted small">${esc(l.ip)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted small">暂无记录</td></tr>'}</tbody>
          </table></div>
        </section>`;
    } else {
      pane.innerHTML = `
        <div class="settings-grid">
          <section class="panel">
            <div class="panel-head"><h2>账户信息</h2></div>
            <div class="panel-body">
              <div class="kv"><span class="k">邮箱</span><span class="v">${esc(state.me.user.email)}</span></div>
              <div class="kv"><span class="k">角色</span><span class="v">${esc(state.me.user.role)}</span></div>
              <div class="kv"><span class="k">租户</span><span class="v">${esc(state.me.tenant.name)}</span></div>
              <div class="kv"><span class="k">时区</span><span class="v">Asia/Shanghai</span></div>
              <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="logout">退出登录</button>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>修改密码</h2><span class="sub">修改后需重新登录</span></div>
            <div class="panel-body">
              <form id="passwordForm">
                <label class="field"><span>原密码</span><input class="control" id="pw_old" type="password" autocomplete="current-password" required></label>
                <label class="field"><span>新密码（≥10 位，含字母数字）</span><input class="control" id="pw_new" type="password" autocomplete="new-password" required></label>
                <button class="btn btn-primary btn-sm" type="submit">更新密码</button>
              </form>
            </div>
          </section>
        </div>`;
      const form = $('#passwordForm');
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/auth/password', { method: 'PATCH', body: { old_password: $('#pw_old').value, new_password: $('#pw_new').value } });
          toast('密码已更新，请重新登录');
          setTimeout(() => location.replace('/'), 800);
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  }

  /* ---------------- 设置保存 ---------------- */

  function readRate(id) { return Number($(id).value) / 100; }

  async function saveFees() {
    const body = {
      fees: {
        temu: { commission: readRate('fee_temu_commission'), ad: readRate('fee_temu_ad'), returns: readRate('fee_temu_returns'), payment: readRate('fee_temu_payment'), fulfillment: Number($('fee_temu_fulfillment').value) },
        tiktok: { commission: readRate('fee_tiktok_commission'), ad: readRate('fee_tiktok_ad'), returns: readRate('fee_tiktok_returns'), payment: readRate('fee_tiktok_payment'), fulfillment: Number($('fee_tiktok_fulfillment').value) }
      },
      logistics: {
        mode: $('logi_mode').value,
        airUsdPerKg: Number($('logi_air').value),
        seaUsdPerKg: Number($('logi_sea').value),
        packagingUsd: Number($('logi_pack').value),
        qcUsd: Number($('logi_qc').value),
        fulfillmentModel: $('logi_ff_model').value,
        local: {
          inboundUsdPerUnit: Number($('local_inbound').value),
          storageUsdPerUnit: Number($('local_storage').value),
          lastMileUsdPerUnit: Number($('local_lastmile').value),
          deadStockPct: readRate('local_deadstock')
        }
      },
      fx: { usdCny: Number($('fx_usdCny').value), buffer: readRate('fx_buffer') },
      duty: {
        defaultRate: readRate('duty_rate'),
        deMinimisUsd: Number($('duty_min').value),
        perItemDutyUsd: Number($('duty_per_item').value),
        customsPerOrderUsd: Number($('duty_customs').value)
      },
      scoring: { profitTargetMargin: readRate('target_margin') }
    };
    await saveConfig(body, '成本口径已保存，全站已重算');
  }

  async function saveScoring() {
    const body = {
      weights: {
        trend: Number($('weight_trend').value) / 100,
        profit: Number($('weight_profit').value) / 100,
        differentiation: Number($('weight_diff').value) / 100,
        repurchase: Number($('weight_rep').value) / 100
      },
      scoring: {
        verdicts: { main: Number($('verdict_main').value), test: Number($('verdict_test').value), watch: Number($('verdict_watch').value) },
        competitionThreshold: Number($('comp_threshold').value),
        competitionPenalty: Number($('comp_penalty').value),
        compliancePenalty: { low: Number($('cp_low').value), mid: Number($('cp_mid').value), high: Number($('cp_high').value) }
      }
    };
    await saveConfig(body, '评分口径已保存');
  }

  async function saveAlerts() {
    const body = {
      alerts: {
        scoreThreshold: Number($('alert_score').value),
        competitionHigh: Number($('alert_comp').value),
        trendDropPct: Number($('alert_trend').value),
        complianceHigh: $('alert_compliance').checked,
        webhook: {
          type: $('wh_type').value,
          url: $('wh_url').value.trim(),
          enabled: $('wh_enabled').checked
        }
      }
    };
    await saveConfig(body, '预警配置已保存');
    await refreshBadge();
  }

  async function saveConfig(body, message) {
    try {
      await api('/api/settings/config', { method: 'PATCH', body });
      toast(message || '已保存');
      await renderSettings();
      await refreshBadge();
    } catch (e) {
      const fields = e.details?.fields?.map((f) => f.message).join('；');
      toast(fields || e.message, 'error');
    }
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener('click', async (e) => {
    const navBtn = e.target.closest('[data-view]');
    if (navBtn) { setView(navBtn.dataset.view); return; }

    const closer = e.target.closest('[data-close-dialog]');
    if (closer) { closeDialog(closer.dataset.closeDialog); return; }

    if (e.target.closest('#userChip')) {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* 忽略 */ }
      location.replace('/login');
      return;
    }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;

    try {
      if (action === 'detail') { await openDetail(Number(el.dataset.id)); return; }
      if (action === 'add-product') { fillProductForm(null); openDialog('productDialog'); return; }
      if (action === 'page') {
        state.filters.page = Math.max(1, Number(el.dataset.page));
        await renderPool();
        return;
      }
      if (action === 'select-report') { state.reportDay = el.dataset.day; await renderReports(); return; }
      if (action === 'download-report') { await download('/api/reports/' + encodeURIComponent(el.dataset.day) + '/markdown'); return; }
      if (action === 'copy-report') {
        await navigator.clipboard.writeText(state.report?.content || '');
        toast('日报已复制到剪贴板');
        return;
      }
      if (action === 'alert-filter') { state.alertFilter = el.dataset.status; await renderAlerts(); return; }
      if (action === 'ack') { await api('/api/alerts/' + el.dataset.id + '/ack', { method: 'POST', body: {} }); await renderAlerts(); await refreshBadge(); return; }
      if (action === 'ack-all') { await api('/api/alerts/ack-all', { method: 'POST', body: {} }); await renderAlerts(); await refreshBadge(); return; }
      if (action === 'rescan') {
        const res = await api('/api/alerts/rescan', { method: 'POST', body: {} });
        toast(`扫描完成，新增 ${res.created.length} 条预警`);
        await renderAlerts();
        await refreshBadge();
        return;
      }
      if (action === 'settings-tab') { state.settingsTab = el.dataset.tab; await renderSettings(); return; }
      if (action === 'save-fees') { await saveFees(); return; }
      if (action === 'save-scoring') { await saveScoring(); return; }
      if (action === 'save-alerts') { await saveAlerts(); return; }
      if (action === 'reset-config') {
        if (!(await confirmBox({ title: '恢复默认口径', text: '将清除本租户的所有自定义成本/权重/预警配置，恢复出厂默认。', okText: '恢复默认' }))) return;
        await api('/api/settings/config/reset', { method: 'POST', body: {} });
        toast('已恢复默认配置');
        await renderSettings();
        return;
      }
      if (action === 'test-webhook') {
        const url = $('wh_url').value.trim();
        if (!url) { toast('请先填写 Webhook 地址', 'warn'); return; }
        const res = await api('/api/settings/webhook/test', { method: 'POST', body: { url, type: $('wh_type').value } });
        toast(res.ok ? '测试消息已发送，请在群里确认' : '发送失败');
        return;
      }
      if (action === 'change-plan') {
        const plan = $('planSelect').value;
        if (!(await confirmBox({ title: '切换套餐', text: '这是管理员手动切换（不影响支付）。切换后配额立即生效。', okText: '切换', danger: false }))) return;
        await api('/api/plan', { method: 'POST', body: { plan } });
        toast('套餐已切换');
        await boot();
        return;
      }
      if (action === 'revoke-key') {
        if (!(await confirmBox({ title: '撤销 API Key', text: '撤销后使用该 Key 的脚本会立即失效。', okText: '撤销' }))) return;
        await api('/api/keys/' + el.dataset.id, { method: 'DELETE' });
        toast('已撤销');
        await renderSettings();
        return;
      }
      if (action === 'sync-trends') {
        el.disabled = true;
        try {
          const res = await api('/api/integrations/google-trends/sync', { method: 'POST', body: { geo: 'US', apply: false } });
          $('#trendResult').innerHTML = `<div class="hint-box">抓到 ${res.signals.length} 条公共趋势信号，匹配到 ${res.matches.length} 个商品（需在商品标签中填写英文关键词）。</div>`;
        } catch (err) {
          $('#trendResult').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
        } finally { el.disabled = false; }
        return;
      }
      if (action === 'logout') { await api('/api/auth/logout', { method: 'POST', body: {} }); location.replace('/login'); return; }
    } catch (err) {
      toast(err.message || '操作失败', 'error');
    }
  });

  document.addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-action="detail"]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(Number(row.dataset.id)); }
    if (e.key === 'Escape') $$('dialog[open]').forEach((d) => d.close());
  });

  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-action="user-role"]');
    if (!sel) return;
    try {
      await api('/api/users/' + sel.dataset.id, { method: 'PATCH', body: { role: sel.value } });
      toast('角色已更新');
    } catch (err) { toast(err.message, 'error'); await renderSettings(); }
  });

  $('#productForm').addEventListener('submit', submitProduct);

  $('#btnGenerate').addEventListener('click', generateReport);
  $('#btnAddProduct').addEventListener('click', () => { fillProductForm(null); openDialog('productDialog'); });
  $('#btnImport').addEventListener('click', () => {
    $('#importResult').innerHTML = '';
    $('#importError').hidden = true;
    openDialog('importDialog');
  });
  $('#btnExport').addEventListener('click', async () => {
    try { await download('/api/products/export.csv'); toast('导出已开始下载'); } catch (e) { toast(e.message, 'error'); }
  });
  $('#importSubmit').addEventListener('click', submitImport);
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#importText').value = String(reader.result || ''); };
    reader.readAsText(file, 'utf-8');
  });
  $('#detailEdit').addEventListener('click', () => {
    if (!state.detail) return;
    closeDialog('detailDrawer');
    fillProductForm(state.detail);
    openDialog('productDialog');
  });
  $('#detailArchive').addEventListener('click', async () => {
    const p = state.detail;
    if (!p) return;
    const archiving = p.status !== 'archived';
    const ok = await confirmBox({
      title: archiving ? '归档商品' : '恢复商品',
      text: archiving ? `归档后「${p.name}」不再计入评分与日报，可随时恢复。` : `恢复「${p.name}」到商品池。`,
      okText: archiving ? '归档' : '恢复'
    });
    if (!ok) return;
    try {
      if (archiving) await api('/api/products/' + p.id, { method: 'DELETE' });
      else await api('/api/products/' + p.id + '/restore', { method: 'POST', body: {} });
      closeDialog('detailDrawer');
      toast(archiving ? '已归档' : '已恢复');
      await renderPool();
      await refreshBadge();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#keyCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#keyValue').value);
    toast('已复制');
  });
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  });

  /* ---------------- 启动 ---------------- */

  async function boot() {
    try {
      state.me = await api('/api/auth/me');
    } catch {
      location.replace('/login');
      return;
    }
    renderShell();
    await refreshBadge();
    const hash = (location.hash || '').replace('#', '');
    if (hash.startsWith('product-')) {
      const id = Number(hash.slice('product-'.length));
      setView('pool');
      if (Number.isInteger(id) && id > 0) {
        history.replaceState(null, '', '#product-' + id);
        setTimeout(() => openDetail(id), 250);
      }
      return;
    }
    setView(VIEW_META[hash] ? hash : 'pool');
  }

  boot();
})();
