/* 站主后台：待处理、冲突、各状态分组、通知记录。 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  let token = sessionStorage.getItem("gw_owner") || "";

  $("#saveToken").addEventListener("click", () => {
    token = $("#ownerToken").value.trim();
    sessionStorage.setItem("gw_owner", token);
    loadAll();
  });

  async function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "X-Owner-Token": token, "Content-Type": "application/json" }, opts.headers || {});
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error((data.error && data.error.message) || r.status);
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function card(item, actions) {
    const div = el("div", "card");
    const head = el("p", "card-head");
    head.append(el("strong", null, item.author_name), document.createTextNode(" · " + item.relationship));
    div.appendChild(head);
    div.appendChild(el("p", "content", item.content));
    div.appendChild(el("p", "meta",
      "状态：" + item.status_label + " · 版本 v" + item.current_version +
      " · 最近审核 v" + (item.last_reviewed_version || "—") +
      (item.has_conflict ? " · ⚠ 审核后内容已变化" : "")));
    const c = item.contact || {};
    div.appendChild(el("p", "meta", "联系信息：" +
      (c.present ? ("已留存（" + (c.masked || "***") + "）" + (item.notify_opt_in ? "，已订阅通知" : "，未订阅通知"))
                 : (c.cleared_at ? "已应请求清除" : "未留存"))));
    if (actions && actions.length) {
      const bar = el("div", "actions");
      actions.forEach((a) => {
        const b = el("button", null, a.label);
        b.addEventListener("click", () => a.fn(item));
        bar.appendChild(b);
      });
      div.appendChild(bar);
    }
    return div;
  }

  async function decide(item, action) {
    const body = { expected_version: item.current_version };
    if (action === "reject") body.reason = prompt("未通过原因（可选，作者可见）") || "";
    try {
      await api("/api/owner/submissions/" + item.id + "/" + action, { method: "POST", body: JSON.stringify(body) });
      await loadAll();
    } catch (e) {
      if (e.status === 409 && e.data && e.data.error && e.data.error.code === "VERSION_CONFLICT") {
        alert("内容在审核期间已变化，已刷新列表，请重新审阅。");
        await loadAll();
      } else if (e.status === 409) {
        alert("操作被拒绝：" + ((e.data.error && e.data.error.message) || e.message));
        await loadAll();
      } else {
        alert("操作失败：" + e.message);
      }
    }
  }

  function render(sel, list, actions) {
    const box = $(sel); box.textContent = "";
    list.forEach((i) => box.appendChild(card(i, actions)));
  }

  async function loadAll() {
    let q;
    try { q = await api("/api/owner/queue"); }
    catch (e) {
      $("#panel").hidden = true; $("#authBox").hidden = false;
      $("#authMsg").textContent = token ? "令牌无效或网络异常。" : "";
      return;
    }
    $("#authBox").hidden = true; $("#panel").hidden = false;
    const items = q.items;
    const approveLabel = q.mode === "inbox" ? "公开" : "批准";
    const pend = items.filter((i) => ["pending", "inbox", "appealed"].includes(i.status));
    const conflicts = items.filter((i) => i.has_conflict);
    const appr = items.filter((i) => i.status === "approved");
    const rej = items.filter((i) => ["rejected", "appealed"].includes(i.status));
    const wd = items.filter((i) => i.status === "withdrawn");
    render("#pendingList", pend, [
      { label: approveLabel, fn: (i) => decide(i, "approve") },
      { label: "不通过", fn: (i) => decide(i, "reject") },
    ]);
    $("#pendingEmpty").hidden = pend.length > 0;
    $("#pendingCount").textContent = pend.length ? "(" + pend.length + ")" : "";
    render("#conflictList", conflicts, [
      { label: "重新审阅并" + approveLabel, fn: (i) => decide(i, "approve") },
      { label: "不通过", fn: (i) => decide(i, "reject") },
    ]);
    $("#conflictEmpty").hidden = conflicts.length > 0;
    render("#approvedList", appr, [{ label: "下架（标记不通过）", fn: (i) => decide(i, "reject") }]);
    render("#rejectedList", rej, [{ label: "重新批准", fn: (i) => decide(i, "approve") }]);
    render("#withdrawnList", wd, []);
    const n = await api("/api/owner/notifications");
    const box = $("#notifList"); box.textContent = "";
    n.items.forEach((x) => {
      const div = el("div", "card");
      div.appendChild(el("p", "meta",
        x.created_at + " · " + (x.kind === "approved" ? "通过通知" : "未通过通知") + " · " + x.status_label));
      if (x.detail) div.appendChild(el("p", "meta", x.detail));
      box.appendChild(div);
    });
    $("#notifEmpty").hidden = n.items.length > 0;
  }

  if (token) { $("#ownerToken").value = token; loadAll(); }
})();
