'use strict';
/**
 * 安全 Markdown 渲染（服务端报告由 LLM/规则生成，仍视为不可信输入）：
 *  1) 先整体 HTML 转义，再生成受控标签；
 *  2) 链接只允许 http(s)，其余按文本处理；
 *  3) 不使用 innerHTML 处理原始 HTML。
 * 同时导出到 window.KSMarkdown 与 module.exports，便于前端与单测共用。
 */
(function (global) {
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(text) {
    const codes = [];
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + codes[Number(n)] + '</code>');
    return s;
  }

  function render(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let listType = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
    const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };

    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); closeList(); i++;
        const buf = [];
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }

      let m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        flushPara(); closeList();
        const lvl = m[1].length;
        out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
        i++; continue;
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); i++; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) {
        flushPara(); closeList();
        out.push('<blockquote>' + inline(m[1]) + '</blockquote>');
        i++; continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inline(m[1]) + '</li>');
        i++; continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + inline(m[1]) + '</li>');
        i++; continue;
      }
      if (/^\s*\|/.test(line)) {
        flushPara(); closeList();
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (rows.length >= 2) {
          const head = cells(rows[0]);
          const body = rows.slice(2).map(cells);
          out.push('<table><thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
            body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        }
        continue;
      }
      para.push(line.trim());
      i++;
    }
    flushPara(); closeList();
    return out.join('\n');
  }

  const api = { render, inline, esc };
  global.KSMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
