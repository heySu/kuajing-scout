'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../public/js/markdown');

test('HTML 与脚本被转义，不会产生可执行标签', () => {
  const html = render('# 标题\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('危险链接不会变成 a 标签', () => {
  const html = render('[点我](javascript:alert(1))');
  assert.ok(!html.includes('<a '));
  assert.ok(html.includes('javascript:alert(1)'));
});

test('正常链接只允许 http(s) 且带 rel=noopener', () => {
  const html = render('[官网](https://example.com/a?b=1&c=2)');
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('连续列表项被正确分组成一个列表', () => {
  const html = render('- a\n- b\n- c');
  assert.ok(html.startsWith('<ul>'));
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal((html.match(/<ul>/g) || []).length, 1);
});

test('标题、粗体、行内代码、引用、分隔线', () => {
  const html = render('## 小节\n\n**粗体** 与 `code`\n\n> 引用\n\n---');
  assert.ok(html.includes('<h2>小节</h2>'));
  assert.ok(html.includes('<strong>粗体</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<blockquote>引用</blockquote>'));
  assert.ok(html.includes('<hr>'));
});

test('表格渲染', () => {
  const html = render('| 商品 | 分数 |\n| --- | --- |\n| A | 80 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>商品</th>'));
  assert.ok(html.includes('<td>A</td>'));
});

test('未闭合代码块不会吞掉页面，仍做转义', () => {
  const html = render('```\n<b>x</b>');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('<pre><code>'));
});
