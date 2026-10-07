'use strict';
/**
 * 站主审核后台。
 * 原则：所有用户内容用 textContent 渲染；审核动作携带 expected_version；
 * 冲突（审核期间内容被修改）以醒目区块呈现；通知外发状态如实标注「送达未知」。
 */
(() => {
  const $ = (s) => document.querySelector(s);
  let token = sessionStorage.getItem('admin.token') || '';

  const loginBox = $('#login-box');
  const panel = $('#admin-panel');

  function showLogin(msg) {
    loginBox.hidden = false;
    panel.hidden = true;
    if (msg) $('#login-msg').textContent = msg;
  }
  function showPanel() {
    loginBox.hidden = true;
    panel.hidden = false;
  }

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('#token-input').value.trim();
    sessionStorage.setItem('admin.token', token);
    load();
  });

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('admin.token');
      showLogin('令牌无效，请重新输入。');
      throw new Error('unauthorized');
    }
    return res;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const ACTION_LABEL = { approve: '批准公开', reject: '拒绝', reapprove: '重新批准' };

  function renderItems(ul, items, actions, emptyEl) {
    ul.textContent = '';
    emptyEl.hidden = items.length > 0;
    for (const it of items) {
      const li = el('li', `admin-card glass${it.has_conflict ? ' has-conflict' : ''}`);
      const content = el('p', 'admin-content', it.content);
      const meta = el('p', 'admin-meta',
        `v${it.version} · ${it.relation} · 提交于 ${it.created_at.slice(0, 16).replace('T', ' ')}`
        + (it.notify_opt_in ? ' · 希望邮件通知' : ''));
      li.append(content, meta);
      if (it.has_conflict) {
        li.appendChild(el('p', 'conflict-flag', '⚠ 审核期间内容发生变化，请基于最新版本重新核对'));
      }
      const bar = el('div', 'admin-actions');
      for (const act of actions) {
        const b = el('button', `act-${act}`, ACTION_LABEL[act]);
        b.addEventListener('click', async () => {
          let note = '';
          if (act === 'reject') note = window.prompt('拒绝原因（可选，会记录到审核事件）：') || '';
          const res = await api(`/api/admin/messages/${it.id}/${act}`, {
            method: 'POST',
            body: JSON.stringify({ expected_version: it.version, note }),
          });
          if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            if (data.error === 'version_conflict') {
              window.alert('版本冲突：这条留言在审核期间被作者修改，已为你刷新最新内容。');
            }
          }
          load();
        });
        bar.appendChild(b);
      }
      li.appendChild(bar);
      ul.appendChild(li);
    }
  }

  const OUTBOX_STATUS = {
    queued: '排队中（尚未尝试发送）',
    unknown: '送达未知（已尝试发送，无法确认对方收到）',
    canceled: '已取消',
  };

  function renderOutbox(items, enabled) {
    const ul = $('#outbox-list');
    ul.textContent = '';
    $('#outbox-empty').hidden = items.length > 0;
    $('#notify-banner').textContent = enabled
      ? '通知已启用。注意：请求成功发出 ≠ 对方已收到，送达状态以「送达未知」如实呈现。'
      : '通知未启用（NOTIFY_ENABLED 未开启）：不会生成任何外发邮件。';
    for (const o of items) {
      const li = el('li', 'outbox-item');
      li.appendChild(el('span', '', `#${o.id} · 留言 ${o.message_id.slice(-6)} · ${OUTBOX_STATUS[o.status] || o.status} · 尝试 ${o.attempts} 次`));
      if (o.status === 'queued') {
        const b = el('button', 'mine-btn', '标记一次发送尝试');
        b.addEventListener('click', async () => {
          await api(`/api/admin/outbox/${o.id}/attempt`, { method: 'POST', body: '{}' });
          load();
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
  }

  async function load() {
    let data;
    try {
      const res = await api('/api/admin/overview');
      data = await res.json();
    } catch { return; }
    showPanel();
    $('#mode-banner').textContent = data.mode === 'inbox'
      ? '当前为「私密收件箱」模式：新留言仅你可见，批准后才会公开。'
      : '当前为「先审后发」模式：新留言进入审核队列，批准后公开。';
    renderItems($('#pending-list'), data.pending, ['approve', 'reject'], $('#pending-empty'));
    renderItems($('#inbox-list'), data.inbox, ['approve', 'reject'], $('#inbox-empty'));
    renderItems($('#appealed-list'), data.appealed, ['reapprove', 'reject'], $('#appealed-empty'));
    renderItems($('#conflict-list'), data.conflicts, [], $('#conflict-empty'));
    renderItems($('#approved-list'), data.approved, [], $('#approved-empty'));
    renderOutbox(data.outbox, data.notifications_enabled);
  }

  if (token) load(); else showLogin();
  $('#refresh-btn').addEventListener('click', load);
})();
