#!/usr/bin/env python3
"""验收测试：覆盖需求中的全部验收点。

运行：python3 tests/acceptance.py
覆盖：
  1. 重复提交（有界幂等身份：重试不重复、同键不同内容 409、同邮箱多条不合并）
  2. 请求成功 ≠ 已展示（未审核不公开）
  3. 审核时内容变化（版本条件 409 + 站主见冲突）
  4. 修改后原批准失效（快照移除）
  5. 撤回后旧分页缓存（游标不复活、list_version/ETag 变化）
  6. 恶意链接与富文本（服务端转义 + CSP + 前端 textContent）
  7. 清理联系信息请求（明文删除、通知降级、站主见“已清除”）
  8. 公开 API 不返回邮箱
  9. 通知送达未知（不声称已送达；未明确选择则不发送）
 10. 申诉与重新批准的可见状态
 11. 空状态温和展示
 12. 鉴权（访客令牌、站主令牌）
 13. 收件箱模式（先进入仅站主可见收件箱）
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "test-owner-token"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), name, ("" if cond else "- " + str(detail)))


class Server:
    def __init__(self, port, mode):
        self.base = f"http://127.0.0.1:{port}"
        self.db = tempfile.mktemp(suffix=".db")
        env = dict(os.environ, OWNER_TOKEN=OWNER, WALL_MODE=mode)
        env.pop("WALL_SMTP_URL", None)
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "run.py"), "--port", str(port), "--db", self.db],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(60):
            try:
                self.req("GET", "/api/public/messages")
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def req(self, method, path, body=None, owner=False, token=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        r.add_header("Content-Type", "application/json")
        if owner:
            r.add_header("X-Owner-Token", OWNER)
        if token:
            r.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                payload = resp.read()
                return resp.status, dict(resp.headers), (payload if raw else json.loads(payload or b"{}"))
        except urllib.error.HTTPError as e:
            payload = e.read()
            if raw:
                return e.code, dict(e.headers), payload
            try:
                parsed = json.loads(payload or b"{}")
            except ValueError:
                parsed = {}
            return e.code, dict(e.headers), parsed

    def submit(self, content="你好", name="小访", rel="老朋友", email=None, notify=False, key=None):
        return self.req("POST", "/api/submissions", {
            "author_name": name, "relationship": rel, "content": content,
            "email": email, "notify_opt_in": notify,
            "idempotency_key": key or ("k-" + os.urandom(16).hex())})

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


S = None  # 主实例（先审后发模式）


def t_empty_state():
    st, hd, body = S.req("GET", "/", raw=True)
    text = body.decode()
    check("空状态温和展示", st == 200 and "墙上还空空的" in text)
    _, _, data = S.req("GET", "/api/public/messages")
    check("空状态 API 返回空列表", data.get("items") == [] and data.get("next_cursor") is None)


def t_submit_and_idempotency():
    key = "draft-" + os.urandom(8).hex()
    st1, _, r1 = S.submit(content="第一条", email="same@example.com", notify=True, key=key)
    st2, hd2, r2 = S.submit(content="第一条", email="same@example.com", notify=True, key=key)
    check("重复提交返回同一留言（有界幂等）",
          st1 == 201 and st2 == 200 and r1["submission_id"] == r2["submission_id"])
    check("重试可恢复管理令牌", r2.get("manage_token") == r1.get("manage_token"))
    check("响应明确请求成功≠已展示", "不代表已公开" in r1.get("note", ""))
    st3, _, r3 = S.submit(content="被改过的内容", email="same@example.com", notify=True, key=key)
    check("同幂等键不同内容被拒绝 409",
          st3 == 409 and r3["error"]["code"] == "IDEMPOTENCY_KEY_CONFLICT")
    st4, _, r4 = S.submit(content="同一个人的第二条", email="same@example.com", notify=True)
    check("同邮箱不同留言不被误合并", st4 == 201 and r4["submission_id"] != r1["submission_id"])
    _, _, pub = S.req("GET", "/api/public/messages")
    check("未审核不出现在公开墙", all(i["content"] != "第一条" for i in pub["items"]))


def t_version_conflict():
    _, _, r = S.submit(content="原始内容")
    sid, tok = r["submission_id"], r["manage_token"]
    st, _, e = S.req("POST", f"/api/submissions/{sid}/edits",
                     {"author_name": "小访", "relationship": "老朋友", "content": "修改后的内容"},
                     token=tok)
    check("访客编辑成功并升版本", st == 200 and e["current_version"] == 2)
    st, _, r2 = S.req("POST", f"/api/owner/submissions/{sid}/approve",
                      {"expected_version": 1}, owner=True)
    check("审核与编辑竞争触发版本条件 409",
          st == 409 and r2["error"]["code"] == "VERSION_CONFLICT"
          and r2["error"]["current_version"] == 2)
    _, _, q = S.req("GET", "/api/owner/queue", owner=True)
    item = next(i for i in q["items"] if i["id"] == sid)
    check("站主看到待处理冲突", item["has_conflict"] is True and item["current_version"] == 2)
    st, _, r3 = S.req("POST", f"/api/owner/submissions/{sid}/approve",
                      {"expected_version": 2}, owner=True)
    check("按新版本批准成功", st == 200 and r3["status"] == "approved")
    _, _, pub = S.req("GET", "/api/public/messages")
    check("公开墙显示修改后内容", any(i["content"] == "修改后的内容" for i in pub["items"]))


def t_edit_invalidates():
    _, _, r = S.submit(content="先批准我")
    sid, tok = r["submission_id"], r["manage_token"]
    S.req("POST", f"/api/owner/submissions/{sid}/approve", {"expected_version": 1}, owner=True)
    _, _, pub1 = S.req("GET", "/api/public/messages")
    check("批准后公开", any(i["content"] == "先批准我" for i in pub1["items"]))
    st, _, e = S.req("POST", f"/api/submissions/{sid}/edits",
                     {"author_name": "小访", "relationship": "老朋友", "content": "改过的"}, token=tok)
    check("修改后原批准失效", st == 200 and e["approval_invalidated"] is True)
    _, _, pub2 = S.req("GET", "/api/public/messages")
    check("修改后公开快照被移除", all(i["content"] not in ("先批准我", "改过的") for i in pub2["items"]))
    _, _, g = S.req("GET", f"/api/submissions/{sid}", token=tok)
    check("修改后回到待审核", g["status"] == "pending")


def t_withdraw_pagination():
    tag = os.urandom(4).hex()
    _, _, rv = S.submit(content=f"分页-{tag}-victim")
    S.req("POST", f"/api/owner/submissions/{rv['submission_id']}/approve",
          {"expected_version": 1}, owner=True)
    time.sleep(1.1)  # 保证后续 approved_at 严格更新，victim 不在首位
    for i in range(2):
        _, _, r = S.submit(content=f"分页-{tag}-{i}")
        S.req("POST", f"/api/owner/submissions/{r['submission_id']}/approve",
              {"expected_version": 1}, owner=True)
    _, h0, all0 = S.req("GET", "/api/public/messages?limit=50")
    items0 = all0["items"]
    vi = next(i for i, it in enumerate(items0) if it["content"] == f"分页-{tag}-victim")
    check("游标测试前置：victim 不在首位", vi > 0)
    before = items0[vi - 1]
    cursor = urllib.parse.quote(f"{before['approved_at']}|{before['id']}", safe="")
    _, _, page_before = S.req("GET", f"/api/public/messages?limit=1&cursor={cursor}")
    check("撤回前游标页首为 victim",
          page_before["items"] and page_before["items"][0]["content"].endswith("victim"))
    lv1, etag1 = all0["list_version"], h0.get("ETag")
    st, _, w = S.req("POST", f"/api/submissions/{rv['submission_id']}/withdraw", {},
                     token=rv["manage_token"])
    check("撤回成功且状态可见", st == 200 and w["status"] == "withdrawn")
    _, _, page_after = S.req("GET", f"/api/public/messages?limit=1&cursor={cursor}")
    check("撤回后旧游标页不再出现该留言",
          all(not i["content"].endswith("victim") for i in page_after["items"]))
    _, h2, all1 = S.req("GET", "/api/public/messages?limit=50")
    check("撤回后公开列表不含该留言",
          all(not i["content"].endswith("victim") for i in all1["items"]))
    check("撤回后列表版本与 ETag 已变化（缓存可校验）",
          all1["list_version"] > lv1 and h2.get("ETag") != etag1)
    _, _, g = S.req("GET", f"/api/submissions/{rv['submission_id']}", token=rv["manage_token"])
    check("作者看到已撤回状态", g["status"] == "withdrawn")


def t_xss_and_escaping():
    evil = ('<script>alert(1)</script><img src=x onerror=alert(1)> '
            'javascript:alert(1) <a href="https://evil.example">点我</a>')
    _, _, r = S.submit(content=evil, name="<b>小明</b>")
    S.req("POST", f"/api/owner/submissions/{r['submission_id']}/approve",
          {"expected_version": 1}, owner=True)
    st, hd, body = S.req("GET", "/", raw=True)
    text = body.decode()
    check("公开页转义脚本标签", "<script>alert(1)</script>" not in text and "&lt;script&gt;" in text)
    check("恶意标签未以 HTML 形式输出", "<img src=x" not in text and 'href="javascript:' not in text)
    check("响应带 CSP 头", "Content-Security-Policy" in hd and "script-src 'self'" in hd["Content-Security-Policy"])
    js = open(os.path.join(ROOT, "static", "wall.js"), encoding="utf-8").read()
    check("前端仅用 textContent 渲染（无 innerHTML）", ".innerHTML" not in js)
    _, _, pub = S.req("GET", "/api/public/messages?limit=50")
    item = next(i for i in pub["items"] if "alert(1)" in i["content"])
    check("API 返回 JSON 原文（由客户端以纯文本渲染）", item["content"] == evil)


def t_contact_cleanup():
    email = "notify.me@example.com"
    _, _, r = S.submit(content="带邮箱的留言", email=email, notify=True)
    sid, tok = r["submission_id"], r["manage_token"]
    _, _, q = S.req("GET", "/api/owner/queue", owner=True)
    item = next(i for i in q["items"] if i["id"] == sid)
    check("站主仅见脱敏联系信息",
          item["contact"]["present"] and item["contact"]["masked"] == "n***@example.com")
    check("站主 API 也不返回明文邮箱", email not in json.dumps(item, ensure_ascii=False))
    st, _, cl = S.req("POST", f"/api/submissions/{sid}/contact-cleanup", {}, token=tok)
    check("清理联系信息成功", st == 200 and cl["contact_cleared"])
    _, _, q2 = S.req("GET", "/api/owner/queue", owner=True)
    item2 = next(i for i in q2["items"] if i["id"] == sid)
    check("清理后站主看到已清除状态",
          not item2["contact"]["present"] and item2["contact"]["cleared_at"])
    S.req("POST", f"/api/owner/submissions/{sid}/approve", {"expected_version": 1}, owner=True)
    _, _, ns = S.req("GET", "/api/owner/notifications", owner=True)
    mine = [n for n in ns["items"] if n["submission_id"] == sid]
    check("清理后通知降级为无联系方式", mine and mine[0]["status"] == "skipped_no_contact")


def t_notification_delivery_unknown():
    _, _, r = S.submit(content="要通知我", email="delivery@example.com", notify=True)
    sid = r["submission_id"]
    S.req("POST", f"/api/owner/submissions/{sid}/approve", {"expected_version": 1}, owner=True)
    _, _, ns = S.req("GET", "/api/owner/notifications", owner=True)
    mine = [n for n in ns["items"] if n["submission_id"] == sid]
    check("通知送达状态为未知（未配置渠道）", mine and mine[0]["status"] == "channel_not_configured")
    check("通知文案不声称已送达", mine and "未知" in mine[0]["status_label"])
    _, _, g = S.req("GET", f"/api/submissions/{sid}", token=r["manage_token"])
    check("访客同样可见通知状态未知", g["notifications"] and "未知" in g["notifications"][0]["status_label"])
    _, _, r2 = S.submit(content="留了邮箱但没选通知", email="optout@example.com", notify=False)
    S.req("POST", f"/api/owner/submissions/{r2['submission_id']}/approve",
          {"expected_version": 1}, owner=True)
    _, _, ns2 = S.req("GET", "/api/owner/notifications", owner=True)
    mine2 = [n for n in ns2["items"] if n["submission_id"] == r2["submission_id"]]
    check("未明确选择则不发送通知", mine2 and mine2[0]["status"] == "skipped_opt_out")


def t_public_api_never_returns_email():
    email = "secret@example.com"
    _, _, r = S.submit(content="保密邮箱", email=email, notify=True)
    S.req("POST", f"/api/owner/submissions/{r['submission_id']}/approve",
          {"expected_version": 1}, owner=True)
    _, _, pub = S.req("GET", "/api/public/messages?limit=50")
    blob = json.dumps(pub, ensure_ascii=False)

    def keys(o, acc):
        if isinstance(o, dict):
            for k, v in o.items():
                acc.append(k)
                keys(v, acc)
        elif isinstance(o, list):
            for v in o:
                keys(v, acc)
        return acc

    check("公开 API 不含邮箱明文", email not in blob)
    check("公开 API 无任何 email 字段", not any("email" in k.lower() for k in keys(pub, [])))
    _, _, body = S.req("GET", "/", raw=True)
    check("公开页面不含邮箱", email not in body.decode())


def t_appeal_and_reapprove():
    _, _, r = S.submit(content="请再考虑一下")
    sid, tok = r["submission_id"], r["manage_token"]
    S.req("POST", f"/api/owner/submissions/{sid}/reject",
          {"expected_version": 1, "reason": "语气不合适"}, owner=True)
    _, _, g1 = S.req("GET", f"/api/submissions/{sid}", token=tok)
    check("未通过状态对作者可见", g1["status"] == "rejected")
    st, _, ap = S.req("POST", f"/api/submissions/{sid}/appeal", {}, token=tok)
    check("申诉成功且状态可见", st == 200 and ap["status"] == "appealed")
    _, _, q = S.req("GET", "/api/owner/queue", owner=True)
    item = next(i for i in q["items"] if i["id"] == sid)
    check("站主看到申诉状态", item["status"] == "appealed")
    st, _, rr = S.req("POST", f"/api/owner/submissions/{sid}/approve",
                      {"expected_version": 1}, owner=True)
    check("重新批准成功", st == 200 and rr["status"] == "approved")
    _, _, g2 = S.req("GET", f"/api/submissions/{sid}", token=tok)
    actions = [e["action"] for e in g2["events"]]
    check("事件流记录申诉与重新批准", "appeal" in actions and "reapprove" in actions)
    _, _, pub = S.req("GET", "/api/public/messages?limit=50")
    check("重新批准后公开", any(i["content"] == "请再考虑一下" for i in pub["items"]))


def t_auth_required():
    _, _, r = S.submit(content="需要令牌")
    sid = r["submission_id"]
    st, _, _ = S.req("GET", f"/api/submissions/{sid}")
    check("无管理令牌访问被拒 401", st == 401)
    st, _, _ = S.req("GET", f"/api/submissions/{sid}", token="wrong-token")
    check("错误管理令牌被拒 403", st == 403)
    st, _, _ = S.req("GET", "/api/owner/queue")
    check("站主接口需要令牌 401", st == 401)


def t_inbox_mode():
    """先进入仅站主可见收件箱的模式。"""
    srv = Server(8932, "inbox")
    try:
        st, _, r = srv.submit(content="收件箱模式留言")
        check("收件箱模式初始状态为 inbox", st == 201 and r["status"] == "inbox")
        _, _, pub = srv.req("GET", "/api/public/messages")
        check("收件箱内容不公开", pub["items"] == [])
        _, _, q = srv.req("GET", "/api/owner/queue", owner=True)
        check("站主收件箱可见", any(i["id"] == r["submission_id"] for i in q["items"]))
        st, _, a = srv.req("POST", f"/api/owner/submissions/{r['submission_id']}/approve",
                           {"expected_version": 1}, owner=True)
        check("站主公开后可见", st == 200 and a["status"] == "approved")
        _, _, pub2 = srv.req("GET", "/api/public/messages")
        check("公开后出现在公开墙", any(i["content"] == "收件箱模式留言" for i in pub2["items"]))
    finally:
        srv.stop()


def main():
    global S
    S = Server(8931, "pre_moderation")
    try:
        t_empty_state()
        t_submit_and_idempotency()
        t_version_conflict()
        t_edit_invalidates()
        t_withdraw_pagination()
        t_xss_and_escaping()
        t_contact_cleanup()
        t_notification_delivery_unknown()
        t_public_api_never_returns_email()
        t_appeal_and_reapprove()
        t_auth_required()
        t_inbox_mode()
    finally:
        S.stop()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
    if failed:
        print("未通过：", *failed, sep="\n  - ")
        sys.exit(1)


if __name__ == "__main__":
    main()
