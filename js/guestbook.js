'use strict';
/**
 * 公开留言墙客户端逻辑。
 * 安全约定：所有用户内容一律通过 textContent 渲染（输出转义），绝不拼接 innerHTML。
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const wallList = $('#wall-list');
  const loadMoreBtn = $('#load-more');
  const metaVersion = document.querySelector('meta[name="wall-version"]');
  let wallVersion = Number(metaVersion ? metaVersion.content : 0);

  // ---------- 公开墙 ----------
  function buildCard(item) {
    const article = document.createElement('article');
    article.className = 'wall-card glass';
    const p = document.createElement('p');
    p.className = 'wall-content';
    p.textContent = item.content; // 输出转义：纯文本节点，标签不会被执行
    const footer = document.createElement('footer');
    footer.className = 'wall-meta';
    const rel = document.createElement('span');
    rel.className = 'wall-relation';
    rel.textContent = item.relation;
    const time = document.createElement('time');
    time.dateTime = item.approved_at;
    time.textContent = item.approved_at.slice(0, 10);
    footer.append(rel, time);
    article.append(p, footer);
    return article;
  }

  loadMoreBtn.addEventListener('click', async () => {
    const cursor = wallList.dataset.nextCursor;
    if (!cursor) return;
    loadMoreBtn.disabled = true;
    try {
      const res = await fetch(`/api/wall?cursor=${encodeURIComponent(cursor)}&limit=10`, { cache: 'no-cache' });
      if (!res.ok) return;
      const data = await res.json();
      // 撤回/新增会使 wall_version 变化：旧分页缓存一律丢弃，整页刷新
      if (data.wall_version !== wallVersion) { location.reload(); return; }
      $('#wall-empty')?.remove();
      for (const item of data.items) wallList.appendChild(buildCard(item));
      wallList.dataset.nextCursor = data.next_cursor || '';
      loadMoreBtn.hidden = !data.next_cursor;
    } finally {
      loadMoreBtn.disabled = false;
    }
  });

  async function checkVersion() {
    try {
      const res = await fetch('/api/wall/version', { cache: 'no-store' });
      const data = await res.json();
      if (typeof data.wall_version === 'number' && data.wall_version !== wallVersion) location.reload();
    } catch { /* 离线时静默，下次再试 */ }
  }
  setInterval(checkVersion, 30000);
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkVersion(); }); // 拦截 bfcache 旧页面

  // ---------- 提交 / 修改 ----------
  const form = $('#submit-form');
  const statusEl = $('#form-status');
  const submitBtn = $('#submit-btn');
  const formTitle = $('#form-title');
  const editHint = $('#edit-hint');
  const cancelEditBtn = $('#cancel-edit');
  // 有界幂等身份：每份草稿一个随机键；提交成功后才换新键。
  // 网络重试复用同一键 => 服务端去重；不同留言是不同草稿 => 绝不误合并。
  let idemKey = crypto.randomUUID();
  let editing = null; // {id, baseVersion}

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }

  function exitEditMode() {
    editing = null;
    form.reset();
    formTitle.textContent = '写下你的寄语';
    submitBtn.textContent = '提交留言';
    editHint.hidden = true;
    cancelEditBtn.hidden = true;
  }

  cancelEditBtn.addEventListener('click', exitEditMode);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      content: String(fd.get('content') || ''),
      relation: String(fd.get('relation') || ''),
      notify_opt_in: fd.get('notify_opt_in') === 'on',
    };
    const email = String(fd.get('email') || '').trim();
    if (email) payload.email = email;

    submitBtn.disabled = true;
    setStatus(editing ? '正在保存修改…' : '正在提交…');
    try {
      let res;
      if (editing) {
        // 修改：携带 base_version 参与版本条件竞争
        res = await fetch(`/api/messages/${editing.id}/edit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Author-Token': getTokens()[editing.id] || '' },
          body: JSON.stringify({ ...payload, base_version: editing.baseVersion }),
        });
      } else {
        res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
          body: JSON.stringify(payload),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setStatus('内容在别处被更新过，请重新打开「修改」再试。', true);
        return;
      }
      if (!res.ok) {
        setStatus(`提交失败：${data.message || data.error || res.status}`, true);
        return;
      }
      if (!editing) {
        rememberToken(data.id, data.author_token);
        idemKey = crypto.randomUUID(); // 下一份草稿使用新的幂等键
        setStatus(data.status === 'inbox'
          ? '已送达站主的私密收件箱（仅站主可见）。'
          : '已提交，等待站主审核。');
      } else {
        setStatus('修改已保存，将重新进入审核流程。');
      }
      exitEditMode();
      loadMine();
    } catch {
      setStatus('网络异常，请重试 —— 重试是安全的，不会产生重复留言。', true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------- 我的留言（本机凭据） ----------
  const TOKENS_KEY = 'wall.authorTokens';
  const getTokens = () => { try { return JSON.parse(localStorage.getItem(TOKENS_KEY)) || {}; } catch { return {}; } };
  const rememberToken = (id, token) => {
    const t = getTokens(); t[id] = token;
    localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  };
  const STATUS_TEXT = {
    inbox: '已送达站主收件箱（仅站主可见）',
    pending: '等待站主审核',
    approved: '已公开展示',
    rejected: '未通过审核',
    appealed: '申诉已提交，等待复核',
    withdrawn: '已撤回',
  };

  async function postAction(id, action, body = {}) {
    const res = await fetch(`/api/messages/${id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Author-Token': getTokens()[id] || '' },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  function mineButton(text, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mine-btn';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  async function loadMine() {
    const tokens = getTokens();
    const ids = Object.keys(tokens);
    const list = $('#mine-list');
    list.textContent = '';
    $('#mine-empty').hidden = ids.length > 0;
    for (const id of ids) {
      let st;
      try {
        const res = await fetch(`/api/messages/${id}/status`, { headers: { 'X-Author-Token': tokens[id] } });
        if (!res.ok) continue;
        st = await res.json();
      } catch { continue; }
      const li = document.createElement('li');
      li.className = 'mine-item';
      const head = document.createElement('div');
      head.className = 'mine-head';
      const badge = document.createElement('span');
      badge.className = `mine-status st-${st.status}`;
      badge.textContent = STATUS_TEXT[st.status] || st.status;
      const snippet = document.createElement('span');
      snippet.className = 'mine-snippet';
      snippet.textContent = st.content.slice(0, 40);
      head.append(badge, snippet);
      const actions = document.createElement('div');
      actions.className = 'mine-actions';
      actions.appendChild(mineButton('修改', () => {
        editing = { id, baseVersion: st.version };
        form.content.value = st.content;
        form.relation.value = st.relation;
        if (form.notify_opt_in) form.notify_opt_in.checked = st.notify_opt_in;
        formTitle.textContent = '修改留言';
        submitBtn.textContent = '保存修改';
        editHint.hidden = false;
        cancelEditBtn.hidden = false;
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      if (st.status !== 'withdrawn') {
        actions.appendChild(mineButton('撤回', async () => {
          await postAction(id, 'withdraw');
          loadMine(); checkVersion();
        }));
      }
      if (st.status === 'rejected') {
        actions.appendChild(mineButton('申诉', async () => {
          const note = window.prompt('想对站主说的话（可选）：') || '';
          await postAction(id, 'appeal', { note });
          loadMine();
        }));
      }
      if (st.has_contact) {
        actions.appendChild(mineButton('删除我的联系方式', async () => {
          await postAction(id, 'erase-contact');
          loadMine();
        }));
      }
      li.append(head, actions);
      list.appendChild(li);
    }
  }

  loadMine();
})();
