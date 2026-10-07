/* 访客管理页：查看状态时间线、修改、撤回、申诉、清除联系信息。 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  function tokens() { try { return JSON.parse(localStorage.getItem("gw_tokens") || "{}"); } catch (e) { return {}; } }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  async function api(path, token, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + token, "Content-Type": "application/json" }, opts.headers || {});
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error((data.error && data.error.message) || r.status); err.status = r.status; throw err; }
    return data;
  }

  const ACTION_LABELS = {
    submit: "提交", edit: "修改", approve: "批准", reapprove: "重新批准",
    reject: "未通过", appeal: "申诉", withdraw: "撤回",
    contact_cleanup: "清除联系信息", approve_conflict: "审核冲突（内容已变化）",
  };

  async function load() {
    const t = tokens(), ids = Object.keys(t);
    const list = $("#list"); list.textContent = "";
    $("#empty").hidden = ids.length > 0;
    for (const id of ids) {
      try { list.appendChild(renderCard(id, t[id], await api("/api/submissions/" + id, t[id]))); }
      catch (e) {
        const div = el("div", "card");
        div.appendChild(el("p", "meta", "无法读取留言 " + id + "：" + e.message));
        list.appendChild(div);
      }
    }
  }

  function renderCard(id, token, v) {
    const div = el("div", "card");
    const cur = (v.versions || [])[0] || {};
    div.appendChild(el("p", "content", cur.content || ""));
    div.appendChild(el("p", "meta", "状态：" + v.status_label + " · 版本 v" + v.current_version));
    const c = v.contact || {};
    div.appendChild(el("p", "meta", "联系信息：" +
      (c.present ? "已留存（用于通知）" : (c.cleared_at ? "已应请求清除" : "未留存")) +
      (c.notify_opt_in ? " · 已订阅通知" : "")));
    (v.notifications || []).forEach((n) => {
      div.appendChild(el("p", "meta", "通知（" + (n.kind === "approved" ? "通过" : "未通过") + "）：" + n.status_label));
    });
    const tl = el("ol", "timeline");
    (v.events || []).forEach((e) => {
      tl.appendChild(el("li", null, e.created_at + " · " + (ACTION_LABELS[e.action] || e.action) + (e.reason ? " · " + e.reason : "")));
    });
    div.appendChild(tl);
    const bar = el("div", "actions");
    const acts = v.available_actions || [];
    if (acts.includes("edit")) {
      const b = el("button", null, "修改内容");
      b.addEventListener("click", () => showEdit(div, id, token, cur));
      bar.appendChild(b);
    }
    if (acts.includes("appeal")) {
      const b = el("button", null, "申诉");
      b.addEventListener("click", async () => { await api("/api/submissions/" + id + "/appeal", token, { method: "POST", body: "{}" }); load(); });
      bar.appendChild(b);
    }
    if (acts.includes("withdraw")) {
      const b = el("button", null, "撤回");
      b.addEventListener("click", async () => {
        if (confirm("撤回后将从公开墙移除，确定？")) { await api("/api/submissions/" + id + "/withdraw", token, { method: "POST", body: "{}" }); load(); }
      });
      bar.appendChild(b);
    }
    if (acts.includes("contact_cleanup")) {
      const b = el("button", null, "清除联系信息");
      b.addEventListener("click", async () => {
        if (confirm("清除后无法再通过邮箱通知你，确定？")) { await api("/api/submissions/" + id + "/contact-cleanup", token, { method: "POST", body: "{}" }); load(); }
      });
      bar.appendChild(b);
    }
    div.appendChild(bar);
    return div;
  }

  function showEdit(div, id, token, cur) {
    if (div.querySelector(".editbox")) return;
    const form = el("div", "editbox");
    const name = el("input"); name.value = cur.author_name || "";
    const rel = el("input"); rel.value = cur.relationship || "";
    const ta = el("textarea"); ta.value = cur.content || "";
    const save = el("button", null, "保存修改（原批准将失效）");
    const msg = el("p", "hint");
    save.addEventListener("click", async () => {
      try {
        const r = await api("/api/submissions/" + id + "/edits", token, {
          method: "POST",
          body: JSON.stringify({ author_name: name.value, relationship: rel.value, content: ta.value }),
        });
        msg.textContent = r.note || "已保存";
        await load();
      } catch (e) { msg.textContent = "保存失败：" + e.message; }
    });
    form.append(el("p", "hint", "昵称"), name, el("p", "hint", "关系说明"), rel,
                el("p", "hint", "寄语"), ta, save, msg);
    div.appendChild(form);
  }

  load();
})();
