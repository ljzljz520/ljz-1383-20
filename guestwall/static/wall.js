/* 公开墙 + 提交表单。
 * 渲染只使用 textContent（不拼接 HTML），用户内容不会变成标记。 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  }

  /* 有界幂等身份：每份草稿一个随机键，保存在 sessionStorage；
   * 网络重试复用同一键（服务端去重），提交成功后销毁。与邮箱无关。 */
  function draftKey() {
    let k = sessionStorage.getItem("gw_draft_key");
    if (!k) { k = "draft-" + uuid(); sessionStorage.setItem("gw_draft_key", k); }
    return k;
  }
  function resetDraftKey() { sessionStorage.removeItem("gw_draft_key"); }

  function tokens() { try { return JSON.parse(localStorage.getItem("gw_tokens") || "{}"); } catch (e) { return {}; } }
  function saveToken(id, tok) { const t = tokens(); t[id] = tok; localStorage.setItem("gw_tokens", JSON.stringify(t)); }

  const form = $("#submitForm");
  if (form) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = $("#submitBtn"), msg = $("#submitMsg");
      btn.disabled = true; msg.textContent = "";
      const payload = {
        author_name: $("#fName").value.trim(),
        relationship: $("#fRel").value.trim(),
        content: $("#fContent").value.trim(),
        email: $("#fEmail").value.trim() || null,
        notify_opt_in: $("#fNotify").checked,
        idempotency_key: draftKey(),
      };
      try {
        const r = await fetch("/api/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (r.ok) {
          saveToken(data.submission_id, data.manage_token);
          resetDraftKey();
          form.reset();
          /* 请求成功 ≠ 已展示 */
          msg.textContent = "已提交成功，正在等待站主审核；通过前不会出现在公开墙。可在「管理我的留言」查看状态。";
          msg.className = "ok";
        } else {
          msg.textContent = "提交失败：" + ((data.error && data.error.message) || r.status);
          msg.className = "err";
        }
      } catch (e) {
        msg.textContent = "网络异常，请重试（重试使用同一幂等键，不会产生重复留言）。";
        msg.className = "err";
      } finally { btn.disabled = false; }
    });
  }

  const moreBtn = $("#loadMore");
  if (moreBtn) {
    if (!moreBtn.dataset.cursor) moreBtn.hidden = true;
    moreBtn.addEventListener("click", async () => {
      const r = await fetch("/api/public/messages?limit=10&cursor=" + encodeURIComponent(moreBtn.dataset.cursor));
      const data = await r.json();
      renderItems(data.items);
      if (data.next_cursor) moreBtn.dataset.cursor = data.next_cursor;
      else moreBtn.hidden = true;
    });
  }

  function renderItems(items) {
    const wall = $("#wall");
    const empty = $("#emptyState");
    if (empty && items.length) empty.remove();
    for (const it of items) {
      const li = document.createElement("li"); li.className = "msg";
      const c = document.createElement("p"); c.className = "content"; c.textContent = it.content;
      const meta = document.createElement("p"); meta.className = "meta";
      const n = document.createElement("span"); n.className = "name"; n.textContent = it.author_name;
      const dot1 = document.createElement("span"); dot1.className = "dot"; dot1.textContent = "·";
      const rel = document.createElement("span"); rel.className = "rel"; rel.textContent = it.relationship;
      const dot2 = document.createElement("span"); dot2.className = "dot"; dot2.textContent = "·";
      const t = document.createElement("time"); t.textContent = it.approved_at;
      meta.append(n, dot1, rel, dot2, t);
      li.append(c, meta);
      wall.appendChild(li);
    }
  }
})();
