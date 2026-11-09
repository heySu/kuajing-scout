'use strict';
/** 登录页逻辑：已登录直接进工作台；演示模式提供只读入口。 */
(async function () {
  const $ = (s) => document.querySelector(s);
  const errorEl = $('#loginError');
  const btn = $('#loginBtn');
  const demoBtn = $('#demoBtn');
  const demoDivider = $('#demoDivider');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  try {
    const meta = await (await fetch('/api/meta')).json();
    $('#version').textContent = 'v' + meta.version;
    if (meta.demo_mode) {
      demoBtn.hidden = false;
      demoDivider.hidden = false;
    }
  } catch { /* 忽略：登录仍可用 */ }

  try {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (res.ok) { location.replace('/'); return; }
  } catch { /* 未登录 */ }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || !password) return showError('请填写邮箱与密码');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '登录失败');
      location.replace('/');
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    demoBtn.textContent = '进入演示…';
    try {
      const res = await fetch('/api/auth/demo', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '演示入口未开启');
      location.replace('/');
    } catch (err) {
      showError(err.message);
      demoBtn.disabled = false;
      demoBtn.textContent = '进入在线演示（只读）';
    }
  });
})();
